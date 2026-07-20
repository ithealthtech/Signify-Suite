"use strict";

const { loadConfig } = require("./server/config.cjs");
const { openDatabase } = require("./server/database.cjs");
const { startJobWorker } = require("./server/job-queue.cjs");
const { createMediaStorage } = require("./server/media-storage.cjs");

function startWorker(options = {}) {
  const config = options.config || loadConfig(),
    db = options.db || openDatabase(config.databasePath),
    mediaStorage =
      options.mediaStorage ||
      createMediaStorage(config, { s3Client: options.s3Client }),
    jobs = startJobWorker(db, {
      publicRoot: config.publicRoot,
      mediaStorage,
      ...(options.jobOptions || {}),
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
  return { config, db, jobs, mediaStorage, stop };
}

if (require.main === module) startWorker();
module.exports = { startWorker };
