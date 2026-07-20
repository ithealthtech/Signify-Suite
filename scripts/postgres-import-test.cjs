"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const {
  IMPORT_TABLES,
  openImportSource,
  postgresValue,
  quoteIdentifier,
  sourceTable,
} = require("../server/postgres-import.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-pg-import-test-")),
  sourcePath = path.join(root, "source.db");

try {
  const writable = openDatabase(sourcePath);
  writable
    .prepare(
      "INSERT INTO signature_users(id,email,password_hash,display_name) VALUES (?,?,?,?)",
    )
    .run("user-test", "test@example.com", "hash", "Test User");
  writable.close();

  const source = openImportSource(sourcePath);
  try {
    assert.equal(IMPORT_TABLES.length, 27);
    for (const table of IMPORT_TABLES) {
      const data = sourceTable(source, table);
      assert.ok(data.columns.length > 0, table);
      assert.ok(Array.isArray(data.rows), table);
    }
    assert.equal(sourceTable(source, "signature_users").rows.length, 1);
    assert.throws(() => sourceTable(source, "invalid-table"), /missing table/);
    assert.throws(() => quoteIdentifier('users";DROP TABLE users'), /Unsafe/);
    assert.equal(postgresValue("stripe_webhook_events", "livemode", 0), false);
    assert.equal(postgresValue("stripe_webhook_events", "livemode", 1), true);
    assert.equal(
      postgresValue("install_profiles", "database_provider", "sqlite"),
      "postgresql",
    );
    assert.equal(
      postgresValue("signature_users", "status", "active"),
      "active",
    );
  } finally {
    source.close();
  }
  console.log(
    "PostgreSQL import tests passed: complete table inventory, read-only source checks, identifiers, and type conversion",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
