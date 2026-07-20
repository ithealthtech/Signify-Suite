"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

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

function compareVersions(left, right) {
  const parse = (value) =>
    String(value || "0")
      .replace(/^v/, "")
      .split(".")
      .map(Number);
  const a = parse(left),
    b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0))
      return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

function createApplicationOperations({
  config,
  db,
  fetchImpl = fetch,
  version,
}) {
  const backupPath = ensureDirectory(path.resolve(config.backupPath));
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
  async function checkForUpdates() {
    if (!/^[\w.-]+\/[\w.-]+$/.test(config.updateRepository)) {
      const error = new Error(
        "The update repository configuration is invalid.",
      );
      error.status = 503;
      error.code = "UPDATE_REPOSITORY_INVALID";
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${config.updateRepository}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Signify-Creator",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(config.updateGithubToken
              ? { Authorization: `Bearer ${config.updateGithubToken}` }
              : {}),
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
      const error = new Error("The release channel could not be reached.");
      error.status = 502;
      error.code = "UPDATE_CHECK_FAILED";
      throw error;
    }
    const release = await response.json();
    return {
      currentVersion: version,
      latestVersion: String(release.tag_name || "").replace(/^v/, ""),
      updateAvailable: compareVersions(version, release.tag_name) < 0,
      publishedAt: release.published_at || null,
      releaseUrl: release.html_url || "",
      notes: String(release.body || "").slice(0, 4000),
    };
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
  };
}

module.exports = {
  applyPendingRestore,
  createApplicationOperations,
  validateBackup,
};
