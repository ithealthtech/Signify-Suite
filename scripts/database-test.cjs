"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");

const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "signify-database-test-"),
  ),
  databasePath = path.join(temporaryDirectory, "database.db"),
  db = openDatabase(databasePath);

function plan(sql, ...parameters) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => row.detail)
    .join("\n");
}

try {
  const migrations = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  assert.ok(migrations.includes("013_query_plan_optimization.sql"));
  assert.equal(migrations.at(-1), "016_job_dead_letters.sql");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.match(
    plan("SELECT * FROM signature_users WHERE lower(email)=lower(?)", "a@b.co"),
    /signature_users_email_nocase/,
  );
  assert.match(
    plan(
      "SELECT * FROM organization_memberships WHERE user_id=? AND status='active' ORDER BY created_at",
      "user",
    ),
    /organization_memberships_user_status_created/,
  );
  assert.match(
    plan(
      "SELECT * FROM organization_memberships WHERE organization_id=? AND json_extract(signature_json,'$.workflowStatus')='pending' ORDER BY json_extract(signature_json,'$.submittedAt')",
      "organization",
    ),
    /organization_memberships_workflow/,
  );
  assert.match(
    plan(
      "SELECT * FROM organizations ORDER BY created_at DESC LIMIT 25 OFFSET 0",
    ),
    /organizations_created/,
  );

  db.close();
  const reopened = openDatabase(databasePath);
  assert.equal(
    reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()
      .count,
    migrations.length,
  );
  reopened.close();
  console.log(
    "Database tests passed: clean migration, integrity, query plans, and reopen safety",
  );
} finally {
  try {
    db.close();
  } catch {}
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
