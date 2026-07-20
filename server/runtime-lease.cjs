"use strict";

const { randomUUID } = require("node:crypto");
const { clearInterval, setInterval } = require("node:timers");

function iso(value) {
  return new Date(value).toISOString();
}

function acquireRuntimeLease(
  db,
  {
    name = "web",
    ownerId = randomUUID(),
    ttlMs = 30000,
    heartbeatMs = 10000,
    onHealth = () => {},
  } = {},
) {
  if (ttlMs < heartbeatMs * 2)
    throw new Error(
      "Runtime lease TTL must be at least two heartbeat intervals.",
    );
  let released = false;

  function claim() {
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db
        .prepare("SELECT owner_id,expires_at FROM runtime_leases WHERE name=?")
        .get(name);
      if (
        existing &&
        existing.owner_id !== ownerId &&
        Date.parse(existing.expires_at) > now
      ) {
        const error = new Error(
          `Runtime lease '${name}' is already held by another instance.`,
        );
        error.code = "RUNTIME_LEASE_HELD";
        throw error;
      }
      db.prepare(
        `INSERT INTO runtime_leases(name,owner_id,acquired_at,heartbeat_at,expires_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET
           owner_id=excluded.owner_id,
           acquired_at=excluded.acquired_at,
           heartbeat_at=excluded.heartbeat_at,
           expires_at=excluded.expires_at`,
      ).run(name, ownerId, iso(now), iso(now), iso(now + ttlMs));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function heartbeat() {
    if (released) return;
    const now = Date.now(),
      result = db
        .prepare(
          "UPDATE runtime_leases SET heartbeat_at=?,expires_at=? WHERE name=? AND owner_id=?",
        )
        .run(iso(now), iso(now + ttlMs), name, ownerId);
    if (result.changes !== 1) {
      const error = new Error(`Runtime lease '${name}' was lost.`);
      error.code = "RUNTIME_LEASE_LOST";
      onHealth(false, error);
      return;
    }
    onHealth(true);
  }

  claim();
  onHealth(true);
  const timer = setInterval(() => {
    try {
      heartbeat();
    } catch (error) {
      onHealth(false, error);
    }
  }, heartbeatMs);
  timer.unref();

  function release() {
    if (released) return;
    released = true;
    clearInterval(timer);
    db.prepare("DELETE FROM runtime_leases WHERE name=? AND owner_id=?").run(
      name,
      ownerId,
    );
  }

  return { heartbeat, name, ownerId, release };
}

module.exports = { acquireRuntimeLease };
