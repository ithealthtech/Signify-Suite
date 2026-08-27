"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createHash, generateKeyPairSync } = require("node:crypto");
const { openDatabase } = require("../server/database.cjs");
const { signRelease } = require("../server/release-signature.cjs");
const {
  applyPendingRestore,
  createApplicationOperations,
} = require("../server/application-operations.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-operations-"));
  const config = {
    sourceRoot: path.join(__dirname, ".."),
    databasePath: path.join(root, "data", "signify.db"),
    backupPath: path.join(root, "backups"),
    updateRepository: "ithealthtech/Signify-Suite",
    updateGithubToken: "sandbox-release-token",
  };
  let releaseRequest;
  let db = openDatabase(config.databasePath);
  db.exec(
    "CREATE TABLE recovery_probe(value TEXT NOT NULL); INSERT INTO recovery_probe VALUES ('before');",
  );
  const operations = createApplicationOperations({
    config,
    db,
    version: "0.4.0",
    fetchImpl: async (url, options) => {
      releaseRequest = { url, options };
      return {
        ok: true,
        json: async () => ({
          tag_name: "v0.5.0",
          published_at: "2026-07-18T00:00:00Z",
          html_url:
            "https://github.com/ithealthtech/Signify-Suite/releases/tag/v0.5.0",
          body: "Release notes",
        }),
      };
    },
  });
  const backup = operations.createBackup();
  assert(
    operations.listBackups().length === 1,
    "Created backup was not listed.",
  );
  db.exec("INSERT INTO recovery_probe VALUES ('after');");
  operations.stageRestore(backup.name);
  assert(operations.listBackups()[0].pendingRestore, "Restore was not staged.");
  let traversalRejected = false;
  try {
    operations.managedFile("../signify-creator-escape.db");
  } catch (error) {
    traversalRejected = error.code === "INVALID_BACKUP_NAME";
  }
  assert(traversalRejected, "Backup path traversal was not rejected.");
  const update = await operations.checkForUpdates();
  assert(
    update.updateAvailable && update.latestVersion === "0.5.0",
    "Update comparison failed.",
  );
  assert(
    releaseRequest.options.headers.Authorization ===
      "Bearer sandbox-release-token",
    "Private release checks must authenticate server-side.",
  );
  assert(
    releaseRequest.options.headers["X-GitHub-Api-Version"] === "2022-11-28",
    "Release checks must pin the GitHub API version.",
  );
  const unavailableOperations = createApplicationOperations({
    config,
    db,
    version: "0.4.0",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  let updateFailure;
  try {
    await unavailableOperations.checkForUpdates();
  } catch (error) {
    updateFailure = error;
  }
  assert(
    updateFailure?.status === 502 &&
      updateFailure?.code === "UPDATE_CHECK_FAILED",
    "Update network failure was not normalized.",
  );
  const privateRepositoryOperations = createApplicationOperations({
    config: { ...config, updateGithubToken: "" },
    db,
    version: "0.4.0",
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  let privateRepositoryFailure;
  try {
    await privateRepositoryOperations.checkForUpdates();
  } catch (error) {
    privateRepositoryFailure = error;
  }
  assert(
    privateRepositoryFailure?.status === 503 &&
      privateRepositoryFailure?.code === "UPDATE_REPOSITORY_UNAUTHORIZED" &&
      privateRepositoryFailure.message.includes("SIGNIFY_UPDATE_GITHUB_TOKEN"),
    "Private repository authentication failure was not actionable.",
  );

  const publisher = generateKeyPairSync("ed25519"),
    publicKey = publisher.publicKey.export({ type: "spki", format: "pem" }),
    privateKey = publisher.privateKey.export({ type: "pkcs8", format: "pem" }),
    signedArtifact = path.join(root, "signed-artifact"),
    archiveBytes = Buffer.from("verified release archive"),
    archiveName = "signify-creator-v0.5.0.tar.gz",
    checksumName = `${archiveName}.sha256`,
    archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  fs.mkdirSync(signedArtifact);
  fs.writeFileSync(
    path.join(signedArtifact, "manifest.json"),
    JSON.stringify({ version: "0.5.0", commit: "2".repeat(40) }),
  );
  fs.writeFileSync(
    path.join(signedArtifact, "server.cjs"),
    "module.exports={};",
  );
  const artifactDigest = (name) =>
    createHash("sha256")
      .update(fs.readFileSync(path.join(signedArtifact, name)))
      .digest("hex");
  fs.writeFileSync(
    path.join(signedArtifact, "checksums.txt"),
    `${artifactDigest("manifest.json")}  manifest.json\n${artifactDigest("server.cjs")}  server.cjs\n`,
  );
  signRelease(signedArtifact, privateKey, "operations-test");
  let spawned;
  const installOperations = createApplicationOperations({
    config: {
      ...config,
      updates: {
        checkIntervalMs: 1000,
        maxArchiveBytes: 1024 * 1024,
        releasesDirectory: path.join(root, "releases"),
        currentLink: path.join(root, "current"),
        restartScript: path.join(root, "restart.cmd"),
        healthUrl: "https://signify.example.test/api/ready",
        releasePublicKey: publicKey,
        requireSignature: true,
      },
    },
    db,
    version: "0.4.0",
    fetchImpl: async (url) => {
      if (url.endsWith("/releases/latest"))
        return {
          ok: true,
          json: async () => ({
            tag_name: "v0.5.0",
            published_at: "2026-08-26T00:00:00Z",
            html_url: "https://github.example/releases/v0.5.0",
            assets: [
              { name: archiveName, url: "https://api.github.test/archive" },
              { name: checksumName, url: "https://api.github.test/checksum" },
            ],
          }),
        };
      const bytes = url.endsWith("/archive")
        ? archiveBytes
        : Buffer.from(`${archiveDigest}  ${archiveName}\n`);
      return {
        ok: true,
        headers: { get: () => String(bytes.length) },
        arrayBuffer: async () => bytes,
      };
    },
    extractImpl: async (_archive, destination) =>
      fs.cpSync(signedArtifact, destination, { recursive: true }),
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });
  const available = await installOperations.checkForUpdates();
  assert(
    available.packageReady && available.installSupported,
    "Signed managed update was not reported as installable.",
  );
  const scheduled = await installOperations.installUpdate();
  assert(
    scheduled.status === "scheduled" && scheduled.version === "0.5.0",
    "Managed update was not scheduled.",
  );
  assert(
    spawned?.command === process.execPath &&
      spawned.args.some((item) => item.endsWith("install-update.cjs")) &&
      spawned.options.detached,
    "Managed update helper was not detached safely.",
  );
  db.close();

  const restored = applyPendingRestore(config);
  assert(
    restored?.restored === backup.name,
    "Pending restore was not applied.",
  );
  assert(
    operations
      .listBackups()
      .some((item) => item.name.startsWith("signify-creator-pre-restore-")),
    "Pre-restore safety backup was not created.",
  );
  db = openDatabase(config.databasePath);
  assert(
    db.prepare("SELECT COUNT(*) count FROM recovery_probe").get().count === 1,
    "Restored database contents are incorrect.",
  );
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("Operations tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
