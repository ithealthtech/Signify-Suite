"use strict";

const REQUIRED_MICROSOFT_ROLES = [
  "Mail.Send",
  "Organization.Read.All",
  "User.Read.All",
];
const REQUIRED_STRIPE_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

function jwtPayload(token) {
  const segment = String(token || "").split(".")[1];
  if (!segment) return {};
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

async function jsonResponse(response, fallback) {
  try {
    return await response.json();
  } catch {
    throw new Error(fallback);
  }
}

async function acceptMicrosoft({
  clientId,
  clientSecret,
  tenantId,
  senderEmail = "",
  recipientEmail = "",
  exercise = false,
  fetchImpl = fetch,
}) {
  if (!clientId || !clientSecret || !tenantId)
    return {
      provider: "microsoft",
      status: "blocked",
      reason: "Microsoft application credentials are not configured.",
    };
  const tokenResponse = await fetchImpl(
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
    tokens = await jsonResponse(
      tokenResponse,
      "Microsoft returned an invalid token response.",
    );
  if (!tokenResponse.ok || !tokens.access_token)
    throw new Error(
      tokens.error_description || "Microsoft token acquisition failed.",
    );
  const claims = jwtPayload(tokens.access_token),
    roles = Array.isArray(claims.roles) ? claims.roles.sort() : [],
    missingRoles = REQUIRED_MICROSOFT_ROLES.filter(
      (permission) => !roles.includes(permission),
    );
  if (missingRoles.length)
    throw new Error(
      `Microsoft admin consent is missing: ${missingRoles.join(", ")}.`,
    );
  const headers = { Authorization: `Bearer ${tokens.access_token}` },
    organizationResponse = await fetchImpl(
      "https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains",
      { headers, signal: AbortSignal.timeout(15000) },
    ),
    organizationData = await jsonResponse(
      organizationResponse,
      "Microsoft returned an invalid organization response.",
    ),
    organization = organizationData.value?.[0];
  if (!organizationResponse.ok || !organization)
    throw new Error(
      organizationData.error?.message ||
        "Microsoft organization verification failed.",
    );
  if (String(organization.id).toLowerCase() !== String(tenantId).toLowerCase())
    throw new Error("Microsoft returned a different tenant.");
  const usersResponse = await fetchImpl(
      "https://graph.microsoft.com/v1.0/users?$select=id,mail,userPrincipalName,accountEnabled&$top=1",
      { headers, signal: AbortSignal.timeout(15000) },
    ),
    usersData = await jsonResponse(
      usersResponse,
      "Microsoft returned an invalid directory response.",
    );
  if (!usersResponse.ok || !Array.isArray(usersData.value))
    throw new Error(
      usersData.error?.message || "Microsoft directory verification failed.",
    );
  let messageSent = false;
  if (exercise) {
    const sender = String(senderEmail).trim(),
      recipient = String(recipientEmail || sender).trim();
    if (!sender || !recipient)
      throw new Error(
        "Microsoft exercise mode requires a connected sender mailbox and acceptance recipient.",
      );
    const senderResponse = await fetchImpl(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}?$select=id,mail,userPrincipalName`,
        { headers, signal: AbortSignal.timeout(15000) },
      ),
      senderData = await jsonResponse(
        senderResponse,
        "Microsoft returned an invalid sender response.",
      );
    if (!senderResponse.ok || !senderData.id)
      throw new Error(
        senderData.error?.message || "Microsoft sender mailbox was not found.",
      );
    const mailResponse = await fetchImpl(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: "Signify Microsoft 365 sandbox acceptance",
            body: {
              contentType: "HTML",
              content:
                "<p>Signify completed its Microsoft 365 sandbox acceptance test.</p>",
            },
            toRecipients: [{ emailAddress: { address: recipient } }],
          },
          saveToSentItems: true,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!mailResponse.ok)
      throw new Error("Microsoft rejected the sandbox acceptance message.");
    messageSent = true;
  }
  return {
    provider: "microsoft",
    status: exercise ? "accepted" : "ready",
    mode: exercise ? "sandbox-exercised" : "read-only",
    tenantId: organization.id,
    organizationName: organization.displayName,
    permissions: REQUIRED_MICROSOFT_ROLES,
    directoryQuery: "passed",
    messageSent,
  };
}

async function acceptStripe({
  secretKey,
  mappedPrices = {},
  webhookSecret = "",
  webhookEndpointId = "",
  publicUrl = "",
  customerEmail = "",
  exercise = false,
  stripeClient,
}) {
  if (!secretKey)
    return {
      provider: "stripe",
      status: "blocked",
      reason: "Stripe credentials are not configured.",
    };
  const testMode = secretKey.startsWith("sk_test_"),
    mapped = Object.entries(mappedPrices).filter(([, price]) => Boolean(price));
  if (!mapped.length)
    throw new Error(
      "Map at least one Signify plan to a recurring Stripe price.",
    );
  if (exercise && !testMode)
    throw new Error("Stripe exercise mode requires a test-mode secret key.");
  if (exercise && !/^https:\/\//i.test(publicUrl))
    throw new Error(
      "Stripe exercise mode requires SIGNIFY_PUBLIC_URL with an HTTPS address.",
    );
  const [account, prices] = await Promise.all([
      stripeClient.accounts.retrieve(),
      stripeClient.prices.list({
        active: true,
        type: "recurring",
        limit: 100,
      }),
    ]),
    activePrices = new Set(prices.data.map((price) => price.id)),
    unavailable = mapped
      .filter(([, price]) => !activePrices.has(price))
      .map(([plan]) => plan);
  if (unavailable.length)
    throw new Error(
      `Stripe mapped prices are unavailable for: ${unavailable.join(", ")}.`,
    );
  let endpoint;
  if (webhookEndpointId)
    endpoint = await stripeClient.webhookEndpoints.retrieve(webhookEndpointId);
  else if (publicUrl) {
    const endpoints = await stripeClient.webhookEndpoints.list({ limit: 100 }),
      expectedUrl = `${String(publicUrl).replace(/\/+$/, "")}/webhooks/stripe`;
    endpoint = endpoints.data.find(
      (candidate) => candidate.url === expectedUrl,
    );
  }
  if (!endpoint || endpoint.status === "disabled")
    throw new Error("The Signify Stripe webhook endpoint is not active.");
  const missingEvents = REQUIRED_STRIPE_EVENTS.filter(
    (event) => !endpoint.enabled_events?.includes(event),
  );
  if (missingEvents.length)
    throw new Error(
      `Stripe webhook events are missing: ${missingEvents.join(", ")}.`,
    );
  if (!webhookSecret)
    throw new Error("The Stripe webhook signing secret is not configured.");
  let checkoutCreated = false;
  if (exercise) {
    if (!/^\S+@\S+\.\S+$/.test(customerEmail))
      throw new Error(
        "Stripe exercise mode requires SIGNIFY_ACCEPTANCE_EMAIL.",
      );
    const [plan, price] = mapped[0],
      checkout = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        customer_email: customerEmail,
        line_items: [{ price, quantity: 1 }],
        success_url: `${String(publicUrl).replace(/\/+$/, "")}/platform.html?billing=acceptance-success`,
        cancel_url: `${String(publicUrl).replace(/\/+$/, "")}/platform.html?billing=acceptance-canceled`,
        metadata: { signify_acceptance: "true", plan },
        subscription_data: {
          metadata: { signify_acceptance: "true", plan },
        },
      });
    await stripeClient.checkout.sessions.expire(checkout.id);
    checkoutCreated = true;
  }
  return {
    provider: "stripe",
    status: exercise ? "accepted" : "ready",
    mode: testMode ? "test" : "live",
    accountId: account.id,
    mappedPlans: mapped.map(([plan]) => plan),
    webhookEndpointId: endpoint.id,
    webhookEvents: REQUIRED_STRIPE_EVENTS,
    checkoutCreated,
    checkoutExpired: checkoutCreated,
  };
}

module.exports = {
  REQUIRED_MICROSOFT_ROLES,
  REQUIRED_STRIPE_EVENTS,
  acceptMicrosoft,
  acceptStripe,
  jwtPayload,
};
