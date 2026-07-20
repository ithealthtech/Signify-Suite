"use strict";

const path = require("node:path");
const {
  deployArtifact,
  installDependencies,
  readinessProbe,
  restartScript,
} = require("../server/deployment.cjs");

async function main() {
  const artifact = path.resolve(process.argv[2] || "dist"),
    releasesDirectory = process.env.SIGNIFY_RELEASES_DIR,
    currentLink = process.env.SIGNIFY_CURRENT_LINK,
    databasePath = process.env.DATABASE_PATH,
    backupDirectory = process.env.BACKUP_DIR,
    restart = process.env.SIGNIFY_DEPLOY_RESTART_SCRIPT,
    healthUrl = process.env.SIGNIFY_DEPLOY_HEALTH_URL;
  if (!releasesDirectory || !currentLink || !restart || !healthUrl)
    throw new Error(
      "SIGNIFY_RELEASES_DIR, SIGNIFY_CURRENT_LINK, SIGNIFY_DEPLOY_RESTART_SCRIPT, and SIGNIFY_DEPLOY_HEALTH_URL are required.",
    );
  const result = await deployArtifact({
    artifact,
    releasesDirectory,
    currentLink,
    databasePath,
    backupDirectory,
    install: installDependencies,
    restart: () => restartScript(restart),
    probe: (manifest) => readinessProbe(healthUrl, manifest?.version || null),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ event: "deployment.failed", code: error.code || "DEPLOYMENT_FAILED", message: error.message })}\n`,
  );
  process.exitCode = 1;
});
