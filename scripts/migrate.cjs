"use strict";

const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");

function migrate(config = loadConfig()) {
  const database = openDatabase(config.databasePath);
  try {
    const applied = database
        .prepare(
          "SELECT version,applied_at FROM schema_migrations ORDER BY version",
        )
        .all(),
      integrity = database.prepare("PRAGMA quick_check").get();
    if (integrity.quick_check !== "ok")
      throw new Error(
        `Database integrity check failed: ${integrity.quick_check}`,
      );
    return { databasePath: config.databasePath, applied };
  } finally {
    database.close();
  }
}

if (require.main === module) {
  try {
    const result = migrate();
    console.log(
      JSON.stringify({
        status: "ok",
        database: result.databasePath,
        migrations: result.applied.length,
        latest: result.applied.at(-1)?.version || null,
      }),
    );
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { migrate };
