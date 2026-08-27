"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Stripe = require("stripe");
const { loadConfig } = require("../server/config.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { openDatabase } = require("../server/database.cjs");
const {
  acceptMicrosoft,
  acceptStripe,
} = require("../server/provider-acceptance.cjs");

const config = loadConfig(process.env),
  db = openDatabase(config.databasePath),
  vault = createCredentialVault(config.signature.credentialEncryptionKey),
  exercise = process.argv.includes("--exercise"),
  requested = process.argv
    .filter((argument) => argument.startsWith("--provider="))
    .map((argument) => argument.split("=")[1]),
  providers = requested.length ? requested : ["microsoft", "stripe"],
  reportPath = path.resolve(
    process.env.SIGNIFY_ACCEPTANCE_REPORT ||
      path.join("tmp", "provider-acceptance.json"),
  ),
  configuredAcceptanceSender = String(
    process.env.SIGNIFY_ACCEPTANCE_M365_SENDER || "",
  ).trim();

function saved(provider) {
  const row = db
    .prepare("SELECT * FROM application_integrations WHERE provider=?")
    .get(provider);
  return row?.encrypted_credentials
    ? {
        credentials: vault.decrypt(provider, row.encrypted_credentials),
        configuration: JSON.parse(row.configuration_json),
      }
    : null;
}

function microsoftInput() {
  const stored = saved("microsoft"),
    tenantId =
      stored?.configuration.homeTenantId || config.signature.microsoftTenantId,
    connection = tenantId
      ? db
          .prepare(
            "SELECT sender_email FROM organization_microsoft_connections WHERE lower(tenant_id)=lower(?) AND status='connected' ORDER BY updated_at DESC LIMIT 1",
          )
          .get(tenantId)
      : null;
  return {
    clientId:
      stored?.credentials.clientId || config.signature.microsoftClientId,
    clientSecret:
      stored?.credentials.clientSecret ||
      config.signature.microsoftClientSecret,
    tenantId,
    senderEmail:
      configuredAcceptanceSender ||
      connection?.sender_email ||
      config.signature.microsoftSenderEmail,
    recipientEmail:
      process.env.SIGNIFY_ACCEPTANCE_EMAIL || configuredAcceptanceSender,
    exercise,
  };
}

function stripeInput() {
  const stored = saved("stripe"),
    secretKey =
      stored?.credentials.secretKey || config.signature.stripeSecretKey;
  return {
    secretKey,
    mappedPrices: stored?.configuration.prices || config.signature.stripePrices,
    webhookSecret:
      stored?.credentials.webhookSecret || config.signature.stripeWebhookSecret,
    webhookEndpointId: stored?.configuration.webhookEndpointId || "",
    publicUrl: config.publicUrl,
    customerEmail:
      process.env.SIGNIFY_ACCEPTANCE_EMAIL || configuredAcceptanceSender,
    exercise,
    stripeClient: secretKey
      ? new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 15000 })
      : null,
  };
}

function sanitizedMessage(error) {
  return String(error?.message || error || "Provider acceptance failed.")
    .replace(/(sk|whsec|github_pat)_[A-Za-z0-9_\-]+/g, "$1_[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

(async () => {
  const startedAt = new Date().toISOString(),
    results = [];
  for (const provider of providers) {
    try {
      if (provider === "microsoft")
        results.push(await acceptMicrosoft(microsoftInput()));
      else if (provider === "stripe")
        results.push(await acceptStripe(stripeInput()));
      else throw new Error(`Unsupported provider: ${provider}.`);
    } catch (error) {
      results.push({
        provider,
        status: "failed",
        reason: sanitizedMessage(error),
      });
    }
  }
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    exercise,
    results,
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  for (const result of results) console.log(JSON.stringify(result));
  console.log(`Sanitized acceptance report: ${reportPath}`);
  if (
    results.length !== providers.length ||
    results.some((result) =>
      exercise
        ? result.status !== "accepted"
        : !["ready", "accepted"].includes(result.status),
    )
  )
    process.exitCode = 1;
})()
  .catch((error) => {
    console.error(`Provider acceptance failed: ${sanitizedMessage(error)}`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
