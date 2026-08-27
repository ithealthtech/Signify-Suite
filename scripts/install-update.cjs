"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../server/config.cjs");
const {
  deployArtifact,
  installDependencies,
  readinessProbe,
  restartScript,
} = require("../server/deployment.cjs");
const { writeUpdateStatus } = require("../server/application-operations.cjs");

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const sourceRoot = path.join(__dirname, ".."),
    config = loadConfig(process.env, sourceRoot),
    artifact = path.resolve(process.argv[2] || ""),
    stagingRoot = path.dirname(artifact),
    version = JSON.parse(
      fs.readFileSync(path.join(artifact, "manifest.json"), "utf8"),
    ).version;
  writeUpdateStatus(config.backupPath, { status: "installing", version });
  await delay(1500);
  try {
    const result = await deployArtifact({
      artifact,
      releasesDirectory: config.updates.releasesDirectory,
      currentLink: config.updates.currentLink,
      databasePath: config.databasePath,
      backupDirectory: config.backupPath,
      releasePublicKey: config.updates.releasePublicKey,
      requireSignature: true,
      install: installDependencies,
      restart: () => restartScript(config.updates.restartScript),
      probe: (manifest) =>
        readinessProbe(config.updates.healthUrl, manifest?.version || null),
    });
    writeUpdateStatus(config.backupPath, {
      status: result.status,
      version,
      previousVersion: result.previous
        ? path.basename(result.previous).split("-")[0]
        : null,
      safetyBackup: result.safetyBackup
        ? path.basename(result.safetyBackup)
        : null,
    });
  } catch (error) {
    writeUpdateStatus(config.backupPath, {
      status: "failed",
      version,
      code: error.code || "UPDATE_INSTALL_FAILED",
      error: error.message,
    });
    throw error;
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ event: "update.install_failed", code: error.code || "UPDATE_INSTALL_FAILED", message: error.message })}\n`,
  );
  process.exitCode = 1;
});
