"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");
const {
  createTransactionalEmail,
} = require("../server/transactional-email.cjs");

function writable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  return true;
}

function diagnose(config = loadConfig()) {
  const checks = [];
  const check = (id, operation) => {
    try {
      const detail = operation();
      checks.push({ id, ok: true, detail });
    } catch (error) {
      checks.push({ id, ok: false, detail: error.message });
    }
  };

  check("public_url", () => {
    const url = new URL(config.signature.publicUrl);
    if (config.production && url.protocol !== "https:")
      throw new Error("Production URL must use HTTPS.");
    return url.origin;
  });
  check("database_directory", () => {
    writable(path.dirname(path.resolve(config.databasePath)));
    return path.resolve(config.databasePath);
  });
  check("backup_directory", () => {
    writable(path.resolve(config.backupPath));
    return path.resolve(config.backupPath);
  });
  check("database", () => {
    const database = openDatabase(config.databasePath);
    try {
      const integrity = database
          .prepare("PRAGMA quick_check")
          .get().quick_check,
        migrations = database
          .prepare("SELECT COUNT(*) count FROM schema_migrations")
          .get().count;
      if (integrity !== "ok") throw new Error(`Integrity result: ${integrity}`);
      return `${migrations} migrations; integrity ok`;
    } finally {
      database.close();
    }
  });
  check(
    "runtime_topology",
    () =>
      "SQLite authority; one web replica; external worker supported on the same durable volume",
  );
  check("credential_vault", () => {
    if (!config.signature.credentialEncryptionKey)
      throw new Error("Credential encryption key is not configured.");
    return "configured";
  });
  check("transactional_email", () => {
    const database = openDatabase(config.databasePath);
    try {
      const mail = createTransactionalEmail({ config, db: database }).summary();
      if (config.signature.allowRegistration && !mail.configured)
        throw new Error(
          "Public registration is enabled but transactional email is not configured.",
        );
      return mail.configured
        ? `${mail.provider} configured from ${mail.source}`
        : "not configured; public registration remains disabled";
    } finally {
      database.close();
    }
  });
  check("job_mode", () => config.jobMode);
  check("media_storage", () => config.mediaStorage);
  check("backup_storage", () => config.recovery.mode);

  return { ok: checks.every((item) => item.ok), checks };
}

if (require.main === module) {
  try {
    const result = diagnose();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Doctor failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { diagnose };
