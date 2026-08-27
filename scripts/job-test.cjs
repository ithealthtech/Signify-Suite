"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const { createJobQueue } = require("../server/job-queue.cjs");
const { startWorker } = require("../worker.cjs");

async function waitForCompleted(db, id) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = db
      .prepare("SELECT status FROM background_jobs WHERE id=?")
      .get(id);
    if (row?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("External worker did not complete the queued job.");
}

async function main() {
  const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-job-test-"),
    ),
    db = openDatabase(path.join(temporaryDirectory, "jobs.db"));
  let attempts = 0;
  const queue = createJobQueue(
    db,
    {
      successful: async (payload) => {
        assert.equal(payload.value, 42);
        return { accepted: true };
      },
      retry: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient failure");
      },
      terminal: async () => {
        throw new Error("permanent failure");
      },
      "email.transactional": async (payload) => {
        if (payload.fail) throw new Error("email delivery failed");
        assert.match(payload.html, /secret-token/);
        return { delivered: true };
      },
    },
    { retryBaseSeconds: 1, staleAfterMinutes: 1 },
  );
  try {
    const first = queue.enqueue(
        "successful",
        { value: 42 },
        { dedupeKey: "one" },
      ),
      duplicate = queue.enqueue(
        "successful",
        { value: 42 },
        { dedupeKey: "one" },
      );
    assert.equal(first.id, duplicate.id);
    assert.equal(await queue.runOnce(), true);
    const completed = db
      .prepare("SELECT * FROM background_jobs WHERE id=?")
      .get(first.id);
    assert.equal(completed.status, "completed");
    assert.deepEqual(JSON.parse(completed.result_json), { accepted: true });

    const delayed = queue.enqueue(
      "successful",
      { value: 42 },
      { availableAt: new Date(Date.now() + 60000).toISOString() },
    );
    assert.equal(queue.claim(), null);
    db.prepare(
      "UPDATE background_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?",
    ).run(delayed.id);
    assert.equal(await queue.runOnce(), true);
    assert.equal(
      db
        .prepare("SELECT status FROM background_jobs WHERE id=?")
        .get(delayed.id).status,
      "completed",
    );
    assert.throws(
      () => queue.enqueue("successful", {}, { availableAt: "not-a-date" }),
      /availableAt/,
    );

    const activeDedupe = queue.enqueue(
        "successful",
        { value: 42 },
        { dedupeKey: "active" },
      ),
      activeClaim = queue.claim(),
      repeatedActive = queue.enqueue(
        "successful",
        { value: 99 },
        { dedupeKey: "active" },
      );
    assert.equal(activeClaim.id, activeDedupe.id);
    assert.equal(repeatedActive.id, activeDedupe.id);
    assert.equal(repeatedActive.status, "running");
    assert.deepEqual(JSON.parse(repeatedActive.payload_json), { value: 42 });
    queue.complete(activeClaim.id);

    const retry = queue.enqueue("retry", {}, { maxAttempts: 2 });
    assert.equal(await queue.runOnce(), true);
    let retryRow = db
      .prepare("SELECT * FROM background_jobs WHERE id=?")
      .get(retry.id);
    assert.equal(retryRow.status, "queued");
    assert.match(retryRow.last_error, /transient failure/);
    db.prepare(
      "UPDATE background_jobs SET available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?",
    ).run(retry.id);
    assert.equal(await queue.runOnce(), true);
    retryRow = db
      .prepare("SELECT * FROM background_jobs WHERE id=?")
      .get(retry.id);
    assert.equal(retryRow.status, "completed");
    assert.equal(retryRow.attempts, 2);

    const terminal = queue.enqueue("terminal", {}, { maxAttempts: 1 });
    assert.equal(await queue.runOnce(), true);
    const terminalRow = db
      .prepare("SELECT * FROM background_jobs WHERE id=?")
      .get(terminal.id);
    assert.equal(terminalRow.status, "dead_lettered");
    assert.ok(terminalRow.dead_lettered_at);
    assert.match(terminalRow.last_error, /permanent failure/);

    const deliveredEmail = queue.enqueue("email.transactional", {
      html: '<a href="https://example.test/secret-token">Verify</a>',
    });
    assert.equal(await queue.runOnce(), true);
    assert.deepEqual(
      JSON.parse(
        db
          .prepare("SELECT payload_json FROM background_jobs WHERE id=?")
          .get(deliveredEmail.id).payload_json,
      ),
      {},
    );
    const failedEmail = queue.enqueue(
      "email.transactional",
      { fail: true, html: "secret-token" },
      { maxAttempts: 1 },
    );
    assert.equal(await queue.runOnce(), true);
    const failedEmailRow = db
      .prepare("SELECT status,payload_json FROM background_jobs WHERE id=?")
      .get(failedEmail.id);
    assert.equal(failedEmailRow.status, "dead_lettered");
    assert.deepEqual(JSON.parse(failedEmailRow.payload_json), {});

    db.prepare(
      "INSERT INTO organizations(id,name,slug) VALUES ('tenant-a','Tenant A','tenant-a'),('tenant-b','Tenant B','tenant-b')",
    ).run();
    const activeTenantJob = queue.enqueue(
        "successful",
        { value: 42 },
        { organizationId: "tenant-a" },
      ),
      blockedTenantJob = queue.enqueue(
        "successful",
        { value: 42 },
        { organizationId: "tenant-a" },
      ),
      otherTenantJob = queue.enqueue(
        "successful",
        { value: 42 },
        { organizationId: "tenant-b" },
      );
    db.prepare(
      "UPDATE background_jobs SET status='running',locked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(activeTenantJob.id);
    const tenantClaim = queue.claim();
    assert.equal(tenantClaim.id, otherTenantJob.id);
    assert.notEqual(tenantClaim.id, blockedTenantJob.id);
    queue.complete(tenantClaim.id);
    queue.complete(activeTenantJob.id);

    const stale = queue.enqueue("successful", { value: 42 });
    db.prepare(
      "UPDATE background_jobs SET status='running',locked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours') WHERE id=?",
    ).run(stale.id);
    assert.equal(queue.recoverStale(), 1);
    assert.equal(
      db.prepare("SELECT status FROM background_jobs WHERE id=?").get(stale.id)
        .status,
      "queued",
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );

    const workerDb = openDatabase(
        path.join(temporaryDirectory, "external-worker.db"),
      ),
      worker = startWorker({
        application: {
          db: workerDb,
          jobHandlers: {},
          mediaStorage: null,
          observability: {
            start() {},
            log() {},
            async stop() {},
          },
        },
        db: workerDb,
        config: {
          jobMode: "external",
          publicRoot: path.join(temporaryDirectory, "public"),
          workerHealthPath: path.join(temporaryDirectory, "worker-health.json"),
          workerHeartbeatMs: 5000,
        },
        signals: false,
        jobOptions: {
          pollIntervalMs: 20,
          handlers: {
            "tenant.acceptance": async (payload) =>
              assert.equal(payload.organizationId, "tenant-1"),
          },
        },
      }),
      externalJob = worker.jobs.queue.enqueue(
        "tenant.acceptance",
        { organizationId: "tenant-1" },
        { dedupeKey: "tenant-1:acceptance" },
      );
    assert.equal(
      JSON.parse(fs.readFileSync(worker.config.workerHealthPath, "utf8"))
        .status,
      "ready",
    );
    await waitForCompleted(workerDb, externalJob.id);
    await worker.stop("test");
    assert.equal(fs.existsSync(worker.config.workerHealthPath), false);
    console.log(
      "Job tests passed: deduplication, atomic execution, retry, dead letters, sensitive payload scrubbing, tenant concurrency, completion, stale recovery, external execution, and graceful shutdown",
    );
  } finally {
    db.close();
    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
