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
    bootstrapPassword = String(
      env.SIGNIFY_BOOTSTRAP_PASSWORD || "SignifyDemo123!",
    );
  if (
    production &&
    allowDefaultAdmin &&
    bootstrapPassword === "SignifyDemo123!"
  )
    throw new Error(
      "Set a unique SIGNIFY_BOOTSTRAP_PASSWORD before enabling the production bootstrap administrator.",
    );
  const microsoft = [
    env.MICROSOFT_CLIENT_ID || env.AZURE_CLIENT_ID,
    env.MICROSOFT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET,
    env.MICROSOFT_TENANT_ID || env.AZURE_TENANT_ID,
  ].filter(Boolean);
  if (production && microsoft.length > 0 && microsoft.length < 3)
    throw new Error(
      "Microsoft integration requires MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_TENANT_ID together.",
    );
  return {
    production,
    port,
    host: env.HOST || "127.0.0.1",
    trustProxy: bool(env.TRUST_PROXY, false),
    logLevel: String(env.LOG_LEVEL || "info").toLowerCase(),
    sourceRoot: baseDir,
    publicRoot: path.join(baseDir, "public"),
    databasePath:
      env.DATABASE_PATH || path.join(baseDir, "data", "signify-creator.db"),
    signature: {
      sessionHours,
      allowDefaultAdmin,
      bootstrapEmail: String(
        env.SIGNIFY_BOOTSTRAP_EMAIL || "admin@signify.local",
      )
        .trim()
        .toLowerCase(),
      bootstrapPassword,
      companyName: String(
        env.SIGNIFY_COMPANY_NAME || "Signify Workspace",
      ).trim(),
      publicUrl: httpUrl(
        String(env.SIGNIFY_PUBLIC_URL || "").trim(),
        "SIGNIFY_PUBLIC_URL",
      ),
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
      microsoftClientId: String(
        env.MICROSOFT_CLIENT_ID || env.AZURE_CLIENT_ID || "",
      ).trim(),
      microsoftClientSecret: String(
        env.MICROSOFT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET || "",
      ).trim(),
      microsoftTenantId: String(
        env.MICROSOFT_TENANT_ID || env.AZURE_TENANT_ID || "",
      ).trim(),
      microsoftSenderEmail: String(env.MICROSOFT_SENDER_EMAIL || "")
        .trim()
        .toLowerCase(),
      stripeSecretKey: String(env.STRIPE_SECRET_KEY || "").trim(),
      stripeWebhookSecret: String(env.STRIPE_WEBHOOK_SECRET || "").trim(),
      stripePrices: {
        starter: String(env.STRIPE_PRICE_STARTER || "").trim(),
        team: String(env.STRIPE_PRICE_TEAM || "").trim(),
        business: String(env.STRIPE_PRICE_BUSINESS || "").trim(),
      },
    },
  };
}

module.exports = { loadConfig, bool };
