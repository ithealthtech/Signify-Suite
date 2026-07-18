"use strict";

const { randomUUID } = require("node:crypto");
const { clearInterval, setInterval } = require("node:timers");
const { cleanupOrphanMedia } = require("./media-storage.cjs");

function createJobQueue(db, handlers = {}, options = {}) {
  const retryBaseSeconds = Math.max(1, Number(options.retryBaseSeconds || 5)),
    staleAfterMinutes = Math.max(1, Number(options.staleAfterMinutes || 15));

  function enqueue(type, payload = {}, jobOptions = {}) {
    const id = randomUUID(),
      dedupeKey = jobOptions.dedupeKey || null,
      maxAttempts = Math.max(1, Number(jobOptions.maxAttempts || 5));
    if (dedupeKey) {
      db.prepare(
        `INSERT INTO background_jobs(id,organization_id,type,payload_json,max_attempts,dedupe_key)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           organization_id=excluded.organization_id,
           type=excluded.type,
           payload_json=excluded.payload_json,
           status='queued',attempts=0,max_attempts=excluded.max_attempts,
           available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),locked_at=NULL,
           completed_at=NULL,last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(
        id,
        jobOptions.organizationId || null,
        type,
        JSON.stringify(payload),
        maxAttempts,
        dedupeKey,
      );
      return db
        .prepare("SELECT * FROM background_jobs WHERE dedupe_key=?")
        .get(dedupeKey);
    }
    db.prepare(
      "INSERT INTO background_jobs(id,organization_id,type,payload_json,max_attempts) VALUES (?,?,?,?,?)",
    ).run(
      id,
      jobOptions.organizationId || null,
      type,
      JSON.stringify(payload),
      maxAttempts,
    );
    return db.prepare("SELECT * FROM background_jobs WHERE id=?").get(id);
  }

  function recoverStale() {
    return db
      .prepare(
        `UPDATE background_jobs SET status='queued',locked_at=NULL,
         available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         last_error='Recovered stale worker lock.',
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE status='running' AND locked_at<strftime('%Y-%m-%dT%H:%M:%fZ','now',?)`,
      )
      .run(`-${staleAfterMinutes} minutes`).changes;
  }

  function claim() {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const row = db
        .prepare(
          `UPDATE background_jobs SET status='running',attempts=attempts+1,
           locked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id=(SELECT id FROM background_jobs
             WHERE status='queued' AND available_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             ORDER BY available_at,created_at LIMIT 1)
           RETURNING *`,
        )
        .get();
      db.exec("COMMIT;");
      return row || null;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  function complete(id) {
    db.prepare(
      `UPDATE background_jobs SET status='completed',locked_at=NULL,
       completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='',
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(id);
  }

  function fail(job, error) {
    const terminal = job.attempts >= job.max_attempts,
      delay = retryBaseSeconds * 2 ** Math.max(0, job.attempts - 1);
    db.prepare(
      `UPDATE background_jobs SET status=?,locked_at=NULL,last_error=?,
       available_at=CASE WHEN ? THEN available_at ELSE datetime('now',?) END,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(
      terminal ? "failed" : "queued",
      String(error?.message || error).slice(0, 1000),
      terminal ? 1 : 0,
      `+${delay} seconds`,
      job.id,
    );
  }

  async function runOnce() {
    const job = claim();
    if (!job) return false;
    try {
      const handler = handlers[job.type];
      if (!handler) throw new Error(`No handler registered for ${job.type}.`);
      await handler(JSON.parse(job.payload_json), job);
      complete(job.id);
    } catch (error) {
      fail(job, error);
    }
    return true;
  }

  return Object.freeze({
    claim,
    complete,
    enqueue,
    fail,
    recoverStale,
    runOnce,
  });
}

function startJobWorker(db, options = {}) {
  const handlers = {
      "maintenance.cleanup": () =>
        db.exec(`DELETE FROM signature_sessions WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
          DELETE FROM password_reset_tokens WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR used_at IS NOT NULL;
          DELETE FROM email_verification_tokens WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR used_at IS NOT NULL;
          DELETE FROM oauth_states WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');`),
      "maintenance.media": () =>
        options.publicRoot
          ? cleanupOrphanMedia(db, options.publicRoot, 7)
          : { removedFiles: 0, removedBytes: 0 },
      ...(options.handlers || {}),
    },
    queue = createJobQueue(db, handlers, options);
  let stopped = false,
    active = false;
  queue.recoverStale();
  queue.enqueue(
    "maintenance.cleanup",
    {},
    { dedupeKey: "maintenance.cleanup" },
  );
  queue.enqueue("maintenance.media", {}, { dedupeKey: "maintenance.media" });
  async function poll() {
    if (stopped || active) return;
    active = true;
    try {
      while (!stopped && (await queue.runOnce())) {}
    } finally {
      active = false;
    }
  }
  const timer = setInterval(
    poll,
    Math.max(250, options.pollIntervalMs || 1000),
  );
  timer.unref();
  void poll();
  return {
    queue,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (active) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

module.exports = { createJobQueue, startJobWorker };
