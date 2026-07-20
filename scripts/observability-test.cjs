"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const {
  createObservability,
  traceContext,
} = require("../server/observability.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-observability-")),
  db = openDatabase(path.join(root, "test.db")),
  records = [],
  exportCalls = [],
  output = {
    log(value) {
      records.push(JSON.parse(value));
    },
    error(value) {
      records.push(JSON.parse(value));
    },
  },
  config = {
    logLevel: "debug",
    observability: {
      endpoint: "https://collector.example.test/events",
      token: "collector-secret",
      service: "signify-test",
      environment: "test",
      batchSize: 100,
      maxBuffer: 100,
      flushIntervalMs: 60000,
      timeoutMs: 1000,
      minimumRequestSample: 2,
      errorRateThreshold: 0.5,
      queueAgeThresholdSeconds: 30,
      alertCooldownMs: 30000,
    },
  };

async function main() {
  const observability = createObservability({
    config,
    db,
    output,
    fetchImpl: async (url, options) => {
      exportCalls.push({ url, options });
      return { ok: true, status: 202 };
    },
  });
  observability.log("info", "security.test", {
    password: "do-not-export",
    nested: { accessToken: "do-not-export", safe: "kept" },
  });
  assert.equal(records[0].password, "[REDACTED]");
  assert.equal(records[0].nested.accessToken, "[REDACTED]");
  assert.equal(records[0].nested.safe, "kept");

  const incoming = traceContext(
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  );
  assert.equal(incoming.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(traceContext("invalid").traceId.length, 32);

  observability.recordRequest({ status: 500, durationMs: 40, path: "/failed" });
  observability.recordRequest({ status: 200, durationMs: 10, path: "/ok" });
  const alerts = observability.evaluateAlerts();
  assert(alerts.some((item) => item.code === "HTTP_ERROR_RATE"));
  const snapshot = observability.snapshot();
  assert.equal(snapshot.requests, 2);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.status.serverError, 1);
  assert.match(observability.prometheus(), /signify_http_requests_total 2/);
  assert.match(
    observability.prometheus(),
    /signify_background_jobs\{status="queued"\}/,
  );

  await observability.flush();
  assert.equal(exportCalls.length, 1);
  assert.equal(
    exportCalls[0].options.headers.Authorization,
    "Bearer collector-secret",
  );
  const payload = JSON.parse(exportCalls[0].options.body);
  assert(payload.events.some((item) => item.event === "operational.alert"));
  assert(!exportCalls[0].options.body.includes("do-not-export"));
  assert.equal(observability.snapshot().exporter.buffered, 0);

  let attempts = 0;
  const retrying = createObservability({
    config,
    db,
    output,
    fetchImpl: async () => {
      attempts += 1;
      return { ok: attempts > 1, status: 503 };
    },
  });
  retrying.log("error", "retry.test", { safe: true });
  await retrying.flush();
  assert.equal(retrying.snapshot().exporter.buffered, 1);
  await retrying.flush();
  assert.equal(retrying.snapshot().exporter.buffered, 0);
  await retrying.stop();
  await observability.stop();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    "Observability test passed: redaction, trace context, metrics, alerts, export, and retry",
  );
}

main().catch((error) => {
  try {
    db.close();
  } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
