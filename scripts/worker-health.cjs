"use strict";

const fs = require("node:fs");
const path = require("node:path");

function checkWorkerHealth(env = process.env, now = Date.now()) {
  const healthPath = path.resolve(
      String(
        env.SIGNIFY_WORKER_HEALTH_PATH || "/tmp/signify-worker-health.json",
      ),
    ),
    maxAgeSeconds = Number(env.SIGNIFY_WORKER_HEALTH_MAX_AGE_SECONDS || 45);
  if (
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 10 ||
    maxAgeSeconds > 900
  )
    throw new Error(
      "SIGNIFY_WORKER_HEALTH_MAX_AGE_SECONDS must be an integer from 10 to 900.",
    );
  const heartbeat = JSON.parse(fs.readFileSync(healthPath, "utf8")),
    updatedAt = Date.parse(heartbeat.updatedAt),
    ageMs = now - updatedAt;
  if (
    heartbeat.status !== "ready" ||
    !Number.isFinite(updatedAt) ||
    ageMs < -5000 ||
    ageMs > maxAgeSeconds * 1000
  )
    throw new Error("Worker heartbeat is invalid or stale.");
  return { ...heartbeat, ageMs };
}

if (require.main === module) {
  try {
    checkWorkerHealth();
  } catch (error) {
    console.error(`Worker health check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { checkWorkerHealth };
