"use strict";

const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");
const {
  createApplicationOperations,
} = require("../server/application-operations.cjs");
const { createRecoveryManager } = require("../server/recovery.cjs");
const packageMetadata = require("../package.json");

async function main() {
  const config = loadConfig(),
    db = openDatabase(config.databasePath);
  try {
    const operations = createApplicationOperations({
        config,
        db,
        version: packageMetadata.version,
      }),
      backup = operations.createBackup(),
      recovery = createRecoveryManager(config),
      result = await recovery.protect(operations.managedFile(backup.name));
    console.log(
      JSON.stringify({
        status: "protected",
        backup,
        sha256: result.sha256,
        offsite: result.offsite,
        media: result.media,
        removedLocal: result.removedLocal.length,
        removedOffsite: result.removedOffsite.length,
      }),
    );
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
