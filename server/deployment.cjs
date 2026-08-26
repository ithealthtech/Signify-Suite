"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const {
  SIGNATURE_FILE,
  verifyReleaseSignature,
} = require("./release-signature.cjs");
const { compareVersions } = require("./version.cjs");

const execFileAsync = promisify(execFile);

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function artifactFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? artifactFiles(absolute) : [absolute];
  });
}

function verifyArtifact(
  artifact,
  { releasePublicKey = "", requireSignature = false } = {},
) {
  const root = fs.realpathSync(artifact),
    manifestFile = path.join(root, "manifest.json"),
    checksumsFile = path.join(root, "checksums.txt");
  if (!fs.existsSync(manifestFile) || !fs.existsSync(checksumsFile))
    throw new Error(
      "Deployment artifact is missing its manifest or checksums.",
    );
  const releaseSignature = verifyReleaseSignature(root, releasePublicKey, {
      required: requireSignature,
    }),
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (!/^\d+\.\d+\.\d+/.test(String(manifest.version || "")))
    throw new Error("Deployment manifest version is invalid.");
  const entries = fs
    .readFileSync(checksumsFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64})  ([^\\]+)$/);
      if (!match) throw new Error(`Invalid deployment checksum entry: ${line}`);
      return { digest: match[1], relative: match[2] };
    });
  const inventory = new Set();
  for (const entry of entries) {
    if (inventory.has(entry.relative))
      throw new Error(`Duplicate deployment checksum entry: ${entry.relative}`);
    inventory.add(entry.relative);
    const file = path.resolve(root, entry.relative);
    if (file !== root && !file.startsWith(root + path.sep))
      throw new Error("Deployment checksum inventory contains an unsafe path.");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      throw new Error(`Deployment artifact is missing ${entry.relative}.`);
    if (sha256(file) !== entry.digest)
      throw new Error(`Deployment checksum mismatch: ${entry.relative}.`);
  }
  const unlisted = artifactFiles(root)
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .filter(
      (file) =>
        file !== "checksums.txt" &&
        file !== SIGNATURE_FILE &&
        !inventory.has(file),
    );
  if (unlisted.length)
    throw new Error(
      `Deployment artifact contains unlisted files: ${unlisted.join(", ")}`,
    );
  return {
    root,
    manifest,
    files: entries.length,
    releaseSignature,
  };
}

