"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
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

function verifyLegacyUpgrade() {
  const legacyPath = path.join(temporaryDirectory, "legacy.db"),
    legacy = new DatabaseSync(legacyPath),
    migrationsDirectory = path.join(__dirname, "..", "server", "migrations"),
    migrations = fs
      .readdirSync(migrationsDirectory)
      .filter((name) => /^\d+.*\.sql$/.test(name) && name < "017_")
      .sort();
  legacy.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ) STRICT;`);
  for (const migration of migrations) {
    legacy.exec(
      fs.readFileSync(path.join(migrationsDirectory, migration), "utf8"),
    );
    legacy
      .prepare("INSERT INTO schema_migrations(version) VALUES (?)")
      .run(migration);
  }
  legacy
    .prepare(
      `INSERT INTO background_jobs(id,type,status,attempts,max_attempts,last_error)
     VALUES ('legacy-job','directory.sync','dead_lettered',5,5,'legacy failure')`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO directory_sync_runs(id,organization_id,status,users_seen,users_added)
     VALUES ('legacy-sync','org-default','completed',10,2)`,
    )
    .run();
  legacy.close();

  const upgraded = openDatabase(legacyPath);
  try {
    const job = upgraded
        .prepare(
          "SELECT status,result_json FROM background_jobs WHERE id='legacy-job'",
        )
        .get(),
      sync = upgraded
        .prepare(
          "SELECT status,users_seen,users_added FROM directory_sync_runs WHERE id='legacy-sync'",
        )
        .get();
    assert.equal(job.status, "dead_lettered");
    assert.equal(job.result_json, "{}");
    assert.equal(sync.status, "completed");
    assert.equal(sync.users_seen, 10);
    assert.equal(sync.users_added, 2);
    assert.deepEqual(upgraded.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    upgraded.close();
  }
}

try {
  verifyLegacyUpgrade();
  const migrations = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => row.version);
  assert.ok(migrations.includes("013_query_plan_optimization.sql"));
  assert.equal(migrations.at(-1), "018_application_owner_mfa.sql");
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
