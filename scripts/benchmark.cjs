"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { spawnSync } = require("node:child_process");
const { createApplication } = require("../server.cjs");

const root = path.join(__dirname, ".."),
  reportPath = path.join(root, "docs", "performance-current.json");

function fileMetrics(relativePaths) {
  return relativePaths.map((relativePath) => {
    const contents = fs.readFileSync(path.join(root, relativePath), "utf8");
    return {
      path: relativePath.replaceAll(path.sep, "/"),
      bytes: Buffer.byteLength(contents),
      lines: contents.split(/\r?\n/).length,
    };
  });
}

function directoryBytes(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .reduce((total, entry) => {
      const target = path.join(directory, entry.name);
      return (
        total +
        (entry.isDirectory()
          ? directoryBytes(target)
          : fs.statSync(target).size)
      );
    }, 0);
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right),
    index = Math.min(
      sorted.length - 1,
      Math.ceil(sorted.length * percentage) - 1,
    );
  return Number(sorted[index].toFixed(3));
}

function timedCommand(command, args) {
  const started = performance.now(),
    result = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
    });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  return Number((performance.now() - started).toFixed(3));
}

function dependencyCount() {
  const lock = JSON.parse(
    fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
  );
  return Object.entries(lock.packages).filter(
    ([location, metadata]) => location && !metadata.dev,
  ).length;
}

async function runtimeMetrics() {
  const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-benchmark-"),
    ),
    databasePath = path.join(tempDirectory, "benchmark.db"),
    started = performance.now(),
    application = createApplication({
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        SIGNATURE_ALLOW_DEFAULT_ADMIN: "true",
        SIGNIFY_BOOTSTRAP_EMAIL: "benchmark@signify.local",
        SIGNIFY_BOOTSTRAP_PASSWORD: "BenchmarkOnly123!",
        SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString(
          "base64",
        ),
        LOG_LEVEL: "silent",
      },
    }),
    initializationMs = performance.now() - started,
    server = http.createServer(application.handler);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`,
      samples = [];
    await fetch(`${baseUrl}/api/health`);
    for (let index = 0; index < 100; index += 1) {
      const requestStarted = performance.now(),
        response = await fetch(`${baseUrl}/api/health`);
      if (!response.ok)
        throw new Error(`Health benchmark returned ${response.status}.`);
      await response.arrayBuffer();
      samples.push(performance.now() - requestStarted);
    }
    return {
      initializationMs: Number(initializationMs.toFixed(3)),
      healthRequests: samples.length,
      healthLatencyMs: {
        min: Number(Math.min(...samples).toFixed(3)),
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
        max: Number(Math.max(...samples).toFixed(3)),
      },
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.db.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const testDurationsMs = {
      setup: timedCommand(process.execPath, ["scripts/setup-test.cjs"]),
      smoke: timedCommand(process.execPath, ["scripts/smoke-test.cjs"]),
      build: timedCommand(process.execPath, ["scripts/build.cjs"]),
    },
    sourceFiles = fileMetrics([
      "server.cjs",
      "server/access-control.cjs",
      "server/auth-security.cjs",
      "server/http-responses.cjs",
      "server/signature-portal.cjs",
      "server/templates.cjs",
      "server/validation.cjs",
      "admin.js",
      "platform.js",
      "signature.js",
      "signify-shared.js",
      "admin.css",
      "platform.css",
      "signature.css",
      "signify-shared.css",
      "signify-app.css",
      "scripts/smoke-test.cjs",
      "scripts/unit-test.cjs",
    ]),
    report = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      source: {
        measuredBytes: sourceFiles.reduce(
          (total, file) => total + file.bytes,
          0,
        ),
        files: sourceFiles,
      },
      production: {
        artifactBytes: directoryBytes(path.join(root, "dist")),
        dependencyCount: dependencyCount(),
      },
      tests: { durationMs: testDurationsMs },
      server: await runtimeMetrics(),
    };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Performance baseline written to ${reportPath}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
