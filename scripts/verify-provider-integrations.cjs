"use strict";
const Stripe = require("stripe");
const { loadConfig } = require("../server/config.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { openDatabase } = require("../server/database.cjs");

const config = loadConfig(process.env),
  db = openDatabase(config.databasePath),
  vault = createCredentialVault(config.signature.credentialEncryptionKey);

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

async function verifyStripe() {
  const stored = saved("stripe"),
    secretKey =
      stored?.credentials.secretKey || config.signature.stripeSecretKey;
  if (!secretKey) return { provider: "stripe", status: "skipped" };
  const stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 10000,
    }),
    [account, prices] = await Promise.all([
      stripe.accounts.retrieve(),
      stripe.prices.list({ active: true, type: "recurring", limit: 100 }),
    ]),
    mapped = stored?.configuration.prices || config.signature.stripePrices,
    active = new Set(prices.data.map((price) => price.id)),
    unavailable = Object.entries(mapped || {})
      .filter(([, price]) => price && !active.has(price))
      .map(([plan]) => plan);
  if (unavailable.length)
    throw new Error(
      `Stripe mapped prices are unavailable for: ${unavailable.join(", ")}.`,
    );
  return {
    provider: "stripe",
    status: "ready",
    mode: secretKey.startsWith("sk_live_") ? "live" : "test",
    accountId: account.id,
    recurringPrices: prices.data.length,
    mappedPlans: Object.values(mapped || {}).filter(Boolean).length,
  };
}

async function verifyMicrosoft() {
  const stored = saved("microsoft"),
    clientId =
      stored?.credentials.clientId || config.signature.microsoftClientId,
    clientSecret =
      stored?.credentials.clientSecret ||
      config.signature.microsoftClientSecret,
    tenantId =
      stored?.configuration.homeTenantId || config.signature.microsoftTenantId;
  if (!clientId || !clientSecret || !tenantId)
    return { provider: "microsoft", status: "skipped" };
  const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(15000),
      },
    ),
    tokens = await tokenResponse.json();
  if (!tokenResponse.ok || !tokens.access_token)
    throw new Error(
      tokens.error_description || "Microsoft token acquisition failed.",
    );
  const organizationResponse = await fetch(
      "https://graph.microsoft.com/v1.0/organization?$select=id,displayName",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(15000),
      },
    ),
    organizationData = await organizationResponse.json();
  if (!organizationResponse.ok || !organizationData.value?.[0])
    throw new Error(
      organizationData.error?.message ||
        "Microsoft organization verification failed.",
    );
  return {
    provider: "microsoft",
    status: "ready",
    tenantId: organizationData.value[0].id,
    organizationName: organizationData.value[0].displayName,
  };
}

(async () => {
  try {
    const results = await Promise.all([verifyMicrosoft(), verifyStripe()]);
    for (const result of results) console.log(JSON.stringify(result));
    if (results.every((result) => result.status === "skipped"))
      throw new Error("No provider credentials are configured.");
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(`Provider verification failed: ${error.message}`);
  process.exitCode = 1;
});
