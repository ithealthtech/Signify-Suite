"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseEnv } = require("node:util");
const { createInterface } = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { loadConfig, bool } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");
const { createApplication } = require("../server.cjs");

const root = path.join(__dirname, ".."),
  defaults = {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "4173",
    TRUST_PROXY: "true",
    LOG_LEVEL: "info",
    DATABASE_PATH: path.join(root, "data", "signify-creator.db"),
    BACKUP_DIR: path.join(root, "backups"),
    SIGNATURE_SESSION_HOURS: "12",
    SIGNATURE_ALLOW_DEFAULT_ADMIN: "true",
    SIGNIFY_ALLOW_REGISTRATION: "false",
  };

function validateNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error(
      `Node.js 22.13.0 or newer is required. Current version: ${version}`,
    );
}

function argumentsFor(argv) {
  const args = {
    nonInteractive: false,
    noWriteEnv: false,
    envFile: path.join(root, ".env.local"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--non-interactive") args.nonInteractive = true;
    else if (value === "--no-write-env") args.noWriteEnv = true;
    else if (value === "--config-file") {
      const file = argv[index + 1];
      if (!file) throw new Error("--config-file requires a path.");
      args.envFile = path.resolve(file);
      index += 1;
    } else if (value === "--help" || value === "-h") args.help = true;
    else throw new Error(`Unknown setup option: ${value}`);
  }
  if (args.noWriteEnv && !args.nonInteractive)
    throw new Error("--no-write-env requires --non-interactive.");
  return args;
}

function readEnvironment(file) {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, "utf8"));
}

function environmentValue(value) {
  return JSON.stringify(String(value).replace(/[\r\n]+/g, " "));
}

function environmentFile(env, existingKeys = []) {
  const managedKeys = [
    "NODE_ENV",
    "HOST",
    "PORT",
    "TRUST_PROXY",
    "LOG_LEVEL",
    "DATABASE_PATH",
    "BACKUP_DIR",
    "SIGNATURE_SESSION_HOURS",
    "SIGNATURE_ALLOW_DEFAULT_ADMIN",
    "SIGNIFY_BOOTSTRAP_EMAIL",
    "SIGNIFY_APPLICATION_OWNER_EMAIL",
    "SIGNIFY_COMPANY_NAME",
    "SIGNIFY_PUBLIC_URL",
    "SIGNIFY_ASSET_BASE_URL",
    "SIGNIFY_MEDIA_BASE_URL",
    "SIGNIFY_ALLOW_REGISTRATION",
    "SIGNIFY_CREDENTIAL_ENCRYPTION_KEY",
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_TENANT_ID",
    "MICROSOFT_SENDER_EMAIL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_STARTER",
    "STRIPE_PRICE_TEAM",
    "STRIPE_PRICE_BUSINESS",
  ];
  const keys = [
    ...managedKeys,
    ...existingKeys.filter(
      (key) =>
        !managedKeys.includes(key) &&
        /^(SIGNIFY_|SIGNATURE_|MICROSOFT_|AZURE_|STRIPE_)/.test(key),
    ),
  ];
  return `${keys.map((key) => `${key}=${environmentValue(env[key] || "")}`).join("\n")}\n`;
}

function validateWritableDirectory(directory, label) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true });
  const probe = path.join(
    resolved,
    `.signify-write-test-${process.pid}-${Date.now()}`,
  );
  try {
    fs.writeFileSync(probe, "ok", { flag: "wx" });
  } finally {
    fs.rmSync(probe, { force: true });
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  return resolved;
}

function firstOwnerState(config) {
  if (!fs.existsSync(config.databasePath)) return { users: 0, owners: 0 };
  const db = openDatabase(config.databasePath);
  try {
    return {
      users: db.prepare("SELECT COUNT(*) count FROM signature_users").get()
        .count,
      owners: db.prepare("SELECT COUNT(*) count FROM application_owners").get()
        .count,
    };
  } finally {
    db.close();
  }
}

