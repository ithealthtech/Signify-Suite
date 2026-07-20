"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Pool } = require("pg");

const MIGRATION_LOCK = 761659820441n;

function positiveInteger(value, fallback, name) {
  const parsed = Number(value || fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function postgresConfig(env = process.env) {
  const connectionString = String(env.DATABASE_URL || "").trim();
  if (!connectionString)
    throw new Error("DATABASE_URL is required for PostgreSQL commands.");
  const sslMode = String(env.DATABASE_SSL_MODE || "verify-full").toLowerCase();
  if (!new Set(["disable", "require", "verify-full"]).has(sslMode))
    throw new Error(
      "DATABASE_SSL_MODE must be disable, require, or verify-full.",
    );
  if (env.NODE_ENV === "production" && sslMode === "disable")
    throw new Error("PostgreSQL TLS cannot be disabled in production.");
  const ssl =
    sslMode === "disable"
      ? false
      : {
          rejectUnauthorized: sslMode === "verify-full",
          ...(env.DATABASE_CA_CERT
            ? { ca: String(env.DATABASE_CA_CERT).replaceAll("\\n", "\n") }
            : {}),
        };
  return {
    connectionString,
    ssl,
    max: positiveInteger(env.DATABASE_POOL_MAX, 10, "DATABASE_POOL_MAX"),
    connectionTimeoutMillis: positiveInteger(
      env.DATABASE_CONNECT_TIMEOUT_MS,
      5000,
      "DATABASE_CONNECT_TIMEOUT_MS",
    ),
    idleTimeoutMillis: positiveInteger(
      env.DATABASE_IDLE_TIMEOUT_MS,
      30000,
      "DATABASE_IDLE_TIMEOUT_MS",
    ),
    application_name: String(
      env.DATABASE_APPLICATION_NAME || "signify-creator",
    ).trim(),
  };
}

function createPostgresPool(env = process.env) {
  const pool = new Pool(postgresConfig(env));
  pool.on("error", (error) => {
    process.stderr.write(
      `${JSON.stringify({ event: "postgres.pool_error", message: error.message })}\n`,
    );
  });
  return pool;
}

function migrationFiles(
  directory = path.join(__dirname, "postgres", "migrations"),
) {
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort()
    .map((version) => {
      const sql = fs.readFileSync(path.join(directory, version), "utf8");
      return {
        version,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

async function migratePostgres(pool, directory) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    )`);
    const applied = new Map(
      (
        await client.query("SELECT version,checksum FROM schema_migrations")
      ).rows.map((row) => [row.version, row.checksum]),
    );
    for (const migration of migrationFiles(directory)) {
      if (applied.has(migration.version)) {
        if (applied.get(migration.version) !== migration.checksum)
          throw new Error(
            `Applied PostgreSQL migration changed: ${migration.version}`,
          );
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
  }
}

async function postgresHealth(pool) {
  const result = await pool.query(
    "SELECT current_database() AS database, current_user AS username, version() AS version",
  );
  return result.rows[0];
}

module.exports = {
  createPostgresPool,
  migratePostgres,
  migrationFiles,
  postgresConfig,
  postgresHealth,
};
