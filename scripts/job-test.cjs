"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const { createJobQueue } = require("../server/job-queue.cjs");

async function main() {
  const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-job-test-"),
    ),
    db = openDatabase(path.join(temporaryDirectory, "jobs.db"));
  let attempts = 0;
  const queue = createJobQueue(
    db,
    {
      successful: async (payload) => assert.equal(payload.value, 42),
      retry: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient failure");
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
    assert.equal(
      db.prepare("SELECT status FROM background_jobs WHERE id=?").get(first.id)
        .status,
      "completed",
    );

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
    console.log(
      "Job tests passed: deduplication, atomic execution, retry, completion, and stale recovery",
    );
  } finally {
    db.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