async function promptEnvironment(existing = {}) {
  const terminal = createInterface({ input: stdin, output: stdout });
  const ask = async (label, fallback) => {
    const answer = String(
      await terminal.question(`${label}${fallback ? ` [${fallback}]` : ""}: `),
    ).trim();
    return answer || fallback;
  };
  const required = async (label, fallback, validate, message) => {
    while (true) {
      const answer = await ask(label, fallback);
      if (validate(answer)) return answer;
      console.log(message);
    }
  };
  try {
    const ownerEmail = await required(
        "Application Owner email",
        existing.SIGNIFY_APPLICATION_OWNER_EMAIL || "",
        (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
        "Enter a valid email address.",
      ),
      companyName = await ask(
        "Company name",
        existing.SIGNIFY_COMPANY_NAME || "Signify Workspace",
      ),
      publicUrl = await required(
        "Public HTTPS URL",
        existing.SIGNIFY_PUBLIC_URL || "",
        (value) => {
          try {
            return new URL(value).protocol === "https:";
          } catch {
            return false;
          }
        },
        "Enter the public HTTPS URL for this installation.",
      ),
      databasePath = await ask(
        "Persistent database path",
        existing.DATABASE_PATH || defaults.DATABASE_PATH,
      ),
      backupDirectory = await ask(
        "Persistent backup directory",
        existing.BACKUP_DIR || defaults.BACKUP_DIR,
      ),
      host = await ask("Listen address", existing.HOST || defaults.HOST),
      port = await ask("Port", existing.PORT || defaults.PORT),
      proxyAnswer = await ask(
        "Behind a trusted reverse proxy? (yes/no)",
        bool(existing.TRUST_PROXY, true) ? "yes" : "no",
      );
    return {
      SIGNIFY_APPLICATION_OWNER_EMAIL: ownerEmail,
      SIGNIFY_BOOTSTRAP_EMAIL: ownerEmail,
      SIGNIFY_COMPANY_NAME: companyName,
      SIGNIFY_PUBLIC_URL: publicUrl,
      SIGNIFY_ASSET_BASE_URL: publicUrl,
      SIGNIFY_MEDIA_BASE_URL: publicUrl,
      DATABASE_PATH: databasePath,
      BACKUP_DIR: backupDirectory,
      HOST: host,
      PORT: port,
      TRUST_PROXY: /^(y|yes|true|1)$/i.test(proxyAnswer) ? "true" : "false",
    };
  } finally {
    terminal.close();
  }
}

async function install(options) {
  validateNodeVersion();
  const fileExists = fs.existsSync(options.envFile),
    fileEnvironment = readEnvironment(options.envFile);
  if (fileExists && !options.noWriteEnv)
    fs.copyFileSync(options.envFile, `${options.envFile}.backup-${Date.now()}`);

  const prompted = options.nonInteractive
      ? {}
      : await promptEnvironment(fileEnvironment),
    generatedPassword =
      process.env.SIGNIFY_BOOTSTRAP_PASSWORD ||
      fileEnvironment.SIGNIFY_BOOTSTRAP_PASSWORD ||
      `Signify-${randomBytes(18).toString("base64url")}!`,
    generatedKey =
      process.env.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY ||
      fileEnvironment.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY ||
      randomBytes(32).toString("base64"),
    env = {
      ...defaults,
      ...fileEnvironment,
      ...process.env,
      ...prompted,
      SIGNIFY_BOOTSTRAP_PASSWORD: generatedPassword,
      SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: generatedKey,
    };

  env.SIGNIFY_BOOTSTRAP_EMAIL =
    env.SIGNIFY_BOOTSTRAP_EMAIL || env.SIGNIFY_APPLICATION_OWNER_EMAIL;
  env.SIGNIFY_APPLICATION_OWNER_EMAIL =
    env.SIGNIFY_APPLICATION_OWNER_EMAIL || env.SIGNIFY_BOOTSTRAP_EMAIL;
  env.SIGNIFY_ASSET_BASE_URL =
    env.SIGNIFY_ASSET_BASE_URL || env.SIGNIFY_PUBLIC_URL;
  env.SIGNIFY_MEDIA_BASE_URL =
    env.SIGNIFY_MEDIA_BASE_URL || env.SIGNIFY_ASSET_BASE_URL;
  env.SIGNATURE_ALLOW_DEFAULT_ADMIN = "true";

  const config = loadConfig(env, root),
    databaseDirectory = validateWritableDirectory(
      path.dirname(config.databasePath),
      "Database directory",
    ),
    backupDirectory = validateWritableDirectory(
      env.BACKUP_DIR,
      "Backup directory",
    ),
    uploads = validateWritableDirectory(
      path.join(config.publicRoot, "uploads"),
      "Upload directory",
    ),
    generatedBanners = validateWritableDirectory(
      path.join(config.publicRoot, "generated-banners"),
      "Generated-banner directory",
    ),
    before = firstOwnerState(config);

  if (before.users > 0 && before.owners === 0)
    throw new Error(
      "The existing database has users but no Application Owner. Run npm run application:grant-owner instead of setup.",
    );

  const application = createApplication({ config });
  application.db.close();
  const after = firstOwnerState(config);
  if (after.users < 1 || after.owners < 1)
    throw new Error("Setup could not create and grant the Application Owner.");

  const finalEnvironment = {
    ...env,
    DATABASE_PATH: config.databasePath,
    BACKUP_DIR: backupDirectory,
    SIGNATURE_ALLOW_DEFAULT_ADMIN: "false",
    SIGNIFY_BOOTSTRAP_PASSWORD: "",
  };
  if (!options.noWriteEnv) {
    fs.writeFileSync(
      options.envFile,
      environmentFile(finalEnvironment, Object.keys(fileEnvironment)),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: fileExists ? "w" : "wx",
      },
    );
    if (process.platform !== "win32") fs.chmodSync(options.envFile, 0o600);
  }

  return {
    status: "ok",
    existingInstallation: before.users > 0,
    environmentFile: options.noWriteEnv ? null : options.envFile,
    databasePath: config.databasePath,
    databaseDirectory,
    backupDirectory,
    uploads,
    generatedBanners,
    publicUrl: config.signature.publicUrl,
    ownerEmail: config.signature.applicationOwnerEmail,
    initialPassword: before.users === 0 ? generatedPassword : null,
    environmentActionRequired: options.noWriteEnv,
  };
}

