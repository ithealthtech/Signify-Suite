"use strict";
const assert = require("node:assert/strict");
const {
  REQUIRED_MICROSOFT_ROLES,
  REQUIRED_STRIPE_EVENTS,
  acceptMicrosoft,
  acceptStripe,
} = require("../server/provider-acceptance.cjs");

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function token(roles = REQUIRED_MICROSOFT_ROLES) {
  return `header.${Buffer.from(JSON.stringify({ roles })).toString("base64url")}.signature`;
}

(async () => {
  const microsoftCalls = [];
  const microsoft = await acceptMicrosoft({
    clientId: "11111111-1111-4111-8111-111111111111",
    clientSecret: "sandbox-secret",
    tenantId: "22222222-2222-4222-8222-222222222222",
    senderEmail: "sender@example.test",
    recipientEmail: "recipient@example.test",
    exercise: true,
    fetchImpl: async (url, options = {}) => {
      microsoftCalls.push({ url, options });
      if (url.includes("/token")) return response({ access_token: token() });
      if (url.includes("/organization?"))
        return response({
          value: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              displayName: "Signify Sandbox",
            },
          ],
        });
      if (url.includes("/users?") && url.includes("$top=1"))
        return response({ value: [{ id: "user-1" }] });
      if (url.includes("/sendMail")) return response(null, 202);
      if (url.includes("/users/"))
        return response({ id: "sender-1", mail: "sender@example.test" });
      return response({ error: { message: "Unexpected request" } }, 500);
    },
  });
  assert.equal(microsoft.status, "accepted");
  assert.equal(microsoft.messageSent, true);
  assert.ok(microsoftCalls.some((call) => call.url.includes("/sendMail")));
  await assert.rejects(
    () =>
      acceptMicrosoft({
        clientId: "client",
        clientSecret: "secret",
        tenantId: "tenant",
        fetchImpl: async () => response({ access_token: token(["Mail.Send"]) }),
      }),
    /admin consent is missing/,
  );

  const stripeCalls = [];
  const stripeClient = {
    accounts: { retrieve: async () => ({ id: "acct_sandbox" }) },
    prices: {
      list: async () => ({ data: [{ id: "price_starter" }] }),
    },
    webhookEndpoints: {
      retrieve: async (id) => ({
        id,
        status: "enabled",
        enabled_events: REQUIRED_STRIPE_EVENTS,
      }),
    },
    checkout: {
      sessions: {
        create: async (input) => {
          stripeCalls.push(["create", input]);
          return { id: "cs_test_acceptance" };
        },
        expire: async (id) => stripeCalls.push(["expire", id]),
      },
    },
  };
  const stripe = await acceptStripe({
    secretKey: "sk_test_sandbox",
    mappedPrices: { starter: "price_starter" },
    webhookSecret: "whsec_sandbox",
    webhookEndpointId: "we_sandbox",
    publicUrl: "https://signify.example.test",
    customerEmail: "acceptance@example.test",
    exercise: true,
    stripeClient,
  });
  assert.equal(stripe.status, "accepted");
  assert.equal(stripe.checkoutExpired, true);
  assert.deepEqual(
    stripeCalls.map(([action]) => action),
    ["create", "expire"],
  );
  await assert.rejects(
    () =>
      acceptStripe({
        secretKey: "sk_live_not-sandbox",
        mappedPrices: { starter: "price_starter" },
        exercise: true,
        stripeClient,
      }),
    /test-mode secret key/,
  );
  await assert.rejects(
    () =>
      acceptStripe({
        secretKey: "sk_test_sandbox",
        mappedPrices: { starter: "price_missing" },
        webhookSecret: "whsec_sandbox",
        webhookEndpointId: "we_sandbox",
        stripeClient,
      }),
    /mapped prices are unavailable/,
  );
  console.log(
    "Provider acceptance tests passed: Microsoft roles, directory and mail; Stripe catalog, webhook and disposable Checkout",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
