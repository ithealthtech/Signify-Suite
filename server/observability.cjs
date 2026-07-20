"use strict";

const { randomUUID } = require("node:crypto");
const { clearInterval, setInterval } = require("node:timers");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DURATION_BUCKETS = Object.freeze([
  25, 50, 100, 250, 500, 1000, 2500, 5000,
]);
const SENSITIVE_KEY =
  /authorization|cookie|password|secret|token|credential|session|signature/i;

function clean(value, depth = 0) {
  if (depth > 5) return "[TRUNCATED]";
  if (value instanceof Error)
    return { name: value.name, message: value.message, code: value.code };
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => clean(item, depth + 1));
  if (!value || typeof value !== "object")
    return typeof value === "string" && value.length > 2000
      ? `${value.slice(0, 2000)}...[TRUNCATED]`
      : value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : clean(item, depth + 1),
    ]),
  );
}

function traceContext(header) {
  const match = String(header || "")
    .trim()
    .match(/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/i);
  if (match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2]))
    return {
      traceId: match[1].toLowerCase(),
      parentSpanId: match[2].toLowerCase(),
    };
  return { traceId: randomUUID().replaceAll("-", ""), parentSpanId: null };
}

function metricName(value) {
  return String(value).replace(/[^a-zA-Z0-9_:]/g, "_");
}

