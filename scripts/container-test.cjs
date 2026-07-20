"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../server/config.cjs");
const { diagnose } = require("./doctor.cjs");
const { migrate } = require("./migrate.cjs");
const { checkWorkerHealth } = require("./worker-health.cjs");

const root = path.join(__dirname, ".."),
  dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8"),
  compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8"),
  example = fs.readFileSync(path.join(root, ".env.container.example"), "utf8"),
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "signify-container-"));

try {
  assert.match(dockerfile, /^FROM node:24-bookworm-slim AS runtime$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(
    dockerfile,
    /COPY --from=builder --chown=node:node \/build\/dist\//,
  );
  for (const contract of [
    "read_only: true",
    "no-new-privileges:true",
    "cap_drop:",
    "SIGNIFY_JOB_MODE: external",
    "condition: service_healthy",
    "profiles: [tools]",
    '"127.0.0.1:${SIGNIFY_PORT:-4173}:4173"',
    'test: ["CMD", "node", "scripts/worker-health.cjs"]',
    "SIGNIFY_WORKER_HEALTH_PATH: /tmp/signify-worker-health.json",
  ])
    assert.ok(compose.includes(contract), `Compose is missing: ${contract}`);
  assert.doesNotMatch(example, /^SIGNIFY_CREDENTIAL_ENCRYPTION_KEY=.+$/m);
  assert.doesNotMatch(example, /^SIGNIFY_BOOTSTRAP_PASSWORD=.+$/m);

  const heartbeatPath = path.join(temporary, "worker-health.json"),
    healthEnv = {
      SIGNIFY_WORKER_HEALTH_PATH: heartbeatPath,
      SIGNIFY_WORKER_HEALTH_MAX_AGE_SECONDS: "45",
    };
  fs.writeFileSync(
    heartbeatPath,
    JSON.stringify({ status: "ready", updatedAt: new Date().toISOString() }),
  );
  assert.equal(checkWorkerHealth(healthEnv).status, "ready");
  fs.writeFileSync(
    heartbeatPath,
    JSON.stringify({
      status: "ready",
      updatedAt: new Date(Date.now() - 60000).toISOString(),
    }),
  );
  assert.throws(() => checkWorkerHealth(healthEnv), /stale/);

  const config = loadConfig(
      {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "4173",
        DATABASE_PATH: path.join(temporary, "data", "signify.db"),
        BACKUP_DIR: path.join(temporary, "backups"),
        SIGNIFY_PUBLIC_URL: "https://container.example.test",
        SIGNIFY_APPLICATION_OWNER_EMAIL: "owner@container.example.test",
        SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString(
          "base64",
        ),
        SIGNATURE_ALLOW_DEFAULT_ADMIN: "false",
      },
      root,
    ),
    migration = migrate(config),
    diagnosis = diagnose(config);
  assert.ok(migration.applied.length >= 22);
  assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));
  assert.equal(
    diagnosis.checks.find((item) => item.id === "database").ok,
    true,
  );
  console.log(
    "Container tests passed: immutable non-root image, hardened Compose topology, setup/migration tools, and offline diagnostics",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
