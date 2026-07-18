"use strict";
const path = require("node:path");

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

function loadConfig(env = process.env, baseDir = path.join(__dirname, "..")) {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535.");
  const sessionHours = Number(env.SIGNATURE_SESSION_HOURS || 12);
  if (!Number.isFinite(sessionHours) || sessionHours < 1 || sessionHours > 168)
    throw new Error("SIGNATURE_SESSION_HOURS must be from 1 to 168.");
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
    logLevel = String(env.LOG_LEVEL || "info").toLowerCase();
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel))
    throw new Error("LOG_LEVEL must be debug, info, warn, error, or silent.");
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
  return {
    production,
    port,
    host: env.HOST || "127.0.0.1",
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel,
    sourceRoot: baseDir,
    publicRoot: path.join(baseDir, "public"),
    databasePath:
      env.DATABASE_PATH || path.join(baseDir, "data", "signify-creator.db"),
    signature: {
      sessionHours,
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
      applicationOwnerEmail,
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