function createObservability({
  config,
  db,
  fetchImpl = fetch,
  output = console,
} = {}) {
  const startedAt = new Date().toISOString(),
    counters = {
      requests: 0,
      errors: 0,
      durationMs: 0,
      status: { success: 0, redirect: 0, clientError: 0, serverError: 0 },
      durationBuckets: Object.fromEntries(
        DURATION_BUCKETS.map((value) => [value, 0]),
      ),
    },
    pending = [];
  let timer = null,
    flushing = false,
    dropped = 0,
    lastAlertAt = 0;

  function enqueue(record) {
    if (!config.observability?.endpoint) return;
    if (pending.length >= config.observability.maxBuffer) {
      pending.shift();
      dropped += 1;
    }
    pending.push(record);
  }

  function log(level, event, fields = {}) {
    if (config.logLevel === "silent") return;
    if ((LEVELS[level] || 20) < (LEVELS[config.logLevel] || 20)) return;
    const record = clean({
      time: new Date().toISOString(),
      level,
      event,
      service: config.observability?.service || "signify-creator",
      environment: config.observability?.environment || "development",
      ...fields,
    });
    output[level === "error" ? "error" : "log"](JSON.stringify(record));
    enqueue(record);
  }

  function recordRequest({ status, durationMs, ...fields }) {
    counters.requests += 1;
    counters.durationMs += durationMs;
    for (const boundary of DURATION_BUCKETS)
      if (durationMs <= boundary) counters.durationBuckets[boundary] += 1;
    if (status >= 500) {
      counters.status.serverError += 1;
      counters.errors += 1;
    } else if (status >= 400) counters.status.clientError += 1;
    else if (status >= 300) counters.status.redirect += 1;
    else counters.status.success += 1;
    log(
      status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      "http.request",
      {
        status,
        durationMs,
        ...fields,
      },
    );
  }

  function runtime() {
    let jobs = {
        queued: 0,
        running: 0,
        deadLettered: 0,
        oldestQueuedSeconds: 0,
      },
      providers = { microsoftErrors: 0, stripeErrors: 0 };
    if (db) {
      const rows = db
        .prepare(
          "SELECT status,COUNT(*) count FROM background_jobs GROUP BY status",
        )
        .all();
      for (const row of rows) {
        if (row.status === "queued") jobs.queued = row.count;
        if (row.status === "running") jobs.running = row.count;
        if (row.status === "dead_lettered") jobs.deadLettered = row.count;
      }
      jobs.oldestQueuedSeconds = Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(0,CAST((julianday('now')-julianday(MIN(created_at)))*86400 AS INTEGER)),0) value FROM background_jobs WHERE status='queued'",
          )
          .get().value,
      );
      providers = {
        microsoftErrors: Number(
          db
            .prepare(
              "SELECT COUNT(*) count FROM organization_microsoft_connections WHERE COALESCE(last_error,'')<>''",
            )
            .get().count,
        ),
        stripeErrors: Number(
          db
            .prepare(
              "SELECT COUNT(*) count FROM organization_subscriptions WHERE COALESCE(billing_error,'')<>''",
            )
            .get().count,
        ),
      };
    }
    return { jobs, providers };
  }

  function snapshot() {
    const memory = process.memoryUsage(),
      health = runtime();
    return {
      startedAt,
      requests: counters.requests,
      errors: counters.errors,
      averageDurationMs: counters.requests
        ? Number((counters.durationMs / counters.requests).toFixed(2))
        : 0,
      status: { ...counters.status },
      jobs: health.jobs,
      providers: health.providers,
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        residentMemoryBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      exporter: { buffered: pending.length, dropped },
    };
  }

  function prometheus() {
    const data = snapshot(),
      lines = [
        "# TYPE signify_http_requests_total counter",
        `signify_http_requests_total ${data.requests}`,
        "# TYPE signify_http_errors_total counter",
        `signify_http_errors_total ${data.errors}`,
        "# TYPE signify_http_request_duration_milliseconds histogram",
        ...DURATION_BUCKETS.map(
          (boundary) =>
            `signify_http_request_duration_milliseconds_bucket{le="${boundary}"} ${counters.durationBuckets[boundary]}`,
        ),
        `signify_http_request_duration_milliseconds_bucket{le="+Inf"} ${data.requests}`,
        `signify_http_request_duration_milliseconds_sum ${counters.durationMs}`,
        `signify_http_request_duration_milliseconds_count ${data.requests}`,
        "# TYPE signify_background_jobs gauge",
        ...Object.entries(data.jobs).map(([name, value]) =>
          name === "oldestQueuedSeconds"
            ? `signify_background_job_oldest_queued_seconds ${value}`
            : `signify_background_jobs{status="${metricName(name)}"} ${value}`,
        ),
        "# TYPE signify_provider_errors gauge",
        ...Object.entries(data.providers).map(
          ([name, value]) =>
            `signify_provider_errors{provider="${metricName(name.replace(/Errors$/, ""))}"} ${value}`,
        ),
        `signify_process_resident_memory_bytes ${data.process.residentMemoryBytes}`,
        `signify_process_heap_used_bytes ${data.process.heapUsedBytes}`,
        `signify_process_uptime_seconds ${data.process.uptimeSeconds}`,
      ];
    return `${lines.join("\n")}\n`;
  }

  function evaluateAlerts() {
    const now = Date.now();
    if (now - lastAlertAt < config.observability.alertCooldownMs) return [];
    const data = snapshot(),
      alerts = [];
    if (
      data.requests >= config.observability.minimumRequestSample &&
      data.errors / data.requests >= config.observability.errorRateThreshold
    )
      alerts.push({
        code: "HTTP_ERROR_RATE",
        severity: "critical",
        value: data.errors / data.requests,
      });
    if (data.jobs.deadLettered > 0)
      alerts.push({
        code: "DEAD_LETTERED_JOBS",
        severity: "critical",
        value: data.jobs.deadLettered,
      });
    if (
      data.jobs.oldestQueuedSeconds >=
      config.observability.queueAgeThresholdSeconds
    )
      alerts.push({
        code: "QUEUE_AGE",
        severity: "warning",
        value: data.jobs.oldestQueuedSeconds,
      });
    if (data.providers.microsoftErrors > 0)
      alerts.push({
        code: "MICROSOFT_FAILURES",
        severity: "warning",
        value: data.providers.microsoftErrors,
      });
    if (data.providers.stripeErrors > 0)
      alerts.push({
        code: "STRIPE_FAILURES",
        severity: "warning",
        value: data.providers.stripeErrors,
      });
    if (alerts.length) {
      lastAlertAt = now;
      for (const alert of alerts)
        log(
          alert.severity === "critical" ? "error" : "warn",
          "operational.alert",
          alert,
        );
    }
    return alerts;
  }

  async function flush() {
    if (flushing || !pending.length || !config.observability?.endpoint) return;
    flushing = true;
    const batch = pending.splice(0, config.observability.batchSize);
    try {
      const response = await fetchImpl(config.observability.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.observability.token
            ? { Authorization: `Bearer ${config.observability.token}` }
            : {}),
        },
        body: JSON.stringify({
          resource: { service: config.observability.service },
          events: batch,
        }),
        signal: AbortSignal.timeout(config.observability.timeoutMs),
      });
      if (!response.ok)
        throw new Error(`Exporter returned HTTP ${response.status}.`);
    } catch (error) {
      pending.unshift(...batch);
      if (pending.length > config.observability.maxBuffer) {
        dropped += pending.length - config.observability.maxBuffer;
        pending.length = config.observability.maxBuffer;
      }
      output.error(
        JSON.stringify(
          clean({
            time: new Date().toISOString(),
            level: "error",
            event: "observability.export_failed",
            message: error.message,
          }),
        ),
      );
    } finally {
      flushing = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      evaluateAlerts();
      void flush();
    }, config.observability.flushIntervalMs);
    timer.unref();
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    let previous = pending.length;
    while (pending.length) {
      await flush();
      if (pending.length >= previous) break;
      previous = pending.length;
    }
  }

  return Object.freeze({
    evaluateAlerts,
    flush,
    log,
    prometheus,
    recordRequest,
    snapshot,
    start,
    stop,
    traceContext,
  });
}

module.exports = { clean, createObservability, traceContext };
