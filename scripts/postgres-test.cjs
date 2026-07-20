"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createPostgresPool,
  migratePostgres,
  migrationFiles,
  postgresConfig,
} = require("../server/postgres.cjs");

const expectedTables = [
  "application_integrations",
  "application_owner_mfa",
  "application_owners",
  "background_jobs",
  "organization_memberships",
  "organization_microsoft_connections",
  "organization_subscriptions",
  "organizations",
  "signature_campaigns",
  "signature_sessions",
  "signature_templates",
  "signature_users",
];

function staticChecks() {
  const migrations = migrationFiles();
  assert.ok(migrations.length > 0);
  assert.deepEqual(
    migrations.map(({ version }) => version),
    [...migrations.map(({ version }) => version)].sort(),
  );
  assert.equal(
    new Set(migrations.map(({ checksum }) => checksum)).size,
    migrations.length,
  );
  const schema = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "server",
      "postgres",
      "migrations",
      "001_baseline.sql",
    ),
    "utf8",
  );
  for (const table of expectedTables)
    assert.match(schema, new RegExp(`CREATE TABLE ${table}\\b`));
  assert.match(schema, /JSONB/);
  assert.match(schema, /TIMESTAMPTZ/);
  assert.throws(
    () =>
      postgresConfig({
        DATABASE_URL: "postgres://example",
        DATABASE_SSL_MODE: "invalid",
      }),
    /DATABASE_SSL_MODE/,
  );
  assert.throws(
    () =>
      postgresConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://example",
        DATABASE_SSL_MODE: "disable",
      }),
    /cannot be disabled/,
  );
}

async function liveChecks() {
  if (!process.env.TEST_DATABASE_URL) return false;
  const pool = createPostgresPool({
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
  });
  try {
    await migratePostgres(pool);
    await migratePostgres(pool);
    const tables = new Set(
      (
        await pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname=current_schema()",
        )
      ).rows.map((row) => row.tablename),
    );
    for (const table of expectedTables) assert.ok(tables.has(table), table);
    const history = await pool.query(
      "SELECT version,checksum FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      history.rows.map(({ version }) => version),
      migrationFiles().map(({ version }) => version),
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('missing','missing','owner')",
      ),
      /organization_memberships_role_check|violates check constraint/,
    );
    return true;
  } finally {
    await pool.end();
  }
}

async function main() {
  staticChecks();
  const live = await liveChecks();
  console.log(
    live
      ? "PostgreSQL tests passed: schema, TLS policy, live migrations, idempotency, and constraints"
      : "PostgreSQL static tests passed; live acceptance skipped because TEST_DATABASE_URL is not set",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
