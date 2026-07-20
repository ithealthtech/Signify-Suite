"use strict";

const { loadConfig } = require("./server/config.cjs");
const { openDatabase } = require("./server/database.cjs");
const { startJobWorker } = require("./server/job-queue.cjs");

function startWorker(options = {}) {
  const config = options.config || loadConfig(),
    db = options.db || openDatabase(config.databasePath),
    jobs = startJobWorker(db, {
      publicRoot: config.publicRoot,
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
  return { config, db, jobs, stop };
}

if (require.main === module) startWorker();
module.exports = { startWorker };
