"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseEnv } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { detectEnvironment, validateNodeVersion } = require("./setup.cjs");

const root = path.join(__dirname, ".."),
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "signify-setup-test-")),
  environmentFile = path.join(temporary, ".env.local"),
  databasePath = path.join(temporary, "data", "signify.db"),
  backupDirectory = path.join(temporary, "backups"),
  baseEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "4199",
    SIGNIFY_JOB_MODE: "external",
    SIGNIFY_MEDIA_STORAGE: "local",
    DATABASE_PATH: databasePath,
    BACKUP_DIR: backupDirectory,
    SIGNIFY_PUBLIC_URL: "https://setup.example.com",
    SIGNIFY_ASSET_BASE_URL: "https://setup.example.com",
    SIGNIFY_MEDIA_BASE_URL: "https://setup.example.com",
    SIGNIFY_COMPANY_NAME: "Setup Test",
    SIGNIFY_BOOTSTRAP_EMAIL: "owner@setup.example.com",
    SIGNIFY_APPLICATION_OWNER_EMAIL: "owner@setup.example.com",
    SIGNIFY_BOOTSTRAP_PASSWORD: "InstallerRegression123!",
    SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: "",
  };

function run(extraEnvironment = {}, extraArguments = []) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts", "setup.cjs"),
      "--non-interactive",
      "--config-file",
      environmentFile,
      ...extraArguments,
    ],
    {
      cwd: root,
      env: { ...baseEnvironment, ...extraEnvironment },
      encoding: "utf8",
    },
  );
}

try {
  assert.throws(() => validateNodeVersion("22.12.0"), /22\.13\.0 or newer/);
  assert.doesNotThrow(() => validateNodeVersion("22.13.0"));
  assert.doesNotThrow(() => validateNodeVersion("24.0.0"));

  const localDetection = detectEnvironment({}, temporary);
  assert.equal(localDetection.HOST, "127.0.0.1");
  assert.equal(localDetection.PORT, "4173");
  assert.equal(
    localDetection.DATABASE_PATH,
    path.join(temporary, "data", "signify-creator.db"),
  );
  assert.equal(localDetection.BACKUP_DIR, path.join(temporary, "backups"));

  const volume = path.join(temporary, "persistent-volume"),
    hostedDetection = detectEnvironment(
      {
        PORT: "8080",
        WEBSITE_HOSTNAME: "signify.examplehost.com",
        SIGNIFY_STORAGE_ROOT: volume,
      },
      temporary,
    );
  assert.equal(hostedDetection.HOST, "0.0.0.0");
  assert.equal(hostedDetection.PORT, "8080");
  assert.equal(hostedDetection.TRUST_PROXY, "true");
  assert.equal(
    hostedDetection.SIGNIFY_PUBLIC_URL,
    "https://signify.examplehost.com",
  );
  assert.equal(
    hostedDetection.DATABASE_PATH,
    path.join(volume, "data", "signify-creator.db"),
  );
  assert.equal(hostedDetection.BACKUP_DIR, path.join(volume, "backups"));

  const explicitDatabase = path.join(temporary, "custom", "database.db"),
    explicitDetection = detectEnvironment(
      {
        DATABASE_PATH: explicitDatabase,
        BACKUP_DIR: path.join(temporary, "custom-backups"),
        HOST: "10.0.0.8",
        PORT: "9000",
        SIGNIFY_PUBLIC_URL: "https://explicit.example.com/",
      },
      temporary,
    );
  assert.equal(explicitDetection.DATABASE_PATH, explicitDatabase);
  assert.equal(explicitDetection.HOST, "10.0.0.8");
  assert.equal(explicitDetection.PORT, "9000");
  assert.equal(
    explicitDetection.SIGNIFY_PUBLIC_URL,
    "https://explicit.example.com",
  );

  let result = run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Signify Creator setup complete/);
  assert.match(result.stdout, /Initial password: InstallerRegression123!/);
  assert.ok(fs.existsSync(environmentFile));
  assert.ok(fs.existsSync(databasePath));

  const configured = parseEnv(fs.readFileSync(environmentFile, "utf8"));
  assert.equal(configured.SIGNATURE_ALLOW_DEFAULT_ADMIN, "false");
  assert.equal(configured.SIGNIFY_JOB_MODE, "external");
  assert.equal(configured.SIGNIFY_MEDIA_STORAGE, "local");
  assert.equal(configured.SIGNIFY_BOOTSTRAP_PASSWORD || "", "");
  assert.equal(
    configured.SIGNIFY_APPLICATION_OWNER_EMAIL,
    baseEnvironment.SIGNIFY_APPLICATION_OWNER_EMAIL,
  );
  assert.equal(
    Buffer.from(configured.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY, "base64").length,
    32,
  );

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT COUNT(*) count FROM signature_users").get().count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) count FROM application_owners").get().count,
      1,
    );
  } finally {
    db.close();
  }

  fs.appendFileSync(environmentFile, 'SIGNIFY_FUTURE_SETTING="preserve-me"\n');
  result = run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /Initial password:/);
  assert.equal(
    parseEnv(fs.readFileSync(environmentFile, "utf8")).SIGNIFY_FUTURE_SETTING,
    "preserve-me",
  );
  assert.ok(
    fs
      .readdirSync(temporary)
      .some((name) => name.startsWith(".env.local.backup-")),
  );

  const invalidDirectory = path.join(temporary, "invalid");
  fs.mkdirSync(invalidDirectory);
  result = run(
    {
      SIGNIFY_PUBLIC_URL: "http://insecure.example.com",
      DATABASE_PATH: path.join(invalidDirectory, "invalid.db"),
    },
    ["--no-write-env"],
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTPS URL/);
  assert.equal(fs.existsSync(path.join(invalidDirectory, "invalid.db")), false);

  console.log(
    "Setup test passed: configuration generation, credential generation, migrations, owner bootstrap, rerun safety, backups, and production validation",
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
