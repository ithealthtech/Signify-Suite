"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { clearInterval, setInterval } = require("node:timers");
const { loadConfig } = require("./server/config.cjs");
const { startJobWorker } = require("./server/job-queue.cjs");
const { createApplication } = require("./server.cjs");

function startWorker(options = {}) {
  const config = options.config || loadConfig(),
    application =
      options.application ||
      createApplication({
        config,
        db: options.db,
        fetchImpl: options.fetchImpl,
        mediaStorage: options.mediaStorage,
        s3Client: options.s3Client,
        skipPendingRestore: true,
        stripeFactory: options.stripeFactory,
      }),
    { db, mediaStorage, observability } = application,
    jobOptions = options.jobOptions || {},
    jobs = startJobWorker(db, {
      publicRoot: config.publicRoot,
      mediaStorage,
      ...jobOptions,
      handlers: {
        ...application.jobHandlers,
        ...(jobOptions.handlers || {}),
      },
    });
  let heartbeatTimer;
  function writeHeartbeat() {
    if (!config.workerHealthPath) return;
    const target = path.resolve(config.workerHealthPath),
      temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(
        temporary,
        `${JSON.stringify({
          status: "ready",
          pid: process.pid,
          mode: config.jobMode,
          updatedAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      fs.renameSync(temporary, target);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {}
      observability.log("error", "worker.heartbeat_failed", {
        error: error.message,
      });
    }
  }
  observability.start();
  observability.log("info", "worker.started", { mode: config.jobMode });
  if (config.workerHealthPath) {
    writeHeartbeat();
    heartbeatTimer = setInterval(
      writeHeartbeat,
      config.workerHeartbeatMs || 10000,
    );
    heartbeatTimer.unref();
  }
  let stopping = false;
  async function stop(signal = "shutdown") {
    if (stopping) return;
    stopping = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await jobs.stop();
    observability.log("info", "worker.stopped", { signal });
    await observability.stop();
    db.close();
    if (config.workerHealthPath)
      fs.rmSync(path.resolve(config.workerHealthPath), { force: true });
  }
  if (options.signals !== false) {
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  }
  return { application, config, db, jobs, mediaStorage, stop };
}

function installFatalHandlers(observability = null) {
  let exiting = false;
  function fatal(kind, error) {
    const payload = {
      code: error?.code || "FATAL_ERROR",
      message: error?.message || String(error),
      stack: error?.stack,
    };
    if (observability) observability.log("error", `process.${kind}`, payload);
    else
      process.stderr.write(
        `${JSON.stringify({
          level: "error",
          event: `process.${kind}`,
          ...payload,
        })}\n`,
      );
    process.exitCode = 1;
    if (!exiting) {
      exiting = true;
      setTimeout(() => process.exit(1), 250).unref();
    }
  }
  process.on("uncaughtException", (error) =>
    fatal("uncaught_exception", error),
  );
  process.on("unhandledRejection", (reason) =>
    fatal(
      "unhandled_rejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    ),
  );
}

if (require.main === module) {
  let started;
  try {
    started = startWorker();
    installFatalHandlers(started.application.observability);
  } catch (error) {
    installFatalHandlers();
    throw error;
  }
}
module.exports = { startWorker };
