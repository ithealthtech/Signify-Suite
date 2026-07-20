"use strict";

const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const IMPORT_TABLES = [
  "install_profiles",
  "signature_users",
  "organizations",
  "organization_memberships",
  "signature_templates",
  "signature_sessions",
  "organization_subscriptions",
  "audit_logs",
  "signature_campaigns",
  "signature_tracking_links",
  "department_signature_defaults",
  "directory_sync_runs",
  "email_verification_tokens",
  "password_reset_tokens",
  "organization_invitations",
  "stripe_webhook_events",
  "oauth_states",
  "oauth_state_security",
  "application_owners",
  "organization_microsoft_connections",
  "application_audit_logs",
  "application_integrations",
  "application_settings",
  "background_jobs",
  "application_owner_mfa",
  "application_owner_mfa_recovery_codes",
  "mfa_login_challenges",
];

const BOOLEAN_COLUMNS = new Set(["stripe_webhook_events.livemode"]);

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function openImportSource(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec("PRAGMA foreign_keys=ON;");
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  if (integrity !== "ok") {
    db.close();
    throw new Error(`SQLite integrity check failed: ${integrity}`);
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) {
    db.close();
    throw new Error(
      `SQLite foreign-key check found ${foreignKeys.length} violation(s).`,
    );
  }
  const expectedMigrations = fs
      .readdirSync(path.join(__dirname, "migrations"))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort(),
    appliedMigrations = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => row.version);
  if (
    JSON.stringify(appliedMigrations) !== JSON.stringify(expectedMigrations)
  ) {
    db.close();
    throw new Error(
      "SQLite source migration history does not match this release.",
    );
  }
  return db;
}

function sourceTable(db, table) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  if (!exists) throw new Error(`SQLite source is missing table ${table}.`);
  const columns = db
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all()
      .map((column) => column.name),
    rows = db.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
  return { columns, rows };
}

function postgresValue(table, column, value) {
  if (value === null || value === undefined) return null;
  if (table === "install_profiles" && column === "database_provider")
    return "postgresql";
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) return Boolean(value);
  return value;
}

async function assertEmptyTarget(client) {
  for (const table of IMPORT_TABLES) {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(table)} LIMIT 1) AS populated`,
    );
    if (result.rows[0].populated)
      throw new Error(
        `PostgreSQL target table ${table} is not empty; import aborted.`,
      );
  }
}

async function insertTable(client, table, source) {
  if (!source.rows.length) return 0;
  const columnSql = source.columns.map(quoteIdentifier).join(","),
    rowWidth = source.columns.length,
    batchSize = Math.max(1, Math.floor(30000 / rowWidth));
  let inserted = 0;
  for (let offset = 0; offset < source.rows.length; offset += batchSize) {
    const batch = source.rows.slice(offset, offset + batchSize),
      values = [],
      tuples = batch.map((row) => {
        const placeholders = source.columns.map((column) => {
          values.push(postgresValue(table, column, row[column]));
          return `$${values.length}`;
        });
        return `(${placeholders.join(",")})`;
      });
    const result = await client.query(
      `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES ${tuples.join(",")}`,
      values,
    );
    inserted += result.rowCount;
  }
  return inserted;
}

async function importSqliteToPostgres({ source, pool }) {
  const db = openImportSource(source),
    client = await pool.connect(),
    counts = {};
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    try {
      await assertEmptyTarget(client);
      for (const table of IMPORT_TABLES) {
        const data = sourceTable(db, table),
          inserted = await insertTable(client, table, data);
        if (inserted !== data.rows.length)
          throw new Error(
            `Row-count mismatch for ${table}: read ${data.rows.length}, inserted ${inserted}.`,
          );
        counts[table] = inserted;
      }
      for (const [table, expected] of Object.entries(counts)) {
        const result = await client.query(
          `SELECT count(*)::integer AS count FROM ${quoteIdentifier(table)}`,
        );
        if (result.rows[0].count !== expected)
          throw new Error(
            `PostgreSQL verification mismatch for ${table}: expected ${expected}, found ${result.rows[0].count}.`,
          );
      }
      await client.query("COMMIT");
      return counts;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
    db.close();
  }
}

module.exports = {
  IMPORT_TABLES,
  importSqliteToPostgres,
  openImportSource,
  postgresValue,
  quoteIdentifier,
  sourceTable,
};
