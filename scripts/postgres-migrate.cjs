"use strict";

const {
  createPostgresPool,
  migratePostgres,
  migrationFiles,
  postgresHealth,
} = require("../server/postgres.cjs");

async function main() {
  const pool = createPostgresPool();
  try {
    await migratePostgres(pool);
    const health = await postgresHealth(pool),
      applied = await pool.query(
        "SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version",
      );
    process.stdout.write(
      `${JSON.stringify({
        event: "postgres.migrations_complete",
        database: health.database,
        username: health.username,
        expected: migrationFiles().length,
        applied: applied.rows.length,
        migrations: applied.rows,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ event: "postgres.migrations_failed", message: error.message })}\n`,
  );
  process.exitCode = 1;
});
