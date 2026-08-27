"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { createCredentialVault } = require("./credential-vault.cjs");
const { DatabaseSync } = require("node:sqlite");
const tar = require("tar");
const { verifyArtifact } = require("./deployment.cjs");
const {
  compareVersions,
  normalizeVersion,
  releaseAssets,
} = require("./version.cjs");

const BACKUP_PATTERN = /^signify-creator-(?:pre-restore-)?[\w.-]+\.db$/;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}

function renameWithRetry(source, destination, timeoutMs = 5000) {
  const startedAt = Date.now(),
    retryable = new Set(["EBUSY", "EACCES", "EPERM"]),
    waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      if (!retryable.has(error.code) || Date.now() - startedAt >= timeoutMs)
        throw error;
      Atomics.wait(waitBuffer, 0, 0, 100);
    }
  }
}

function assertManagedName(name) {
  if (
    !BACKUP_PATTERN.test(String(name || "")) ||
    path.basename(name) !== name
  ) {
    const error = new Error("Invalid managed backup name.");
    error.status = 400;
    error.code = "INVALID_BACKUP_NAME";
    throw error;
  }
  return name;
}

function backupMetadata(file) {
  const info = fs.statSync(file);
  return {
    name: path.basename(file),
    size: info.size,
    createdAt: info.birthtime.toISOString(),
    modifiedAt: info.mtime.toISOString(),
  };
}

function validateBackup(file, migrationsDirectory) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const error = new Error("Backup not found.");
    error.status = 404;
    error.code = "BACKUP_NOT_FOUND";
    throw error;
  }
  let candidate;
  try {
    candidate = new DatabaseSync(file, { readOnly: true });
    const integrity = candidate.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok")
      throw new Error("Integrity check failed.");
    const table = candidate
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    if (!table) throw new Error("Schema migration history is missing.");
    const known = new Set(
      fs
        .readdirSync(migrationsDirectory)
        .filter((name) => /^\d+.*\.sql$/.test(name)),
    );
    const unknown = candidate
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version)
      .filter((version) => !known.has(version));
    if (unknown.length)
      throw new Error(`Backup requires unknown migration ${unknown[0]}.`);
    return true;
  } catch (cause) {
    const error = new Error(`Backup validation failed: ${cause.message}`);
    error.status = 422;
    error.code = "INVALID_BACKUP";
    throw error;
  } finally {
    candidate?.close();
  }
}

function restoreMarker(backupPath) {
  return path.join(backupPath, ".pending-restore.json");
}