function printHelp() {
  console.log(`Signify Creator setup

Usage:
  npm run setup
  npm run setup -- --non-interactive
  npm run setup -- --non-interactive --no-write-env

Options:
  --non-interactive  Read configuration from environment variables
  --no-write-env     Validate host variables without writing .env.local
  --config-file PATH Write or validate a different environment file
  --help             Show this help`);
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) return printHelp();
  const result = await install(options);
  console.log("\nSignify Creator setup complete.");
  console.log(`Application Owner: ${result.ownerEmail}`);
  if (result.initialPassword)
    console.log(`Initial password: ${result.initialPassword}`);
  if (result.environmentFile)
    console.log(`Configuration: ${result.environmentFile}`);
  console.log(`Database: ${result.databasePath}`);
  console.log(`Start: npm start`);
  console.log(`Open: ${result.publicUrl}/platform.html`);
  if (result.environmentActionRequired)
    console.log(
      "Set SIGNATURE_ALLOW_DEFAULT_ADMIN=false in the hosting panel, remove SIGNIFY_BOOTSTRAP_PASSWORD, and restart after this command.",
    );
}

if (require.main === module)
  main().catch((error) => {
    console.error(`Setup failed: ${error.message}`);
    process.exitCode = 1;
  });

module.exports = {
  argumentsFor,
  environmentFile,
  install,
  validateNodeVersion,
  validateWritableDirectory,
};
