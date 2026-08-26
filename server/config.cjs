"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { decodeKey } = require("./credential-vault.cjs");

function bool(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function httpUrl(value, name) {
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP or HTTPS URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error(`${name} must use HTTP or HTTPS.`);
  return String(value).trim().replace(/\/+$/, "");
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function bundledLicenseConfig(baseDir) {
  const file = path.join(baseDir, "server", "license-build.json");
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    throw new Error("server/license-build.json is invalid.");
  }
}

function loadConfig(env = process.env, baseDir = path.join(__dirname, "..")) {
  const production = env.NODE_ENV === "production",
    bundledLicense = bundledLicenseConfig(baseDir);
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535.");
  const sessionHours = Number(env.SIGNATURE_SESSION_HOURS || 12);
  if (!Number.isFinite(sessionHours) || sessionHours < 1 || sessionHours > 168)
    throw new Error("SIGNATURE_SESSION_HOURS must be from 1 to 168.");
  const licenseRefreshHours = Number(env.SIGNIFY_LICENSE_REFRESH_HOURS || 12);
  if (
    !Number.isFinite(licenseRefreshHours) ||
    licenseRefreshHours < 1 ||
    licenseRefreshHours > 168
  )
    throw new Error("SIGNIFY_LICENSE_REFRESH_HOURS must be from 1 to 168.");
  const workerHeartbeatSeconds = Number(
    env.SIGNIFY_WORKER_HEARTBEAT_SECONDS || 10,
  );
  if (
    !Number.isInteger(workerHeartbeatSeconds) ||
    workerHeartbeatSeconds < 5 ||
    workerHeartbeatSeconds > 300
  )
    throw new Error(
      "SIGNIFY_WORKER_HEARTBEAT_SECONDS must be an integer from 5 to 300.",
    );
  const mediaLimitMb = Number(env.SIGNIFY_TENANT_MEDIA_LIMIT_MB || 250);
  if (
    !Number.isFinite(mediaLimitMb) ||
    mediaLimitMb < 10 ||
    mediaLimitMb > 10240
  )
    throw new Error("SIGNIFY_TENANT_MEDIA_LIMIT_MB must be from 10 to 10240.");
  const deletionGraceDays = Number(env.SIGNIFY_TENANT_DELETION_GRACE_DAYS || 7);
  if (
    !Number.isInteger(deletionGraceDays) ||
    deletionGraceDays < 1 ||
    deletionGraceDays > 90
  )
    throw new Error(
      "SIGNIFY_TENANT_DELETION_GRACE_DAYS must be an integer from 1 to 90.",
    );
  const allowDefaultAdmin = bool(
      env.SIGNATURE_ALLOW_DEFAULT_ADMIN,
      !production,
    ),
    bootstrapEmail = String(
      env.SIGNIFY_BOOTSTRAP_EMAIL || "admin@signify.local",
    )
      .trim()
      .toLowerCase(),
    bootstrapPassword = String(
      env.SIGNIFY_BOOTSTRAP_PASSWORD || "SignifyDemo123!",
    ),
    publicUrl = httpUrl(
      String(env.SIGNIFY_PUBLIC_URL || "").trim(),
      "SIGNIFY_PUBLIC_URL",
    ),
    logLevel = String(env.LOG_LEVEL || "info").toLowerCase(),
    jobMode = String(env.SIGNIFY_JOB_MODE || "embedded").toLowerCase(),
    mediaStorage = String(env.SIGNIFY_MEDIA_STORAGE || "local").toLowerCase();
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel))
    throw new Error("LOG_LEVEL must be debug, info, warn, error, or silent.");
  if (!["embedded", "external"].includes(jobMode))
    throw new Error("SIGNIFY_JOB_MODE must be embedded or external.");
  if (!["local", "s3"].includes(mediaStorage))
    throw new Error("SIGNIFY_MEDIA_STORAGE must be local or s3.");
  const s3 = {
    bucket: String(env.S3_BUCKET || "").trim(),
    region: String(env.S3_REGION || "us-east-1").trim(),
    endpoint: httpUrl(String(env.S3_ENDPOINT || "").trim(), "S3_ENDPOINT"),
    forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
    accessKeyId: String(env.S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.S3_SECRET_ACCESS_KEY || "").trim(),
  };
  if (mediaStorage === "s3" && (!s3.bucket || !s3.region))
    throw new Error(
      "S3_BUCKET and S3_REGION are required for S3 media storage.",
    );
  if (Boolean(s3.accessKeyId) !== Boolean(s3.secretAccessKey))
    throw new Error(
      "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together.",
    );
  const backupStorage = String(
      env.SIGNIFY_BACKUP_STORAGE || "local",
    ).toLowerCase(),
    backupAccessKeyId = String(env.BACKUP_S3_ACCESS_KEY_ID || "").trim(),
    backupSecretAccessKey = String(
      env.BACKUP_S3_SECRET_ACCESS_KEY || "",
    ).trim(),
    backupPrefix = String(env.BACKUP_S3_PREFIX || "signify-recovery")
      .trim()
      .replace(/^\/+|\/+$/g, ""),
    backupRetentionDays = Number(env.SIGNIFY_BACKUP_RETENTION_DAYS || 30),
    backupMinimumCopies = Number(env.SIGNIFY_BACKUP_MINIMUM_COPIES || 7);
  if (!["local", "s3"].includes(backupStorage))
    throw new Error("SIGNIFY_BACKUP_STORAGE must be local or s3.");
  if (
    !Number.isInteger(backupRetentionDays) ||
    backupRetentionDays < 1 ||
    backupRetentionDays > 3650
  )
    throw new Error("SIGNIFY_BACKUP_RETENTION_DAYS must be from 1 to 3650.");
  if (
    !Number.isInteger(backupMinimumCopies) ||
    backupMinimumCopies < 1 ||
    backupMinimumCopies > 365
  )
    throw new Error("SIGNIFY_BACKUP_MINIMUM_COPIES must be from 1 to 365.");
  if (backupStorage === "s3" && !String(env.BACKUP_S3_BUCKET || "").trim())
    throw new Error("BACKUP_S3_BUCKET is required for S3 backup storage.");
  if (Boolean(backupAccessKeyId) !== Boolean(backupSecretAccessKey))
    throw new Error(
      "BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY must be configured together.",
    );
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,199}$/.test(backupPrefix))
    throw new Error("BACKUP_S3_PREFIX contains unsupported characters.");
  if (allowDefaultAdmin && !validEmail(bootstrapEmail))
    throw new Error("SIGNIFY_BOOTSTRAP_EMAIL must be a valid email address.");
  if (allowDefaultAdmin && bootstrapPassword.length < 10)
    throw new Error(
      "SIGNIFY_BOOTSTRAP_PASSWORD must be at least 10 characters.",
    );
  if (
    production &&
    allowDefaultAdmin &&
    bootstrapPassword === "SignifyDemo123!"
  )
    throw new Error(
      "Set a unique SIGNIFY_BOOTSTRAP_PASSWORD before enabling the production bootstrap administrator.",
    );
  if (production && (!publicUrl || !publicUrl.startsWith("https://")))
    throw new Error(
      "SIGNIFY_PUBLIC_URL must be configured with an HTTPS URL in production.",
    );
  const applicationOwnerEmail = String(
      env.SIGNIFY_APPLICATION_OWNER_EMAIL || bootstrapEmail,
    )
      .trim()
      .toLowerCase(),
    microsoftTenantId = String(
      env.MICROSOFT_TENANT_ID || env.AZURE_TENANT_ID || "",
    ).trim(),
    microsoft = [
      env.MICROSOFT_CLIENT_ID || env.AZURE_CLIENT_ID,
      env.MICROSOFT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET,
    ].filter(Boolean);
  if (production && microsoft.length > 0 && microsoft.length < 2)
    throw new Error(
      "Microsoft integration requires MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET together.",
    );
  if (!validEmail(applicationOwnerEmail))
    throw new Error(
      "SIGNIFY_APPLICATION_OWNER_EMAIL must be a valid email address.",
    );
  const microsoftSenderEmail = String(env.MICROSOFT_SENDER_EMAIL || "")
    .trim()
    .toLowerCase();
  if (microsoftSenderEmail && !validEmail(microsoftSenderEmail))
    throw new Error("MICROSOFT_SENDER_EMAIL must be a valid email address.");
  if (
    production &&
    (microsoftTenantId || microsoftSenderEmail) &&
    microsoft.length !== 2
  )
    throw new Error(
      "Legacy Microsoft tenant or sender settings require complete Microsoft integration credentials.",
    );
  if (microsoftSenderEmail && !microsoftTenantId)
    throw new Error(
      "MICROSOFT_SENDER_EMAIL requires MICROSOFT_TENANT_ID for system mail.",
    );
  const stripeSecretKey = String(env.STRIPE_SECRET_KEY || "").trim(),
    stripeWebhookSecret = String(env.STRIPE_WEBHOOK_SECRET || "").trim(),
    stripePrices = {
      starter: String(env.STRIPE_PRICE_STARTER || "").trim(),
      team: String(env.STRIPE_PRICE_TEAM || "").trim(),
      business: String(env.STRIPE_PRICE_BUSINESS || "").trim(),
    },
    stripeConfigured = Boolean(
      stripeSecretKey ||
      stripeWebhookSecret ||
      Object.values(stripePrices).some(Boolean),
    );
  if (
    production &&
    stripeConfigured &&
    (!stripeSecretKey ||
      !stripeWebhookSecret ||
      !Object.values(stripePrices).some(Boolean))
  )
    throw new Error(
      "Stripe integration requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and at least one Stripe price.",
    );
  const credentialEncryptionKey = String(
    env.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY || "",
  ).trim();
  const setupToken = String(env.SIGNIFY_SETUP_TOKEN || "").trim();
  if (setupToken && setupToken.length < 32)
    throw new Error("SIGNIFY_SETUP_TOKEN must be at least 32 characters.");
  if (production && !credentialEncryptionKey)
    throw new Error(
      "SIGNIFY_CREDENTIAL_ENCRYPTION_KEY is required in production.",
    );
  if (credentialEncryptionKey) decodeKey(credentialEncryptionKey);
  const observabilityEndpoint = httpUrl(
      String(env.SIGNIFY_OBSERVABILITY_ENDPOINT || "").trim(),
      "SIGNIFY_OBSERVABILITY_ENDPOINT",
    ),
    observabilityNumber = (
      name,
      fallback,
      minimum,
      maximum,
      integer = false,
    ) => {
      const value = Number(env[name] || fallback);
      if (
        !Number.isFinite(value) ||
        (integer && !Number.isInteger(value)) ||
        value < minimum ||
        value > maximum
      )
        throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
      return value;
    };
  if (
    production &&
    observabilityEndpoint &&
    !observabilityEndpoint.startsWith("https://")
  )
    throw new Error(
      "SIGNIFY_OBSERVABILITY_ENDPOINT must use HTTPS in production.",
    );
  if (
    observabilityEndpoint &&
    (new URL(observabilityEndpoint).username ||
      new URL(observabilityEndpoint).password)
  )
    throw new Error(
      "SIGNIFY_OBSERVABILITY_ENDPOINT must not contain URL credentials.",
    );
  return {
    production,
    port,
    host: env.HOST || "127.0.0.1",
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel,
    jobMode,
    workerHealthPath: String(env.SIGNIFY_WORKER_HEALTH_PATH || "").trim(),
    workerHeartbeatMs: workerHeartbeatSeconds * 1000,
    mediaStorage,
    deletionGraceDays,
    observability: {
      endpoint: observabilityEndpoint,
      token: String(env.SIGNIFY_OBSERVABILITY_TOKEN || "").trim(),
      service: String(env.SIGNIFY_SERVICE_NAME || "signify-creator").trim(),
      environment: String(
        env.SIGNIFY_ENVIRONMENT || (production ? "production" : "development"),
      ).trim(),
      batchSize: observabilityNumber(
        "SIGNIFY_OBSERVABILITY_BATCH_SIZE",
        100,
        1,
        500,
        true,
      ),
      maxBuffer: observabilityNumber(
        "SIGNIFY_OBSERVABILITY_MAX_BUFFER",
        1000,
        100,
        10000,
        true,
      ),
      flushIntervalMs: observabilityNumber(
        "SIGNIFY_OBSERVABILITY_FLUSH_MS",
        5000,
        1000,
        60000,
        true,
      ),
      timeoutMs: observabilityNumber(
        "SIGNIFY_OBSERVABILITY_TIMEOUT_MS",
        5000,
        500,
        30000,
        true,
      ),
      minimumRequestSample: observabilityNumber(
        "SIGNIFY_ALERT_MIN_REQUESTS",
        20,
        1,
        10000,
        true,
      ),
      errorRateThreshold: observabilityNumber(
        "SIGNIFY_ALERT_ERROR_RATE",
        0.05,
        0.001,
        1,
      ),
      queueAgeThresholdSeconds: observabilityNumber(
        "SIGNIFY_ALERT_QUEUE_AGE_SECONDS",
        300,
        30,
        86400,
        true,
      ),
      alertCooldownMs:
        observabilityNumber(
          "SIGNIFY_ALERT_COOLDOWN_SECONDS",
          300,
          30,
          86400,
          true,
        ) * 1000,
    },
    recovery: {
      mode: backupStorage,
      retentionDays: backupRetentionDays,
      minimumCopies: backupMinimumCopies,
      bucket: String(env.BACKUP_S3_BUCKET || "").trim(),
      region: String(env.BACKUP_S3_REGION || "us-east-1").trim(),
      endpoint: httpUrl(
        String(env.BACKUP_S3_ENDPOINT || "").trim(),
        "BACKUP_S3_ENDPOINT",
      ),
      prefix: backupPrefix,
      forcePathStyle: bool(env.BACKUP_S3_FORCE_PATH_STYLE, false),
      includeLocalMedia: bool(env.SIGNIFY_BACKUP_INCLUDE_LOCAL_MEDIA, true),
      accessKeyId: backupAccessKeyId,
      secretAccessKey: backupSecretAccessKey,
    },
    s3,
    sourceRoot: baseDir,
    publicRoot: path.join(baseDir, "public"),
    databasePath:
      env.DATABASE_PATH || path.join(baseDir, "data", "signify-creator.db"),
    backupPath: env.BACKUP_DIR || path.join(baseDir, "backups"),
    updateRepository: String(
      env.SIGNIFY_UPDATE_REPOSITORY || "ithealthtech/Signify-Suite",
    ).trim(),
    updateGithubToken: String(env.SIGNIFY_UPDATE_GITHUB_TOKEN || "").trim(),
    licensePublicKey: String(
      env.SIGNIFY_LICENSE_PUBLIC_KEY || bundledLicense.publicKey || "",
    ).trim(),
    licenseAuthorityUrl: httpUrl(
      String(
        env.SIGNIFY_LICENSE_AUTHORITY_URL || bundledLicense.authorityUrl || "",
      ).trim(),
      "SIGNIFY_LICENSE_AUTHORITY_URL",
    ),
    licenseRefreshIntervalMs: licenseRefreshHours * 60 * 60 * 1000,
    setup: { token: setupToken },
    signature: {
      sessionHours,
      mediaLimitBytes: Math.floor(mediaLimitMb * 1024 * 1024),
      allowDefaultAdmin,
      bootstrapEmail,
      bootstrapPassword,
      companyName: String(
        env.SIGNIFY_COMPANY_NAME || "Signify Workspace",
      ).trim(),
      publicUrl,
      assetBaseUrl: httpUrl(
        String(
          env.SIGNIFY_ASSET_BASE_URL || env.SIGNIFY_PUBLIC_URL || "",
        ).trim(),
        "SIGNIFY_ASSET_BASE_URL",
      ),
      mediaBaseUrl: httpUrl(
        String(
          env.SIGNIFY_MEDIA_BASE_URL ||
            env.SIGNIFY_ASSET_BASE_URL ||
            env.SIGNIFY_PUBLIC_URL ||
            "",
        ).trim(),
        "SIGNIFY_MEDIA_BASE_URL",
      ),
      allowRegistration: bool(env.SIGNIFY_ALLOW_REGISTRATION, !production),
      requireOwnerMfa: bool(env.SIGNIFY_REQUIRE_OWNER_MFA, production),
      applicationOwnerEmail,
      credentialEncryptionKey,
      microsoftClientId: String(
        env.MICROSOFT_CLIENT_ID || env.AZURE_CLIENT_ID || "",
      ).trim(),
      microsoftClientSecret: String(
        env.MICROSOFT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET || "",
      ).trim(),
      microsoftTenantId,
      microsoftSenderEmail,
      stripeSecretKey,
      stripeWebhookSecret,
      stripePrices,
    },
  };
}

module.exports = { loadConfig, bool };
