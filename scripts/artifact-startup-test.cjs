"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, ".."),
  artifact = process.env.SIGNIFY_BUILD_DIR
    ? path.resolve(root, process.env.SIGNIFY_BUILD_DIR)
    : path.join(root, "dist"),
  runtime = fs.mkdtempSync(path.join(os.tmpdir(), "signify-artifact-boot-"));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForReady(url, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Artifact exited before readiness.\n${output.value}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Artifact did not become ready.\n${output.value}`);
}

async function main() {
  assert.ok(fs.existsSync(path.join(artifact, "manifest.json")));
  const port = await freePort(),
    output = { value: "" },
    child = spawn(process.execPath, ["server.cjs"], {
      cwd: artifact,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        LOG_LEVEL: "silent",
        DATABASE_PATH: path.join(runtime, "data", "signify.db"),
        BACKUP_DIR: path.join(runtime, "backups"),
        SIGNATURE_ALLOW_DEFAULT_ADMIN: "false",
        SIGNIFY_PUBLIC_URL: "https://artifact.example.test",
        SIGNIFY_APPLICATION_OWNER_EMAIL: "owner@artifact.example.test",
        SIGNIFY_CREDENTIAL_ENCRYPTION_KEY:
          "9a3c4e5f60718293a4b5c6d7e8f901129a3c4e5f60718293a4b5c6d7e8f90112",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  child.stdout.on("data", (chunk) => (output.value += chunk));
  child.stderr.on("data", (chunk) => (output.value += chunk));
  try {
    const ready = await waitForReady(
      `http://127.0.0.1:${port}/api/ready`,
      child,
      output,
    );
    assert.equal(ready.status, "setup_required");
    assert.equal(ready.setupRequired, true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(artifact, "manifest.json"), "utf8"),
    );
    assert.equal(ready.version, manifest.version);
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
    console.log(
      `Artifact startup test passed: version ${manifest.version}, first-run setup readiness confirmed`,
    );
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    fs.rmSync(runtime, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fs.rmSync(runtime, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
