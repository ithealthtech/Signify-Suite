"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const { acquireRuntimeLease } = require("../server/runtime-lease.cjs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signify-lease-")),
  databasePath = path.join(directory, "lease.db"),
  firstDb = openDatabase(databasePath),
  secondDb = openDatabase(databasePath);

try {
  const first = acquireRuntimeLease(firstDb, {
    ownerId: "first",
    ttlMs: 10000,
    heartbeatMs: 4000,
  });
  assert.throws(
    () =>
      acquireRuntimeLease(secondDb, {
        ownerId: "second",
        ttlMs: 10000,
        heartbeatMs: 4000,
      }),
    (error) => error.code === "RUNTIME_LEASE_HELD",
  );
  first.heartbeat();
  first.release();
  const second = acquireRuntimeLease(secondDb, {
    ownerId: "second",
    ttlMs: 10000,
    heartbeatMs: 4000,
  });
  second.release();

  firstDb
    .prepare(
      "INSERT OR REPLACE INTO runtime_leases(name,owner_id,acquired_at,heartbeat_at,expires_at) VALUES ('web','stale',?,?,?)",
    )
    .run(
      new Date(0).toISOString(),
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    );
  const takeover = acquireRuntimeLease(secondDb, {
    ownerId: "replacement",
    ttlMs: 10000,
    heartbeatMs: 4000,
  });
  takeover.release();
  console.log(
    "Runtime lease test passed: duplicate web rejection, graceful handoff, and expired lease takeover",
  );
} finally {
  firstDb.close();
  secondDb.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