function consistentSnapshot(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function deploymentBackup(databasePath, backupDirectory) {
  if (!databasePath || !fs.existsSync(databasePath) || !backupDirectory)
    return null;
  fs.mkdirSync(backupDirectory, { recursive: true });
  const target = path.join(
    backupDirectory,
    `signify-creator-pre-deploy-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.db`,
  );
  consistentSnapshot(databasePath, target);
  return target;
}

function preflightDatabase({
  artifact,
  databasePath,
  openDatabase,
  snapshotDatabase = consistentSnapshot,
}) {
  if (!databasePath || !fs.existsSync(databasePath))
    return { status: "skipped", reason: "database_not_created" };
  const temporary = path.join(
    os.tmpdir(),
    `signify-deploy-preflight-${process.pid}-${Date.now()}.db`,
  );
  snapshotDatabase(databasePath, temporary);
  let db;
  try {
    const opener =
      openDatabase ||
      require(path.join(artifact, "server", "database.cjs")).openDatabase;
    db = opener(temporary);
    const integrity = db.prepare("PRAGMA integrity_check").get();
    if (integrity.integrity_check !== "ok")
      throw new Error("Migration preflight database integrity failed.");
    const applied = db
      .prepare("SELECT COUNT(*) count FROM schema_migrations")
      .get().count;
    return { status: "passed", migrations: applied };
  } finally {
    db?.close();
    fs.rmSync(temporary, { force: true, maxRetries: 5, retryDelay: 100 });
    for (const suffix of ["-wal", "-shm"])
      fs.rmSync(temporary + suffix, { force: true });
  }
}

function safeReleaseName(manifest) {
  const commit = /^[0-9a-f]{40}$/i.test(manifest.commit || "")
    ? manifest.commit.slice(0, 12)
    : "unknown";
  return `${manifest.version}-${commit}`.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function createLink(target, link) {
  fs.symlinkSync(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function deployArtifact({
  artifact,
  releasesDirectory,
  currentLink,
  databasePath,
  backupDirectory,
  backupDatabase = deploymentBackup,
  install = async () => {},
  restart,
  probe,
  openDatabase,
  snapshotDatabase,
  allowDowngrade = false,
  releasePublicKey = "",
  requireSignature = false,
}) {
  const verification = { releasePublicKey, requireSignature },
    verified = verifyArtifact(artifact, verification),
    preflight = preflightDatabase({
      artifact: verified.root,
      databasePath,
      openDatabase,
      snapshotDatabase,
    }),
    releases = path.resolve(releasesDirectory),
    current = path.resolve(currentLink),
    release = path.join(releases, safeReleaseName(verified.manifest));
  fs.mkdirSync(releases, { recursive: true });
  if (!fs.existsSync(release)) {
    const staging = `${release}.staging-${process.pid}`;
    fs.cpSync(verified.root, staging, { recursive: true, errorOnExist: true });
    fs.renameSync(staging, release);
  } else verifyArtifact(release, verification);
  await install(release, verified.manifest);
  const previousTarget = fs.existsSync(current)
    ? fs.realpathSync(current)
    : null;
  if (previousTarget) {
    const previous = verifyArtifact(previousTarget, verification);
    if (
      !allowDowngrade &&
      compareVersions(verified.manifest.version, previous.manifest.version) < 0
    ) {
      const error = new Error(
        `Refusing downgrade from ${previous.manifest.version} to ${verified.manifest.version}.`,
      );
      error.code = "DEPLOYMENT_DOWNGRADE_BLOCKED";
      throw error;
    }
  }
  if (previousTarget === fs.realpathSync(release))
    return {
      status: "unchanged",
      release,
      preflight,
      manifest: verified.manifest,
    };
  const candidateLink = `${current}.candidate-${process.pid}`,
    previousLink = `${current}.previous-${process.pid}`,
    safetyBackup = backupDatabase(databasePath, backupDirectory);
  fs.rmSync(candidateLink, { recursive: true, force: true });
  fs.rmSync(previousLink, { recursive: true, force: true });
  createLink(release, candidateLink);
  if (previousTarget) fs.renameSync(current, previousLink);
  fs.renameSync(candidateLink, current);
  try {
    await restart();
    await probe(verified.manifest);
    fs.rmSync(previousLink, { recursive: true, force: true });
    return {
      status: "activated",
      release,
      previous: previousTarget,
      safetyBackup,
      preflight,
      manifest: verified.manifest,
    };
  } catch (cause) {
    fs.rmSync(current, { recursive: true, force: true });
    if (previousTarget) {
      fs.renameSync(previousLink, current);
      try {
        await restart();
        await probe(null);
      } catch (rollbackCause) {
        const error = new Error(
          `Deployment and rollback health checks failed: ${cause.message}; rollback: ${rollbackCause.message}`,
        );
        error.code = "DEPLOYMENT_ROLLBACK_FAILED";
        throw error;
      }
    }
    const error = new Error(`Deployment was rolled back: ${cause.message}`);
    error.code = "DEPLOYMENT_ROLLED_BACK";
    throw error;
  } finally {
    fs.rmSync(candidateLink, { recursive: true, force: true });
  }
}

async function restartScript(file) {
  if (!path.isAbsolute(file))
    throw new Error("SIGNIFY_DEPLOY_RESTART_SCRIPT must be an absolute path.");
  await execFileAsync(file, [], { timeout: 60000, windowsHide: true });
}

async function installDependencies(release) {
  await execFileAsync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--ignore-scripts=false"],
    {
      cwd: release,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
}

async function readinessProbe(url, expectedVersion = null, attempts = 30) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      const body = response.ok ? await response.json() : null;
      if (
        body?.status === "ok" &&
        body?.database === "ready" &&
        (!expectedVersion || body.version === expectedVersion)
      )
        return body;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Application did not pass its readiness health gate.");
}

module.exports = {
  compareVersions,
  deployArtifact,
  consistentSnapshot,
  deploymentBackup,
  installDependencies,
  preflightDatabase,
  readinessProbe,
  restartScript,
  safeReleaseName,
  verifyArtifact,
};