function applyPendingRestore(config) {
  if (config.databasePath === ":memory:") return null;
  const backupPath = ensureDirectory(path.resolve(config.backupPath));
  const marker = restoreMarker(backupPath);
  if (!fs.existsSync(marker)) return null;
  const pending = JSON.parse(fs.readFileSync(marker, "utf8"));
  const name = assertManagedName(pending.name);
  const source = path.join(backupPath, name);
  validateBackup(source, path.join(config.sourceRoot, "server", "migrations"));

  const databasePath = path.resolve(config.databasePath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const safety = path.join(
    backupPath,
    `signify-creator-pre-restore-${stamp()}.db`,
  );
  const staged = `${databasePath}.restore-${process.pid}`;
  const displaced = `${databasePath}.before-restore-${process.pid}`;
  if (fs.existsSync(databasePath))
    fs.copyFileSync(databasePath, safety, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  try {
    if (fs.existsSync(databasePath)) renameWithRetry(databasePath, displaced);
    renameWithRetry(staged, databasePath);
    for (const suffix of ["-wal", "-shm"])
      fs.rmSync(databasePath + suffix, { force: true });
    fs.rmSync(displaced, { force: true });
    fs.rmSync(marker);
    return { restored: name, safetyBackup: path.basename(safety) };
  } catch (error) {
    fs.rmSync(staged, { force: true });
    if (!fs.existsSync(databasePath) && fs.existsSync(displaced))
      renameWithRetry(displaced, databasePath);
    throw error;
  }
}

function updateStatusFile(backupPath) {
  return path.join(backupPath, ".update-status.json");
}

function writeUpdateStatus(backupPath, value) {
  const target = updateStatusFile(backupPath),
    temporary = `${target}.${process.pid}`;
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(temporary, target);
}

function readUpdateStatus(backupPath) {
  try {
    const value = JSON.parse(
      fs.readFileSync(updateStatusFile(backupPath), "utf8"),
    );
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.name === "SyntaxError") return null;
    throw error;
  }
}

function updateReadiness(config) {
  const updates = config.updates || {},
    required = {
      releasesDirectory: updates.releasesDirectory,
      currentLink: updates.currentLink,
      restartScript: updates.restartScript,
      healthUrl: updates.healthUrl,
      releasePublicKey: updates.releasePublicKey,
    },
    missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
  if (updates.requireSignature === false)
    missing.push("signed release enforcement");
  return {
    installSupported: missing.length === 0,
    missing,
  };
}

function archiveFilter(maximumBytes) {
  let entries = 0,
    extractedBytes = 0;
  return (name, entry) => {
    const normalized = path.posix.normalize(
      String(name || "").replaceAll("\\", "/"),
    );
    entries += 1;
    extractedBytes += Number(entry?.size || 0);
    if (
      !normalized ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.startsWith("/") ||
      /^[a-zA-Z]:\//.test(normalized) ||
      ["SymbolicLink", "Link"].includes(entry?.type) ||
      entries > 20000 ||
      extractedBytes > maximumBytes
    )
      throw Object.assign(
        new Error("The release archive contains an unsafe entry."),
        {
          status: 422,
          code: "UPDATE_ARCHIVE_UNSAFE",
        },
      );
    return true;
  };
}

function createApplicationOperations({
  config,
  db,
  fetchImpl = fetch,
  spawnImpl = spawn,
  extractImpl = (archive, directory, maximumBytes) =>
    tar.x({
      file: archive,
      cwd: directory,
      strict: true,
      preservePaths: false,
      filter: archiveFilter(maximumBytes),
    }),
  version,
}) {
  const backupPath = ensureDirectory(path.resolve(config.backupPath)),
    credentialVault = createCredentialVault(
      config.signature?.credentialEncryptionKey,
    );
  const migrationsDirectory = path.join(
    config.sourceRoot,
    "server",
    "migrations",
  );
  function managedFile(name) {
    return path.join(backupPath, assertManagedName(name));
  }
  function listBackups() {
    const pending = fs.existsSync(restoreMarker(backupPath))
      ? JSON.parse(fs.readFileSync(restoreMarker(backupPath), "utf8")).name
      : null;
    return fs
      .readdirSync(backupPath)
      .filter((name) => BACKUP_PATTERN.test(name))
      .map((name) => ({
        ...backupMetadata(managedFile(name)),
        pendingRestore: name === pending,
      }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  function createBackup() {
    const target = managedFile(`signify-creator-${stamp()}.db`);
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    validateBackup(target, migrationsDirectory);
    return backupMetadata(target);
  }
  function stageRestore(name) {
    const source = managedFile(name);
    validateBackup(source, migrationsDirectory);
    const marker = restoreMarker(backupPath),
      temporary = `${marker}.${process.pid}`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ name, requestedAt: new Date().toISOString() }),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    fs.renameSync(temporary, marker);
    return { name, restartRequired: true };
  }
  function cancelRestore() {
    fs.rmSync(restoreMarker(backupPath), { force: true });
  }
  function deleteBackup(name) {
    const file = managedFile(name);
    const pending = listBackups().find(
      (item) => item.name === name,
    )?.pendingRestore;
    if (pending) {
      const error = new Error(
        "Cancel the pending restore before deleting this backup.",
      );
      error.status = 409;
      error.code = "BACKUP_PENDING_RESTORE";
      throw error;
    }
    if (!fs.existsSync(file)) {
      const error = new Error("Backup not found.");
      error.status = 404;
      error.code = "BACKUP_NOT_FOUND";
      throw error;
    }
    fs.rmSync(file);
  }
  function githubToken() {
    const githubRow = db
        .prepare(
          "SELECT encrypted_credentials FROM application_integrations WHERE provider='github' AND status='connected'",
        )
        .get(),
      githubCredentials = githubRow?.encrypted_credentials
        ? credentialVault.decrypt("github", githubRow.encrypted_credentials)
        : null;
    return githubCredentials?.token || config.updateGithubToken;
  }
  async function fetchLatestRelease() {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.updateRepository)) {
      const error = new Error(
        "The update repository configuration is invalid.",
      );
      error.status = 503;
      error.code = "UPDATE_REPOSITORY_INVALID";
      throw error;
    }
    const token = githubToken();
    let response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${config.updateRepository}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Signify-Creator",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(10000),
        },
      );
    } catch {
      const error = new Error("The release channel could not be reached.");
      error.status = 502;
      error.code = "UPDATE_CHECK_FAILED";
      throw error;
    }
    if (!response.ok) {
      const authenticationFailure = [401, 403, 404].includes(response.status),
        error = new Error(
          authenticationFailure
            ? "The private release repository could not be accessed. Configure a read-only SIGNIFY_UPDATE_GITHUB_TOKEN."
            : "The release channel returned an unexpected response.",
        );
      error.status = authenticationFailure ? 503 : 502;
      error.code = authenticationFailure
        ? "UPDATE_REPOSITORY_UNAUTHORIZED"
        : "UPDATE_CHECK_FAILED";
      throw error;
    }
    const release = await response.json();
    try {
      normalizeVersion(release.tag_name);
    } catch {
      throw Object.assign(
        new Error(
          "The latest release does not use a valid vMAJOR.MINOR.PATCH tag.",
        ),
        { status: 502, code: "UPDATE_RELEASE_INVALID" },
      );
    }
    return { release, token };
  }
  let lastCheck = null,
    activeCheck = null;
  async function checkForUpdates() {
    if (activeCheck) return activeCheck;
    activeCheck = (async () => {
      try {
        const { release } = await fetchLatestRelease(),
          latestVersion = normalizeVersion(release.tag_name),
          expected = releaseAssets(latestVersion),
          assetNames = new Set(
            Array.isArray(release.assets)
              ? release.assets.map((asset) => String(asset.name || ""))
              : [],
          ),
          readiness = updateReadiness(config);
        lastCheck = {
          status: "checked",
          checkedAt: new Date().toISOString(),
          currentVersion: normalizeVersion(version),
          latestVersion,
          updateAvailable: compareVersions(version, latestVersion) < 0,
          publishedAt: release.published_at || null,
          releaseUrl: release.html_url || "",
          notes: String(release.body || "").slice(0, 4000),
          packageReady:
            assetNames.has(expected.archive) &&
            assetNames.has(expected.checksum),
          expectedPackage: expected.archive,
          ...readiness,
        };
        return lastCheck;
      } catch (error) {
        lastCheck = {
          status: "failed",
          checkedAt: new Date().toISOString(),
          currentVersion: normalizeVersion(version),
          error: error.message,
          code: error.code || "UPDATE_CHECK_FAILED",
          ...updateReadiness(config),
        };
        throw error;
      } finally {
        activeCheck = null;
      }
    })();
    return activeCheck;
  }
  function getUpdateStatus() {
    return {
      ...(lastCheck || {
        status: "not_checked",
        currentVersion: normalizeVersion(version),
        ...updateReadiness(config),
      }),
      installation: readUpdateStatus(backupPath),
    };
  }
  function startUpdateMonitor(intervalMs = config.updates?.checkIntervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return { stop() {} };
    let stopped = false,
      timer;
    const run = async () => {
      if (stopped) return;
      try {
        await checkForUpdates();
      } catch {}
      if (!stopped) {
        timer = setTimeout(run, intervalMs);
        timer.unref();
      }
    };
    timer = setTimeout(run, Math.min(30000, intervalMs));
    timer.unref();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }
  async function downloadAsset(asset, token, maximumBytes) {
    let response;
    try {
      response = await fetchImpl(asset.url, {
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "Signify-Creator",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      throw Object.assign(
        new Error("The release package could not be downloaded."),
        {
          status: 502,
          code: "UPDATE_DOWNLOAD_FAILED",
        },
      );
    }
    const declared = Number(response.headers?.get?.("content-length") || 0);
    if (!response.ok || (declared && declared > maximumBytes))
      throw Object.assign(
        new Error(
          declared > maximumBytes
            ? "The release package exceeds the configured size limit."
            : "The release package could not be downloaded.",
        ),
        {
          status: declared > maximumBytes ? 413 : 502,
          code:
            declared > maximumBytes
              ? "UPDATE_PACKAGE_TOO_LARGE"
              : "UPDATE_DOWNLOAD_FAILED",
        },
      );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes)
      throw Object.assign(
        new Error("The release package exceeds the configured size limit."),
        { status: 413, code: "UPDATE_PACKAGE_TOO_LARGE" },
      );
    return bytes;
  }
  async function installUpdate() {
    const readiness = updateReadiness(config);
    if (!readiness.installSupported)
      throw Object.assign(
        new Error(
          `Managed updates are not configured. Missing: ${readiness.missing.join(", ")}.`,
        ),
        { status: 503, code: "UPDATE_INSTALL_UNAVAILABLE" },
      );
    const currentInstallation = readUpdateStatus(backupPath);
    if (
      ["preparing", "scheduled", "installing"].includes(
        currentInstallation?.status,
      )
    )
      throw Object.assign(
        new Error("An application update is already in progress."),
        {
          status: 409,
          code: "UPDATE_ALREADY_RUNNING",
        },
      );
    const { release, token } = await fetchLatestRelease(),
      latestVersion = normalizeVersion(release.tag_name);
    if (compareVersions(version, latestVersion) >= 0)
      throw Object.assign(
        new Error("No newer application release is available."),
        {
          status: 409,
          code: "UPDATE_NOT_AVAILABLE",
        },
      );
    const expected = releaseAssets(latestVersion),
      assets = new Map(
        (release.assets || []).map((asset) => [
          String(asset.name || ""),
          asset,
        ]),
      ),
      archiveAsset = assets.get(expected.archive),
      checksumAsset = assets.get(expected.checksum);
    if (!archiveAsset || !checksumAsset)
      throw Object.assign(
        new Error(
          `Release ${release.tag_name} is missing its signed production package.`,
        ),
        { status: 502, code: "UPDATE_PACKAGE_MISSING" },
      );
    const stagingRoot = path.join(
        backupPath,
        "update-staging",
        `${latestVersion}-${randomUUID()}`,
      ),
      artifact = path.join(stagingRoot, "artifact"),
      archive = path.join(stagingRoot, expected.archive);
    fs.mkdirSync(artifact, { recursive: true });
    writeUpdateStatus(backupPath, {
      status: "preparing",
      version: latestVersion,
    });
    try {
      const [archiveBytes, checksumBytes] = await Promise.all([
          downloadAsset(
            archiveAsset,
            token,
            config.updates.maxArchiveBytes || 250 * 1024 * 1024,
          ),
          downloadAsset(checksumAsset, token, 1024 * 1024),
        ]),
        expectedDigest = String(checksumBytes)
          .trim()
          .match(/^([0-9a-f]{64})\s+(.+)$/i);
      if (
        !expectedDigest ||
        path.basename(expectedDigest[2]) !== expected.archive
      )
        throw Object.assign(
          new Error("The release checksum file is invalid."),
          {
            status: 422,
            code: "UPDATE_CHECKSUM_INVALID",
          },
        );
      const actualDigest = createHash("sha256")
        .update(archiveBytes)
        .digest("hex");
      if (actualDigest !== expectedDigest[1].toLowerCase())
        throw Object.assign(
          new Error("The release package checksum does not match."),
          {
            status: 422,
            code: "UPDATE_CHECKSUM_MISMATCH",
          },
        );
      fs.writeFileSync(archive, archiveBytes, { mode: 0o600, flag: "wx" });
      await extractImpl(
        archive,
        artifact,
        (config.updates.maxArchiveBytes || 250 * 1024 * 1024) * 4,
      );
      const verified = verifyArtifact(artifact, {
        releasePublicKey: config.updates.releasePublicKey,
        requireSignature: true,
      });
      if (normalizeVersion(verified.manifest.version) !== latestVersion)
        throw Object.assign(
          new Error(
            "The release package version does not match the GitHub release.",
          ),
          { status: 422, code: "UPDATE_VERSION_MISMATCH" },
        );
      writeUpdateStatus(backupPath, {
        status: "scheduled",
        version: latestVersion,
      });
      const envFile = path.join(config.sourceRoot, ".env.local"),
        child = spawnImpl(
          process.execPath,
          [
            ...(fs.existsSync(envFile)
              ? [`--env-file-if-exists=${envFile}`]
              : []),
            path.join(config.sourceRoot, "scripts", "install-update.cjs"),
            artifact,
          ],
          {
            cwd: config.sourceRoot,
            detached: true,
            env: process.env,
            stdio: "ignore",
            windowsHide: true,
          },
        );
      child.once?.("error", (error) =>
        writeUpdateStatus(backupPath, {
          status: "failed",
          version: latestVersion,
          error: error.message,
        }),
      );
      child.unref?.();
      return { status: "scheduled", version: latestVersion };
    } catch (error) {
      writeUpdateStatus(backupPath, {
        status: "failed",
        version: latestVersion,
        error: error.message,
      });
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    backupPath,
    listBackups,
    createBackup,
    stageRestore,
    cancelRestore,
    deleteBackup,
    managedFile,
    checkForUpdates,
    getUpdateStatus,
    installUpdate,
    startUpdateMonitor,
  };
}

module.exports = {
  applyPendingRestore,
  createApplicationOperations,
  readUpdateStatus,
  updateReadiness,
  validateBackup,
  writeUpdateStatus,
};
