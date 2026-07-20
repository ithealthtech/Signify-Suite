"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createPostgresPool,
  migratePostgres,
} = require("../server/postgres.cjs");
const { importSqliteToPostgres } = require("../server/postgres-import.cjs");

async function main() {
  const source = path.resolve(
    String(process.env.SOURCE_DATABASE_PATH || "").trim(),
  );
  if (!process.env.SOURCE_DATABASE_PATH)
    throw new Error("SOURCE_DATABASE_PATH is required.");
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile())
    throw new Error(`SQLite source does not exist: ${source}`);
  const pool = createPostgresPool();
  try {
    await migratePostgres(pool);
    const counts = await importSqliteToPostgres({ source, pool });
    process.stdout.write(
      `${JSON.stringify({
        event: "postgres.import_complete",
        source,
        tables: Object.keys(counts).length,
        rows: Object.values(counts).reduce((total, count) => total + count, 0),
        counts,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ event: "postgres.import_failed", message: error.message })}\n`,
  );
  process.exitCode = 1;
});
