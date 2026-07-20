"use strict";

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
    { db, mediaStorage } = application,
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
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      event: "worker.started",
      mode: config.jobMode,
    }),
  );
  let stopping = false;
  async function stop(signal = "shutdown") {
    if (stopping) return;
    stopping = true;
    await jobs.stop();
    db.close();
    console.log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: "info",
        event: "worker.stopped",
        signal,
      }),
    );
  }
  if (options.signals !== false) {
    process.once("SIGINT", () => void stop("SIGINT"));
    process.once("SIGTERM", () => void stop("SIGTERM"));
  }
  return { application, config, db, jobs, mediaStorage, stop };
}

if (require.main === module) startWorker();
module.exports = { startWorker };
