"use strict";
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { generateKeyPairSync, sign } = require("node:crypto");
const Stripe = require("stripe");
const OTPAuth = require("otpauth");
const sharp = require("sharp");
const { createApplication } = require("../server.cjs");
const { loadConfig } = require("../server/config.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { buildSignatureHtml } = require("../server/templates.cjs");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
}
function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
function updateCookies(headers, jar) {
  const rows =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const row of rows) {
    const pair = String(row).split(";")[0],
      index = pair.indexOf("=");
    if (index > 0) {
      const name = pair.slice(0, index),
        value = pair.slice(index + 1);
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
  }
}
async function request(
  baseUrl,
  pathname,
  {
    method = "GET",
    body,
    jar = new Map(),
    csrf = true,
    redirect = "manual",
  } = {},
) {
  const headers = {},
    cookies = cookieHeader(jar);
  if (cookies) headers.Cookie = cookies;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (
    csrf &&
    jar.get("sig_csrf") &&
    !["GET", "HEAD", "OPTIONS"].includes(method)
  )
    headers["X-CSRF-Token"] = decodeURIComponent(jar.get("sig_csrf"));
  const response = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  updateCookies(response.headers, jar);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  return { response, body: parsed, text };
}
async function rawRequest(baseUrl, pathname, body, headers = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { response, body: parsed, text };
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "signify-creator-")),
    databasePath = path.join(tempDir, "smoke.db");
  const env = {
    ...process.env,
    DATABASE_PATH: databasePath,
    BACKUP_DIR: path.join(tempDir, "backups"),
    SIGNATURE_ALLOW_DEFAULT_ADMIN: "true",
    SIGNIFY_ALLOW_REGISTRATION: "true",
    SIGNIFY_BOOTSTRAP_EMAIL: "admin@signify.local",
    SIGNIFY_BOOTSTRAP_PASSWORD: "SignifyDemo123!",
    STRIPE_SECRET_KEY: "sk_test_smoke",
    STRIPE_WEBHOOK_SECRET: "whsec_smoke",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_TEAM: "price_team",
    SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    MICROSOFT_CLIENT_ID: "client-smoke",
    MICROSOFT_CLIENT_SECRET: "secret-smoke",
    MICROSOFT_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    LOG_LEVEL: "silent",
  };
  const microsoftTenantId = "22222222-2222-4222-8222-222222222222",
    { privateKey: microsoftPrivateKey, publicKey: microsoftPublicKey } =
      generateKeyPairSync("rsa", { modulusLength: 2048 }),
    microsoftJwk = {
      ...microsoftPublicKey.export({ format: "jwk" }),
      kid: "smoke-key",
      use: "sig",
      alg: "RS256",
    },
    graphRequests = [],
    graphResponse = (payload) => ({
      status: 200,
      ok: true,
      json: async () => payload,
    }),
    microsoftIdToken = () => {
      const now = Math.floor(Date.now() / 1000),
        header = Buffer.from(
          JSON.stringify({ alg: "RS256", typ: "JWT", kid: "smoke-key" }),
        ).toString("base64url"),
        payload = Buffer.from(
          JSON.stringify({
            aud: "client-smoke",
            iss: `https://login.microsoftonline.com/${microsoftTenantId}/v2.0`,
            tid: microsoftTenantId,
            nonce: microsoftLoginNonce,
            nbf: now - 60,
            exp: now + 600,
          }),
        ).toString("base64url"),
        unsigned = `${header}.${payload}`;
      return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), microsoftPrivateKey).toString("base64url")}`;
    };
  let microsoftLoginNonce = "";
  const fetchImpl = async (input) => {
    const url = String(input);
    graphRequests.push(url);
    if (url.endsWith("/common/discovery/v2.0/keys"))
      return graphResponse({ keys: [microsoftJwk] });
    if (url.includes("login.microsoftonline.com"))
      return graphResponse({
        access_token: "graph-token",
        id_token: microsoftIdToken(),
      });
    if (url.includes("/v1.0/me?$select="))
      return graphResponse({
        id: "admin-graph",
        displayName: "Signify Admin",
        mail: "admin@signify.local",
        userPrincipalName: "admin@signify.local",
        jobTitle: "Application Owner",
        department: "Operations",
        businessPhones: ["212-555-0100"],
        mobilePhone: "",
      });
    if (url.includes("/v1.0/me/photo/$value"))
      return { status: 404, ok: false, json: async () => ({}) };
    if (url.includes("/v1.0/organization?"))
      return graphResponse({
        value: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            displayName: "Smoke Microsoft Tenant",
            verifiedDomains: [{ name: "example.com", isDefault: true }],
          },
        ],
      });
    if (
      url.startsWith(
        "https://graph.microsoft.com/v1.0/users/signatures%40example.com?",
      )
    )
      return graphResponse({
        id: "sender-1",
        mail: "signatures@example.com",
        userPrincipalName: "signatures@example.com",
      });
    if (
      url ===
      "https://graph.microsoft.com/v1.0/users/signatures%40example.com/sendMail"
    )
      return graphResponse({});
    if (url.includes("$skiptoken=second-page"))
      return graphResponse({
        value: [
          {
            id: "graph-2",
            displayName: "Graph User Two",
            mail: "graph.two@example.com",
            assignedLicenses: [{ skuId: "license-2" }],
          },
        ],
      });
    if (url.startsWith("https://graph.microsoft.com/v1.0/users?"))
      return graphResponse({
        value: [
          {
            id: "graph-1",
            displayName: "Graph User One",
            mail: "graph.one@example.com",
            assignedLicenses: [{ skuId: "license-1" }],
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/users?$skiptoken=second-page",
      });
    throw new Error(`Unexpected external request in smoke test: ${url}`);
  };
  const stripeSandboxPrices = [
      {
        id: "price_setup_starter",
        product: { id: "prod_starter", name: "Starter" },
        currency: "usd",
        unit_amount: 1900,
        recurring: { interval: "month", interval_count: 1 },
      },
      {
        id: "price_setup_team",
        product: { id: "prod_team", name: "Team" },
        currency: "usd",
        unit_amount: 4900,
        recurring: { interval: "month", interval_count: 1 },
      },
    ],
    stripeFactory = (key) =>
      key === "sk_test_setup"
        ? {
            accounts: {
              retrieve: async () => ({
                id: "acct_setup",
                email: "billing@example.com",
                settings: { dashboard: { display_name: "Signify Sandbox" } },
              }),
            },
            prices: { list: async () => ({ data: stripeSandboxPrices }) },
            webhookEndpoints: {
              create: async (input) => ({
                id: "we_setup",
                secret: "whsec_setup",
                ...input,
              }),
              update: async (id, input) => ({ id, ...input }),
              del: async (id) => ({ id, deleted: true }),
            },
            billingPortal: {
              sessions: {
                create: async ({ customer }) => ({
                  id: "bps_setup",
                  url: `https://billing.stripe.test/${customer}`,
                }),
              },
            },
            subscriptions: {
              retrieve: async (id) => ({
                id,
                metadata: {},
                items: { data: [{ id: "si_setup" }] },
              }),
              update: async (id, input) => ({
                id,
                cancel_at_period_end: Boolean(input.cancel_at_period_end),
              }),
            },
            checkout: {
              sessions: {
                create: async (input) => {
                  if (input.customer_email === "fail@example.com")
                    throw new Error("simulated Stripe outage");
                  return {
                    id: "cs_setup_test",
                    url: "https://checkout.stripe.test/cs_setup_test",
                  };
                },
              },
            },
          }
        : new Stripe(key);
  let application = createApplication({ env, fetchImpl, stripeFactory }),
    server = http.createServer(application.handler);
  try {
    const baseUrl = await listen(server),
      adminJar = new Map(),
      editorJar = new Map(),
      tenantJar = new Map();
    let result = await request(baseUrl, "/api/health");
    assert(
      result.response.status === 200 && result.body?.database === "ready",
      "health check failed",
    );
    result = await request(baseUrl, "/api/live");
    assert(
      result.response.status === 200 && result.body?.status === "ok",
      "liveness check failed",
    );
    result = await request(baseUrl, "/api/ready");
    assert(
      result.response.status === 200 && result.body?.database === "ready",
      "readiness check failed",
    );
    result = await request(baseUrl, "/api/metrics");
    assert(
      result.response.status === 200 &&
        result.body?.requests >= 3 &&
        Number.isFinite(result.body?.averageDurationMs),
      "runtime metrics check failed",
    );
    assert(
      result.response.headers.get("content-security-policy") &&
        !result.response.headers.has("strict-transport-security"),
      "development security headers are incorrect",
    );
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: null,
    });
    assert(
      result.response.status === 400 &&
        result.body?.error?.code === "INVALID_JSON_OBJECT",
      "non-object JSON caused an invalid response",
    );
    result = await rawRequest(
      baseUrl,
      "/api/signature/login",
      JSON.stringify({ email: "x".repeat(9000) }),
      { "Content-Type": "application/json" },
    );
    assert(
      result.response.status === 413 &&
        result.body?.error?.code === "PAYLOAD_TOO_LARGE",
      "oversized authentication body was not rejected cleanly",
    );
    let productionConfigRejected = false;
    try {
      loadConfig({ NODE_ENV: "production" });
    } catch (error) {
      productionConfigRejected = error.message.includes("SIGNIFY_PUBLIC_URL");
    }
    assert(
      productionConfigRejected,
      "production started without an HTTPS public URL",
    );
    let missingEncryptionRejected = false;
    try {
      loadConfig({
        NODE_ENV: "production",
        SIGNIFY_PUBLIC_URL: "https://signatures.example.com",
        SIGNIFY_APPLICATION_OWNER_EMAIL: "owner@example.com",
      });
    } catch (error) {
      missingEncryptionRejected = error.message.includes(
        "SIGNIFY_CREDENTIAL_ENCRYPTION_KEY is required",
      );
    }
    assert(
      missingEncryptionRejected,
      "production started without credential encryption",
    );
    const validProductionConfig = loadConfig({
      NODE_ENV: "production",
      SIGNIFY_PUBLIC_URL: "https://signatures.example.com",
      SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    assert(
      validProductionConfig.signature.publicUrl ===
        "https://signatures.example.com" &&
        validProductionConfig.signature.requireOwnerMfa === true,
      "valid production configuration was rejected",
    );
    const escapedMedia = buildSignatureHtml("executive", {
      f: { name: "Security Test", social: {} },
      colors: { accent: "#2563eb" },
      photoUrl: '/" onerror="alert(1)',
      iconBase: "https://assets.example.com/icons",
    });
    assert(
      !escapedMedia.includes('" onerror="') && escapedMedia.includes("&quot;"),
      "signature media attributes were not escaped",
    );
    result = await request(baseUrl, "/signature.html");
    assert(
      result.response.status === 200 &&
        result.text.includes("Every signature. One standard."),
      "studio page failed",
    );
    const microsoftJar = new Map();
    result = await request(baseUrl, "/auth/microsoft", {
      jar: microsoftJar,
    });
    const microsoftLocation = result.response.headers.get("location"),
      microsoftState = new URL(microsoftLocation).searchParams.get("state");
    assert(
      result.response.status === 302 &&
        microsoftLocation.startsWith("https://login.microsoftonline.com/") &&
        microsoftJar.has("sig_oauth_state") &&
        microsoftState,
      "Microsoft authorization did not create browser-bound state",
    );
    result = await request(
      baseUrl,
      `/auth/microsoft/callback?state=${encodeURIComponent(microsoftState)}`,
    );
    assert(
      result.response.status === 400 && result.text.includes("state expired"),
      "Microsoft callback accepted state from another browser",
    );
    result = await request(
      baseUrl,
      `/auth/microsoft/callback?state=${encodeURIComponent(microsoftState)}&error=access_denied`,
      { jar: microsoftJar },
    );
    assert(
      result.response.status === 400 &&
        result.text.includes("was canceled") &&
        !microsoftJar.has("sig_oauth_state"),
      "Microsoft cancellation did not consume and clear OAuth state",
    );
    const missingCodeJar = new Map();
    result = await request(baseUrl, "/auth/microsoft", {
      jar: missingCodeJar,
    });
    const missingCodeState = new URL(
      result.response.headers.get("location"),
    ).searchParams.get("state");
    result = await request(
      baseUrl,
      `/auth/microsoft/callback?state=${encodeURIComponent(missingCodeState)}`,
      { jar: missingCodeJar },
    );
    assert(
      result.response.status === 400 &&
        result.text.includes("authorization code is missing") &&
        !missingCodeJar.has("sig_oauth_state"),
      "Microsoft callback did not reject a missing authorization code locally",
    );
    result = await request(baseUrl, "/setup.html");
    assert(
      result.response.status === 404,
      "removed installer is still reachable",
    );
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "admin@signify.local", password: "wrong" },
      jar: adminJar,
    });
    assert(result.response.status === 401, "invalid credentials were accepted");
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "admin@signify.local", password: "SignifyDemo123!" },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        adminJar.has("sig_session") &&
        adminJar.has("sig_csrf"),
      "admin login or secure cookies failed",
    );
    const ownerSessionHours = application.db
      .prepare(
        `SELECT (julianday(s.expires_at)-julianday(s.created_at))*24 hours
         FROM signature_sessions s JOIN signature_users u ON u.id=s.user_id
         WHERE u.email='admin@signify.local' ORDER BY s.created_at DESC LIMIT 1`,
      )
      .get().hours;
    assert(
      ownerSessionHours > 3.9 && ownerSessionHours <= 4.01,
      "Application Owner session was not capped at four hours",
    );
    application.db
      .prepare("UPDATE organization_subscriptions SET seats=100")
      .run();
    result = await request(baseUrl, "/api/signature/directory-sync", {
      method: "POST",
      body: {},
      jar: adminJar,
    });
    assert(
      result.response.status === 202 && result.body.job?.id,
      "Microsoft directory sync was not queued",
    );
    const directoryJobId = result.body.job.id;
    result = await request(baseUrl, "/api/signature/directory-sync", {
      method: "POST",
      body: {},
      jar: adminJar,
    });
    assert(
      result.response.status === 202 &&
        result.body.existing === true &&
        result.body.job.id === directoryJobId,
      "duplicate directory sync created parallel work",
    );
    await application.jobQueue.runOnce();
    result = await request(baseUrl, `/api/signature/jobs/${directoryJobId}`, {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.job?.status === "completed" &&
        result.body.job.result?.seen === 2 &&
        result.body.job.result?.added === 2 &&
        graphRequests.some((url) => url.includes("$skiptoken=second-page")) &&
        application.db
          .prepare(
            "SELECT COUNT(*) AS count FROM signature_users WHERE email IN ('graph.one@example.com','graph.two@example.com')",
          )
          .get().count === 2,
      "Microsoft directory pagination or import failed",
    );
    result = await request(baseUrl, "/api/signature/session", {
      jar: adminJar,
    });
    assert(
      result.body?.user?.role === "admin" &&
        result.body.user.applicationOwner === true,
      "admin session or Application Owner bootstrap failed",
    );
    const primaryOrganizationId = result.body.user.organizationId;
    result = await request(baseUrl, "/api/signature/users", { jar: adminJar });
    assert(
      result.response.status === 200 && result.body.users.length === 3,
      "tenant user list failed",
    );
    const adminId = result.body.users.find(
      (member) => member.email === "admin@signify.local",
    )?.id;
    assert(adminId, "bootstrap administrator disappeared after directory sync");
    result = await request(baseUrl, "/api/signature/invitations", {
      method: "POST",
      body: {
        email: "editor@example.com",
        role: "editor",
      },
      jar: adminJar,
      csrf: false,
    });
    assert(
      result.response.status === 403 &&
        result.body?.error?.code === "CSRF_INVALID",
      "mutation without CSRF was accepted",
    );
    result = await request(baseUrl, "/api/signature/invitations", {
      method: "POST",
      body: {
        email: "editor@example.com",
        role: "editor",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 201 && result.body.developmentToken,
      "admin could not invite editor",
    );
    const invitationToken = result.body.developmentToken;
    result = await request(baseUrl, "/api/signature/invitations/accept", {
      method: "POST",
      body: {
        token: invitationToken,
        name: "Editor User",
        password: "EditorPass123!",
      },
      jar: editorJar,
    });
    assert(
      result.response.status === 200 && result.body.user.role === "editor",
      "editor could not accept invitation",
    );
    const editorId = result.body.user.id;
    result = await request(baseUrl, "/api/signature/invitations/accept", {
      method: "POST",
      body: {
        token: invitationToken,
        name: "Editor User",
        password: "EditorPass123!",
      },
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "INVITATION_INVALID",
      "invitation token was reusable",
    );
    editorJar.clear();
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "editor@example.com", password: "EditorPass123!" },
      jar: editorJar,
    });
    assert(result.response.status === 200, "editor login failed");
    await request(baseUrl, "/api/signature/session", { jar: editorJar });
    result = await request(baseUrl, "/api/platform/session", {
      jar: editorJar,
    });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "APPLICATION_OWNER_REQUIRED",
      "end user reached the Application Owner control plane",
    );
    result = await request(baseUrl, "/api/signature/runtime-config", {
      jar: editorJar,
    });
    assert(
      result.body.capabilities.mail === false,
      "incomplete Microsoft credentials incorrectly enabled email controls",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: editorJar,
    });
    assert(
      result.response.status === 403,
      "editor reached admin configuration",
    );
    result = await request(baseUrl, "/api/signature/preview", {
      method: "POST",
      body: { userId: adminId, signature: {} },
      jar: editorJar,
    });
    assert(result.response.status === 403, "editor previewed another member");
    result = await request(baseUrl, "/api/signature/preview", {
      method: "POST",
      body: { userId: editorId, signature: {} },
      jar: editorJar,
    });
    assert(result.response.status === 200, "editor could not preview self");
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.subscription?.plan === "starter" &&
        result.body.subscription?.status === "trialing" &&
        !Object.hasOwn(result.body.subscription, "stripeCustomerId"),
      "stable workspaces did not start on the Starter trial",
    );
    result = await request(baseUrl, "/auth/microsoft/admin-consent", {
      jar: editorJar,
    });
    assert(
      result.response.status === 403,
      "end user could initiate Microsoft tenant consent",
    );
    const consentJar = adminJar,
      consentTenantId = microsoftTenantId;
    result = await request(baseUrl, "/auth/microsoft/admin-consent", {
      jar: consentJar,
    });
    const canceledConsentState = new URL(
      result.response.headers.get("location"),
    ).searchParams.get("state");
    result = await request(
      baseUrl,
      `/auth/microsoft/admin-consent/callback?state=${encodeURIComponent(canceledConsentState)}&error=access_denied`,
      { jar: consentJar },
    );
    assert(
      result.response.status === 302 &&
        result.response.headers
          .get("location")
          .includes("microsoft=canceled") &&
        !consentJar.has("sig_oauth_state"),
      "Microsoft consent cancellation did not consume state and clear its cookie",
    );
    result = await request(baseUrl, "/auth/microsoft/admin-consent", {
      jar: consentJar,
    });
    const consentLocation = result.response.headers.get("location"),
      consentState = new URL(consentLocation).searchParams.get("state");
    assert(
      result.response.status === 302 &&
        consentLocation.startsWith(
          "https://login.microsoftonline.com/organizations/v2.0/adminconsent",
        ) &&
        consentState,
      "tenant administrator could not start Microsoft admin consent",
    );
    result = await request(
      baseUrl,
      `/auth/microsoft/admin-consent/callback?state=${encodeURIComponent(consentState)}&admin_consent=True&tenant=${consentTenantId}`,
    );
    assert(
      result.response.status === 400 && result.text.includes("state expired"),
      "Microsoft admin consent accepted state from another browser",
    );
    result = await request(
      baseUrl,
      `/auth/microsoft/admin-consent/callback?state=${encodeURIComponent(consentState)}&admin_consent=True&tenant=${consentTenantId}`,
      { jar: consentJar },
    );
    assert(
      result.response.status === 302 &&
        result.response.headers
          .get("location")
          .includes("microsoft=connected") &&
        application.db
          .prepare(
            "SELECT tenant_id FROM organization_microsoft_connections WHERE organization_id=?",
          )
          .get(primaryOrganizationId).tenant_id === consentTenantId,
      "Microsoft admin consent was not verified and stored per tenant",
    );
    result = await request(baseUrl, "/api/signature/microsoft-connection", {
      method: "PUT",
      body: { senderEmail: "signatures@example.com" },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.microsoft.senderEmail === "signatures@example.com",
      "tenant sender mailbox validation failed",
    );
    const microsoftLoginJar = new Map();
    result = await request(baseUrl, "/auth/microsoft", {
      jar: microsoftLoginJar,
    });
    const loginLocation = result.response.headers.get("location"),
      loginState = new URL(loginLocation).searchParams.get("state");
    microsoftLoginNonce = new URL(loginLocation).searchParams.get("nonce");
    assert(
      new URL(loginLocation).searchParams.get("code_challenge_method") ===
        "S256" && microsoftLoginNonce,
      "Microsoft sign-in did not use PKCE and nonce binding",
    );
    result = await request(
      baseUrl,
      `/auth/microsoft/callback?state=${encodeURIComponent(loginState)}&code=smoke-code`,
      { jar: microsoftLoginJar },
    );
    assert(
      result.response.status === 302 &&
        result.response.headers.get("location") === "/signature.html" &&
        microsoftLoginJar.has("sig_session"),
      "multi-tenant Microsoft sign-in did not resolve the connected tenant",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    const approvalSettings = result.body.workspace.settings,
      workspaceName = result.body.workspace.name;
    result = await request(baseUrl, "/api/signature/admin-config", {
      method: "PUT",
      body: {
        name: workspaceName,
        ...approvalSettings,
        publicUrl: "http://127.0.0.1:4173",
        assetBaseUrl: "http://127.0.0.1:4173",
        mediaBaseUrl: "http://127.0.0.1:4173",
      },
      jar: adminJar,
    });
    result = await request(baseUrl, "/api/signature/preview", {
      method: "POST",
      body: {
        userId: adminId,
        signature: {
          fields: {
            name: "Local Preview",
            email: "admin@signify.local",
            social: { linkedin: "https://linkedin.com/company/signify" },
          },
        },
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.html.includes(`${baseUrl}/icons`),
      "stale local asset origin broke the signature preview",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    result = await request(baseUrl, "/api/signature/admin-config", {
      method: "PUT",
      body: {
        name: workspaceName,
        ...result.body.workspace.settings,
        assetBaseUrl: "https://assets.example.com",
        requireApproval: true,
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.workspace.settings.requireApproval === true,
      "approval policy could not be enabled",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      method: "PUT",
      body: {
        name: result.body.workspace.name,
        ...result.body.workspace.settings,
        sessionHours: 0,
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "SESSION_HOURS_INVALID",
      "invalid session length was accepted",
    );
    result = await request(baseUrl, `/api/signature/users/${editorId}`, {
      method: "PUT",
      body: {
        signature: {
          templateId: "executive",
          fields: {
            name: "Editor User",
            email: "editor@example.com",
            jobTitle: "Primary Workspace Role",
            website: "javascript:alert(1)",
          },
          colors: { accent: "red" },
          photoUrl: '/" onerror="alert(1)',
        },
      },
      jar: editorJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "SIGNATURE_INVALID",
      "invalid signature data was accepted",
    );
    result = await request(baseUrl, `/api/signature/users/${editorId}`, {
      method: "PUT",
      body: {
        displayName: "Editor User",
        signature: {
          templateId: "executive",
          workflowStatus: "approved",
          fields: {
            name: "Editor User",
            email: "editor@example.com",
            jobTitle: "Approval Candidate",
            website: "https://example.com",
            social: { linkedin: "https://linkedin.com/in/editor" },
          },
          colors: { accent: "#2563eb" },
        },
      },
      jar: editorJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.signature.workflowStatus === "draft" &&
        result.body.user.signature.fields.jobTitle === "Approval Candidate",
      "server-side approval policy was bypassed",
    );
    result = await request(baseUrl, "/api/signature/preview", {
      method: "POST",
      body: { userId: editorId, signature: result.body.user.signature },
      jar: editorJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.html.includes("https://assets.example.com/icons"),
      "asset base URL was not used by rendered signatures",
    );
    result = await request(baseUrl, "/api/signature/workflow/submit", {
      method: "POST",
      body: {},
      jar: editorJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.signature.workflowStatus === "pending" &&
        result.body.signature.fields.jobTitle === "Approval Candidate",
      "approval submission lost the tenant-scoped signature",
    );
    result = await request(baseUrl, "/api/signature/workflow/submit", {
      method: "POST",
      body: {},
      jar: editorJar,
    });
    assert(
      result.response.status === 409 &&
        result.body.error.code === "APPROVAL_ALREADY_PENDING",
      "pending signature was submitted twice",
    );
    result = await request(baseUrl, "/api/signature/approvals", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.approvals.some(
          (approval) =>
            approval.id === editorId &&
            approval.signature.fields.jobTitle === "Approval Candidate",
        ),
      "pending signature was missing from approvals",
    );
    result = await request(
      baseUrl,
      `/api/signature/approvals/${editorId}/approve`,
      { method: "POST", body: {}, jar: adminJar },
    );
    assert(
      result.response.status === 200 &&
        result.body.user.signature.workflowStatus === "approved",
      "signature approval failed",
    );
    result = await request(
      baseUrl,
      `/api/signature/approvals/${editorId}/approve`,
      { method: "POST", body: {}, jar: adminJar },
    );
    assert(
      result.response.status === 409 &&
        result.body.error.code === "APPROVAL_NOT_PENDING",
      "non-pending signature was approved",
    );
    result = await request(baseUrl, `/api/signature/users/${editorId}`, {
      method: "PUT",
      body: {
        password: "short",
        signature: {
          templateId: "compact",
          fields: { jobTitle: "Partial Update" },
        },
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "PASSWORD_WEAK",
      "invalid atomic member update was accepted",
    );
    result = await request(baseUrl, "/api/signature/users", { jar: adminJar });
    assert(
      result.body.users.find((member) => member.id === editorId).signature
        .fields.jobTitle === "Approval Candidate",
      "failed member update partially changed signature data",
    );
    const fakeImage =
      "data:image/png;base64," + Buffer.from("not a png").toString("base64");
    result = await request(baseUrl, "/api/signature/upload", {
      method: "POST",
      body: { kind: "logo", dataUrl: fakeImage },
      jar: editorJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "IMAGE_CONTENT_INVALID",
      "spoofed image upload was accepted",
    );
    const oversizedLogo = await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 4,
        background: "#2563eb",
      },
    })
      .png()
      .toBuffer();
    result = await request(baseUrl, "/api/signature/upload", {
      method: "POST",
      body: {
        kind: "logo",
        dataUrl: `data:image/png;base64,${oversizedLogo.toString("base64")}`,
      },
      jar: editorJar,
    });
    assert(result.response.status === 201, "valid image upload failed");
    const normalizedLogoPath = path.join(
        __dirname,
        "..",
        "public",
        ...result.body.url.split("/").filter(Boolean),
      ),
      normalizedLogo = await sharp(normalizedLogoPath).metadata();
    assert(
      normalizedLogo.width <= 400 && normalizedLogo.height <= 160,
      "uploaded logo was not normalized",
    );
    fs.unlinkSync(normalizedLogoPath);
    const animationFrames = [
      Buffer.from([0, 0, 0, 255, 255, 255, 255, 255]).toString("base64"),
      Buffer.from([37, 99, 235, 255, 95, 229, 255, 255]).toString("base64"),
    ];
    result = await request(baseUrl, "/api/signature/generated-banners", {
      method: "POST",
      body: { width: 2, height: 1, delay: 80, frames: animationFrames },
      jar: editorJar,
    });
    assert(
      result.response.status === 201 &&
        /^\/generated-banners\/[^/]+\/banner-[\w-]+\.gif$/.test(
          result.body.url,
        ),
      `animated banner generation failed: ${result.response.status} ${result.text}`,
    );
    const generatedBannerPath = path.join(
      __dirname,
      "..",
      "public",
      ...result.body.url.split("/").filter(Boolean),
    );
    assert(
      fs.statSync(generatedBannerPath).size > 0,
      "generated GIF was empty",
    );
    fs.unlinkSync(generatedBannerPath);
    result = await request(baseUrl, "/api/signature/register", {
      method: "POST",
      body: {
        name: "Tenant Owner",
        company: "Second Company",
        email: "owner@second.example",
        password: "SecondPass123!",
      },
      jar: tenantJar,
    });
    assert(
      result.response.status === 201 && result.body.developmentToken,
      "development registration failed",
    );
    let verificationToken = result.body.developmentToken;
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "owner@second.example", password: "SecondPass123!" },
      jar: tenantJar,
    });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "EMAIL_NOT_VERIFIED",
      "unverified account logged in",
    );
    result = await request(baseUrl, "/api/signature/register", {
      method: "POST",
      body: {
        name: "Tenant Owner",
        company: "Second Company",
        email: "owner@second.example",
        password: "SecondPass123!",
      },
      jar: tenantJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.resent === true &&
        result.body.developmentToken,
      "unverified registration could not retry verification delivery",
    );
    verificationToken = result.body.developmentToken;
    result = await request(baseUrl, "/api/signature/email/verify", {
      method: "POST",
      body: { token: verificationToken },
      jar: tenantJar,
    });
    assert(result.response.status === 200, "email verification failed");
    const registration = await request(
      baseUrl,
      "/api/signature/password/forgot",
      {
        method: "POST",
        body: { email: "owner@second.example" },
        jar: tenantJar,
      },
    );
    assert(
      registration.response.status === 200 &&
        registration.body.developmentToken,
      "password reset token was not issued in development",
    );
    result = await request(baseUrl, "/api/signature/password/reset", {
      method: "POST",
      body: {
        token: registration.body.developmentToken,
        password: "NewSecondPass123!",
      },
      jar: tenantJar,
    });
    assert(result.response.status === 200, "password reset failed");
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "owner@second.example", password: "NewSecondPass123!" },
      jar: tenantJar,
    });
    assert(result.response.status === 200, "verified tenant login failed");
    await request(baseUrl, "/api/signature/session", { jar: tenantJar });
    result = await request(baseUrl, "/api/platform/organizations", {
      jar: tenantJar,
    });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "APPLICATION_OWNER_REQUIRED",
      "tenant administrator reached the Application Owner control plane",
    );
    result = await request(baseUrl, "/api/signature/users", { jar: tenantJar });
    assert(
      result.response.status === 200 &&
        result.body.users.length === 1 &&
        result.body.users[0].email === "owner@second.example",
      "tenant isolation failed",
    );
    result = await request(baseUrl, "/api/signature/invitations", {
      method: "POST",
      body: { email: "editor@example.com", role: "viewer" },
      jar: tenantJar,
    });
    assert(
      result.response.status === 201 && result.body.developmentToken,
      "existing account invitation failed",
    );
    const secondWorkspaceJar = new Map();
    result = await request(baseUrl, "/api/signature/invitations/accept", {
      method: "POST",
      body: {
        token: result.body.developmentToken,
        name: "Editor User",
        password: "EditorPass123!",
      },
      jar: secondWorkspaceJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.role === "viewer" &&
        result.body.user.signature.fields.jobTitle === "",
      "existing account did not join second workspace",
    );
    result = await request(baseUrl, "/api/signature/upload", {
      method: "POST",
      body: { kind: "logo", dataUrl: fakeImage },
      jar: secondWorkspaceJar,
    });
    assert(result.response.status === 403, "viewer mutation was accepted");
    result = await request(baseUrl, "/api/signature/session", {
      jar: secondWorkspaceJar,
    });
    assert(
      result.body.workspaces.length === 2,
      "multi-workspace memberships were not returned",
    );
    application.db
      .prepare("UPDATE organizations SET status='suspended' WHERE id=?")
      .run(primaryOrganizationId);
    result = await request(baseUrl, "/api/signature/session/switch", {
      method: "POST",
      body: { organizationId: primaryOrganizationId },
      jar: secondWorkspaceJar,
    });
    assert(
      result.response.status === 404 &&
        result.body.error.code === "WORKSPACE_NOT_FOUND",
      "session switched into a suspended workspace",
    );
    application.db
      .prepare("UPDATE organizations SET status='active' WHERE id=?")
      .run(primaryOrganizationId);
    result = await request(baseUrl, "/api/signature/session/switch", {
      method: "POST",
      body: { organizationId: primaryOrganizationId },
      jar: secondWorkspaceJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.organizationId === primaryOrganizationId &&
        result.body.user.role === "editor" &&
        result.body.user.signature.fields.jobTitle === "Approval Candidate",
      "workspace switching failed",
    );
    result = await request(baseUrl, `/api/signature/users/${adminId}`, {
      method: "PUT",
      body: { role: "viewer" },
      jar: tenantJar,
    });
    assert(
      result.response.status === 404,
      "cross-tenant user mutation succeeded",
    );
    result = await request(baseUrl, "/api/signature/templates", {
      method: "POST",
      body: {
        name: "Rollout preset",
        signature: {
          templateId: "modernMinimal",
          colors: { accent: "#0f766e" },
          bannerUrl: "/event-banners/cloud-services-modernization.png",
        },
      },
      jar: adminJar,
    });
    assert(result.response.status === 201, "rollout preset creation failed");
    const rolloutTemplateId = result.body.template.id;
    result = await request(baseUrl, "/api/signature/departments", {
      method: "PUT",
      body: {
        department: "Security",
        templateId: "missing-template",
        accent: "#2563eb",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "TEMPLATE_INVALID",
      "invalid department template was accepted",
    );
    result = await request(baseUrl, "/api/signature/departments", {
      method: "PUT",
      body: {
        department: "Security",
        templateId: rolloutTemplateId,
        accent: "#0f766e",
      },
      jar: adminJar,
    });
    assert(result.response.status === 200, "department default save failed");
    result = await request(baseUrl, "/api/signature/departments/Security", {
      method: "DELETE",
      body: {},
      jar: adminJar,
    });
    assert(result.response.status === 200, "department default delete failed");
    result = await request(baseUrl, "/api/signature/departments/Security", {
      method: "DELETE",
      body: {},
      jar: adminJar,
    });
    assert(
      result.response.status === 404,
      "missing department default delete reported success",
    );
    result = await request(baseUrl, "/api/signature/bulk-rollout", {
      method: "POST",
      body: { templateId: "missing-template", overwrite: true },
      jar: adminJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "TEMPLATE_INVALID",
      "invalid rollout template was accepted",
    );
    result = await request(baseUrl, "/api/signature/bulk-rollout", {
      method: "POST",
      body: { templateId: rolloutTemplateId, overwrite: true, sendEmail: true },
      jar: adminJar,
    });
    assert(
      result.response.status === 202 && result.body.job?.id,
      "rollout was not queued",
    );
    const rolloutJobId = result.body.job.id;
    await application.jobQueue.runOnce();
    result = await request(baseUrl, `/api/signature/jobs/${rolloutJobId}`, {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.job.status === "completed" &&
        result.body.job.result.emailed === result.body.job.result.updated &&
        graphRequests.some((url) =>
          url.includes("users/signatures%40example.com/sendMail"),
        ),
      "rollout email did not use the tenant Microsoft connection",
    );
    result = await request(baseUrl, `/api/signature/jobs/${rolloutJobId}`, {
      jar: editorJar,
    });
    assert(
      result.response.status === 403,
      "non-admin could read tenant workflow results",
    );
    result = await request(baseUrl, "/api/signature/bulk-rollout", {
      method: "POST",
      body: { templateId: rolloutTemplateId, overwrite: true },
      jar: adminJar,
    });
    assert(
      result.response.status === 202,
      "saved-template rollout was not queued",
    );
    await application.jobQueue.runOnce();
    result = await request(
      baseUrl,
      `/api/signature/jobs/${result.body.job.id}`,
      { jar: adminJar },
    );
    assert(
      result.response.status === 200 &&
        result.body.job.status === "completed" &&
        result.body.job.result.updated === 4 &&
        result.body.job.result.skipped === 0 &&
        result.body.job.result.errors.length === 0,
      "saved-template rollout failed",
    );
    result = await request(baseUrl, "/api/signature/users", { jar: adminJar });
    assert(
      result.body.users.every(
        (member) =>
          member.signature.templateId === "modernMinimal" &&
          member.signature.fields.email === member.email,
      ),
      "rollout did not preserve member identity fields",
    );
    result = await request(baseUrl, "/api/signature/send-to-self", {
      method: "POST",
      body: { signature: { templateId: "compact" } },
      jar: editorJar,
    });
    assert(
      result.response.status === 200,
      "send-to-self did not use the tenant Microsoft connection",
    );
    application.db
      .prepare(
        "UPDATE organization_subscriptions SET status='canceled' WHERE organization_id=?",
      )
      .run(primaryOrganizationId);
    result = await request(baseUrl, "/api/signature/campaigns", {
      method: "POST",
      body: {
        title: "Blocked campaign",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 402 &&
        result.body.error.code === "SUBSCRIPTION_REQUIRED",
      "canceled subscription retained write access",
    );
    application.db
      .prepare(
        "UPDATE organization_subscriptions SET status='trialing',trial_ends_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE organization_id=?",
      )
      .run(primaryOrganizationId);
    result = await request(baseUrl, "/api/signature/campaigns", {
      method: "POST",
      body: {
        title: "Summer event",
        linkUrl: "https://example.com/event",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        overlay: {
          enabled: true,
          ctaLabel: "Reserve seat",
          badgeLabel: "QA Event",
          eventLabel: "Jul 12 · 9 AM",
          color: "#123abc",
          font: "Georgia, serif",
          fontWeight: 800,
          headlineSize: 26,
          textColor: "#fefefe",
        },
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 201 &&
        result.body.campaign.overlay.ctaLabel === "Reserve seat" &&
        result.body.campaign.overlay.font === "Georgia, serif" &&
        result.body.campaign.overlay.headlineSize === 26,
      "campaign creation or overlay persistence failed",
    );
    const campaignId = result.body.id;
    result = await request(baseUrl, `/api/signature/campaigns/${campaignId}`, {
      method: "PUT",
      body: { title: "Cross-tenant update" },
      jar: tenantJar,
    });
    assert(
      result.response.status === 404,
      "cross-tenant campaign update succeeded",
    );
    result = await request(baseUrl, `/api/signature/campaigns/${campaignId}`, {
      method: "PUT",
      body: { startDate: "2026-02-30" },
      jar: adminJar,
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "CAMPAIGN_INVALID",
      "invalid campaign update was accepted",
    );
    result = await request(baseUrl, `/api/signature/campaigns/${campaignId}`, {
      method: "PUT",
      body: {
        title: "Updated summer event",
        status: "paused",
        startDate: "2026-07-01",
        endDate: "2026-08-01",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.campaign.title === "Updated summer event" &&
        result.body.campaign.status === "paused",
      "campaign update failed",
    );
    assert(
      result.body.campaign.overlay.ctaLabel === "Reserve seat" &&
        result.body.campaign.overlay.badgeLabel === "QA Event",
      "campaign update discarded overlay metadata",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.stats.users === 4 &&
        result.body.audit.length > 0,
      "admin dashboard failed",
    );
    const workspaceSettings = result.body.workspace.settings;
    result = await request(baseUrl, "/api/signature/admin-config", {
      method: "PUT",
      body: {
        name: result.body.workspace.name,
        ...workspaceSettings,
        brand: {
          ...workspaceSettings.brand,
          locked: true,
          font: "georgia",
        },
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.workspace.settings.brand.font === "georgia",
      "brand font setting failed",
    );
    result = await request(baseUrl, "/api/signature/preview", {
      method: "POST",
      body: { userId: adminId, signature: { templateId: "executive" } },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.html.includes("Georgia, 'Times New Roman', serif"),
      "brand font was not enforced in rendered HTML",
    );
    result = await request(baseUrl, "/api/platform/session", { jar: adminJar });
    assert(
      result.response.status === 200 &&
        result.body.stats.organizations >= 2 &&
        result.body.stats.microsoftConnected >= 1,
      "Application Owner control-plane summary failed",
    );
    result = await request(baseUrl, "/api/platform/operations/backups", {
      method: "POST",
      body: { reason: "Smoke-test recovery snapshot" },
      jar: adminJar,
    });
    const smokeBackupName = result.body?.backup?.name;
    assert(
      result.response.status === 201 && smokeBackupName,
      "Application Owner could not create a backup",
    );
    result = await request(baseUrl, "/api/platform/operations", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.backups.some((backup) => backup.name === smokeBackupName),
      "Managed backup listing failed",
    );
    result = await request(
      baseUrl,
      `/api/platform/operations/backups/${encodeURIComponent(smokeBackupName)}/restore`,
      {
        method: "POST",
        body: { reason: "Reject incomplete confirmation", confirmation: "NO" },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 400 &&
        result.body.error.code === "RESTORE_CONFIRMATION_REQUIRED",
      "Restore was accepted without explicit confirmation",
    );
    application.db
      .prepare(
        `INSERT INTO background_jobs(id,type,payload_json,status,attempts,max_attempts,last_error)
         VALUES ('smoke-failed-job','provider.sync','{"secret":"must-not-leak"}','dead_lettered',5,5,'Provider timeout')`,
      )
      .run();
    result = await request(baseUrl, "/api/platform/jobs?status=dead_lettered", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.jobs.some(
          (job) =>
            job.id === "smoke-failed-job" &&
            job.lastError === "Provider timeout",
        ) &&
        !JSON.stringify(result.body).includes("must-not-leak"),
      "Application Owner job inspection failed or exposed payload data",
    );
    result = await request(
      baseUrl,
      "/api/platform/jobs/smoke-failed-job/retry",
      {
        method: "POST",
        body: { reason: "Retry provider sync" },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 202 &&
        result.body.job.status === "queued" &&
        application.db
          .prepare(
            "SELECT status,attempts,last_error FROM background_jobs WHERE id='smoke-failed-job'",
          )
          .get().attempts === 0 &&
        application.db
          .prepare(
            "SELECT COUNT(*) count FROM application_audit_logs WHERE action='application.job_retried' AND target_id='smoke-failed-job'",
          )
          .get().count === 1,
      "Failed job retry was not durable and audited",
    );
    result = await request(baseUrl, "/api/platform/organizations", {
      method: "POST",
      body: {
        name: "Control Plane Tenant",
        adminEmail: "tenant.owner@example.com",
        plan: "team",
        seats: 25,
        reason: "Smoke-test onboarding",
      },
      jar: adminJar,
      csrf: false,
    });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "CSRF_INVALID",
      "control-plane mutation without CSRF was accepted",
    );
    result = await request(baseUrl, "/api/platform/organizations", {
      method: "POST",
      body: {
        name: "Control Plane Tenant",
        adminEmail: "tenant.owner@example.com",
        plan: "team",
        seats: 25,
        reason: "Smoke-test onboarding",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 201 &&
        result.body.invitationUrl.includes("?invite=") &&
        result.body.organization.status === "active",
      "Application Owner could not create a tenant",
    );
    const controlPlaneOrganizationId = result.body.organization.id,
      controlPlaneInvitationToken = new URL(
        result.body.invitationUrl,
      ).searchParams.get("invite");
    result = await request(
      baseUrl,
      `/api/platform/organizations/${controlPlaneOrganizationId}`,
      { jar: adminJar },
    );
    assert(
      result.response.status === 200 &&
        result.body.subscription.plan === "team" &&
        result.body.subscription.seats === 25 &&
        result.body.members.length === 0,
      "new tenant detail was incorrect",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${controlPlaneOrganizationId}/subscription`,
      {
        method: "PUT",
        body: {
          plan: "business",
          status: "active",
          seats: 75,
          reason: "Contract activated",
          stripeCustomerId: "cus_platform_smoke",
          stripeSubscriptionId: "sub_platform_smoke",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200 &&
        result.body.subscription.plan === "business" &&
        result.body.subscription.seats === 75,
      "Application Owner subscription management failed",
    );
    const controlPlaneTenantJar = new Map();
    result = await request(baseUrl, "/api/signature/invitations/accept", {
      method: "POST",
      body: {
        token: controlPlaneInvitationToken,
        name: "Control Plane Tenant Admin",
        password: "ControlPlaneTenant123!",
      },
      jar: controlPlaneTenantJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.organizationId === controlPlaneOrganizationId &&
        result.body.user.role === "admin",
      "Application Owner tenant invitation did not create a Tenant Admin",
    );
    result = await request(baseUrl, "/auth/microsoft/admin-consent", {
      jar: controlPlaneTenantJar,
    });
    const duplicateConsentLocation = result.response.headers.get("location"),
      duplicateConsentState = new URL(
        duplicateConsentLocation,
      ).searchParams.get("state");
    result = await request(
      baseUrl,
      `/auth/microsoft/admin-consent/callback?state=${encodeURIComponent(duplicateConsentState)}&admin_consent=True&tenant=${consentTenantId}`,
      { jar: controlPlaneTenantJar },
    );
    assert(
      result.response.status === 409 &&
        result.body.error.code === "MICROSOFT_TENANT_ALREADY_CONNECTED",
      "one Microsoft tenant could be connected to multiple Signify tenants",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${primaryOrganizationId}/status`,
      {
        method: "PUT",
        body: { status: "suspended", reason: "Isolation regression test" },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200,
      "Application Owner could not suspend a tenant",
    );
    result = await request(baseUrl, "/api/platform/session", { jar: adminJar });
    assert(
      result.response.status === 200,
      "suspending the current tenant locked out the Application Owner",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${primaryOrganizationId}/status`,
      {
        method: "PUT",
        body: { status: "active", reason: "Isolation regression complete" },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200,
      "Application Owner could not restore a tenant",
    );
    result = await request(baseUrl, "/api/signature/billing/checkout", {
      method: "POST",
      body: { plan: "team" },
      jar: adminJar,
    });
    assert(
      result.response.status === 405,
      "tenant administrator still has a Stripe checkout endpoint",
    );
    result = await request(baseUrl, "/api/platform/audit", { jar: adminJar });
    assert(
      result.response.status === 200 &&
        result.body.audit.some((item) => item.action === "tenant.created") &&
        result.body.audit.some(
          (item) => item.action === "subscription.updated",
        ),
      "Application Owner audit trail is incomplete",
    );
    const organizationId = primaryOrganizationId,
      stripeEvent = JSON.stringify({
        id: "evt_smoke_checkout",
        object: "event",
        type: "checkout.session.completed",
        livemode: false,
        data: {
          object: {
            id: "cs_smoke",
            object: "checkout.session",
            client_reference_id: organizationId,
            metadata: { organization_id: organizationId, plan: "team" },
            customer: "cus_smoke",
            subscription: "sub_smoke",
          },
        },
      }),
      stripeSignature = Stripe.webhooks.generateTestHeaderString({
        payload: stripeEvent,
        secret: "whsec_smoke",
      });
    result = await rawRequest(baseUrl, "/webhooks/stripe", stripeEvent, {
      "Content-Type": "application/json",
      "Stripe-Signature": "invalid",
    });
    assert(
      result.response.status === 400 &&
        result.body.error.code === "STRIPE_SIGNATURE_INVALID",
      "invalid Stripe signature was accepted",
    );
    result = await rawRequest(baseUrl, "/webhooks/stripe", stripeEvent, {
      "Content-Type": "application/json",
      "Stripe-Signature": stripeSignature,
    });
    assert(result.response.status === 200, "signed Stripe webhook failed");
    result = await rawRequest(baseUrl, "/webhooks/stripe", stripeEvent, {
      "Content-Type": "application/json",
      "Stripe-Signature": stripeSignature,
    });
    assert(
      result.body?.duplicate === true,
      "Stripe webhook was not idempotent",
    );
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    assert(
      result.body.subscription.plan === "team" &&
        result.body.subscription.seats === 50 &&
        result.body.subscription.status === "active",
      "Stripe webhook did not update subscription state",
    );
    result = await request(baseUrl, "/api/platform/integrations", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.vault.configured === true &&
        result.body.stripe.source === "environment",
      "integration readiness did not expose the environment fallback",
    );
    result = await request(
      baseUrl,
      "/api/platform/integrations/stripe/connect",
      {
        method: "POST",
        body: {
          secretKey: "sk_test_setup",
          reason: "Sandbox onboarding regression",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200 &&
        result.body.integration.accountId === "acct_setup" &&
        result.body.prices.length === 2,
      "Stripe onboarding did not verify the account and discover prices",
    );
    const storedStripeIntegration = application.db
      .prepare(
        "SELECT encrypted_credentials,configuration_json FROM application_integrations WHERE provider='stripe'",
      )
      .get();
    assert(
      storedStripeIntegration.encrypted_credentials.startsWith("v1.") &&
        !storedStripeIntegration.encrypted_credentials.includes(
          "sk_test_setup",
        ),
      "Stripe credentials were not encrypted at rest",
    );
    result = await request(
      baseUrl,
      "/api/platform/integrations/stripe/configure",
      {
        method: "PUT",
        body: {
          prices: {
            starter: "price_setup_starter",
            team: "price_setup_team",
          },
          reason: "Map sandbox prices",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200 &&
        result.body.prices.team === "price_setup_team" &&
        result.body.integration.status === "connected",
      "Stripe plan mapping and webhook setup failed",
    );
    result = await request(baseUrl, "/api/platform/integrations", {
      jar: adminJar,
    });
    assert(
      result.body.stripe.configured === true &&
        result.body.stripe.catalog.length === 2 &&
        !JSON.stringify(result.body).includes("sk_test_setup") &&
        !JSON.stringify(result.body).includes("whsec_setup"),
      "Stripe integration response leaked secrets or lost its catalog",
    );
    result = await request(
      baseUrl,
      "/api/platform/integrations/stripe/test-checkout",
      {
        method: "POST",
        body: {
          plan: "starter",
          customerEmail: "sandbox@example.com",
          reason: "Sandbox Checkout regression",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 201 &&
        result.body.url === "https://checkout.stripe.test/cs_setup_test",
      "Stripe sandbox Checkout test failed",
    );
    result = await request(
      baseUrl,
      "/api/platform/integrations/stripe/test-checkout",
      {
        method: "POST",
        body: {
          plan: "starter",
          customerEmail: "fail@example.com",
          reason: "Sandbox failure regression",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 502 &&
        result.body.error.code === "STRIPE_API_FAILED",
      "Stripe downstream failure was not normalized",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${controlPlaneOrganizationId}/billing/portal`,
      { method: "POST", body: {}, jar: adminJar },
    );
    assert(
      result.response.status === 201 &&
        result.body.url === "https://billing.stripe.test/cus_platform_smoke",
      "Application Owner Stripe portal creation failed",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${controlPlaneOrganizationId}/billing/subscription`,
      {
        method: "PUT",
        body: {
          action: "change_plan",
          plan: "team",
          reason: "Provider-backed plan change",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 202 && result.body.accepted === true,
      "provider-backed Stripe plan change failed",
    );
    result = await request(
      baseUrl,
      `/api/platform/organizations/${controlPlaneOrganizationId}/billing/subscription`,
      {
        method: "PUT",
        body: {
          action: "cancel",
          reason: "Cancellation regression",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 202 && result.body.cancelAtPeriodEnd === true,
      "provider-backed Stripe cancellation failed",
    );
    result = await request(baseUrl, "/api/platform/integrations/stripe", {
      method: "DELETE",
      body: { reason: "Sandbox onboarding complete" },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 && result.body.disconnected === true,
      "Stripe integration disconnect failed",
    );
    result = await request(baseUrl, "/api/platform/setup/application", {
      method: "PUT",
      body: {
        companyName: "Signify Test Control Plane",
        publicUrl: baseUrl,
        reason: "First-run identity regression",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.companyName === "Signify Test Control Plane",
      "first-run application identity setup failed",
    );
    result = await request(
      baseUrl,
      "/api/platform/integrations/microsoft/connect",
      {
        method: "POST",
        body: {
          clientId: "33333333-3333-4333-8333-333333333333",
          clientSecret: "microsoft-setup-secret",
          homeTenantId: microsoftTenantId,
          reason: "Microsoft bootstrap regression",
        },
        jar: adminJar,
      },
    );
    assert(
      result.response.status === 200 &&
        result.body.integration.status === "connected" &&
        result.body.integration.accountName === "Smoke Microsoft Tenant",
      "Microsoft application bootstrap verification failed",
    );
    const storedMicrosoftIntegration = application.db
      .prepare(
        "SELECT encrypted_credentials FROM application_integrations WHERE provider='microsoft'",
      )
      .get();
    assert(
      storedMicrosoftIntegration.encrypted_credentials.startsWith("v1.") &&
        !storedMicrosoftIntegration.encrypted_credentials.includes(
          "microsoft-setup-secret",
        ),
      "Microsoft credentials were not encrypted at rest",
    );
    result = await request(baseUrl, "/api/platform/setup/stripe-skip", {
      method: "PUT",
      body: { skipped: true, reason: "Billing deferred for regression" },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 && result.body.skipped === true,
      "first-run Stripe deferral failed",
    );
    result = await request(baseUrl, "/api/platform/setup", { jar: adminJar });
    assert(
      result.response.status === 200 &&
        result.body.complete === true &&
        result.body.microsoft.configured === true &&
        !JSON.stringify(result.body).includes("microsoft-setup-secret"),
      "first-run readiness did not complete safely",
    );
    application.db
      .prepare(
        `INSERT INTO application_owners(user_id,status,granted_by) VALUES (?,'active',?) ON CONFLICT(user_id) DO UPDATE SET status='active'`,
      )
      .run(editorId, adminId);
    application.db
      .prepare("DELETE FROM organization_memberships WHERE user_id=?")
      .run(editorId);
    editorJar.clear();
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: { email: "editor@example.com", password: "EditorPass123!" },
      jar: editorJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.applicationOwner === true &&
        result.body.user.organizationId === null,
      `Application Owner without a tenant membership could not sign in: ${result.response.status} ${JSON.stringify(result.body)}`,
    );
    result = await request(baseUrl, "/api/platform/session", {
      jar: editorJar,
    });
    assert(
      result.response.status === 200,
      "tenant-independent Application Owner session failed",
    );
    application.config.signature.requireOwnerMfa = true;
    result = await request(baseUrl, "/api/platform/owners", { jar: adminJar });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "OWNER_MFA_REQUIRED",
      "required MFA policy did not block an unenrolled owner",
    );
    result = await request(baseUrl, "/api/platform/session", { jar: adminJar });
    assert(
      result.response.status === 200 && result.body.mfa.required === true,
      "required MFA policy was not reported to the control plane",
    );
    result = await request(baseUrl, "/api/platform/mfa/enroll", {
      method: "POST",
      body: { password: "wrong" },
      jar: adminJar,
    });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "PASSWORD_INVALID",
      "MFA enrollment accepted an invalid current password",
    );
    result = await request(baseUrl, "/api/platform/mfa/enroll", {
      method: "POST",
      body: { password: "SignifyDemo123!" },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.secret &&
        result.body.qrCode.startsWith("data:image/png"),
      "MFA enrollment did not return a scannable authenticator secret",
    );
    const ownerTotp = new OTPAuth.TOTP({
      issuer: "Signify Creator",
      label: "admin@signify.local",
      secret: OTPAuth.Secret.fromBase32(result.body.secret),
    });
    result = await request(baseUrl, "/api/platform/mfa/confirm", {
      method: "POST",
      body: { code: ownerTotp.generate() },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 && result.body.recoveryCodes.length === 10,
      "MFA confirmation or recovery-code generation failed",
    );
    const [firstRecoveryCode, secondRecoveryCode, disableRecoveryCode] =
      result.body.recoveryCodes;
    result = await request(baseUrl, "/api/platform/session", { jar: adminJar });
    assert(
      result.body.mfa.enabled === true &&
        result.body.mfa.recoveryCodesRemaining === 10,
      "MFA status did not reflect enrollment",
    );
    adminJar.clear();
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: {
        email: "admin@signify.local",
        password: "SignifyDemo123!",
      },
      jar: adminJar,
    });
    assert(
      result.response.status === 202 && result.body.mfaRequired,
      "Application Owner login bypassed enabled MFA",
    );
    let mfaChallenge = result.body.challenge;
    result = await request(baseUrl, "/api/signature/login/mfa", {
      method: "POST",
      body: { challenge: mfaChallenge, code: firstRecoveryCode },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 && adminJar.has("sig_session"),
      "one-time MFA recovery login failed",
    );
    adminJar.clear();
    result = await request(baseUrl, "/api/signature/login", {
      method: "POST",
      body: {
        email: "admin@signify.local",
        password: "SignifyDemo123!",
      },
      jar: adminJar,
    });
    mfaChallenge = result.body.challenge;
    result = await request(baseUrl, "/api/signature/login/mfa", {
      method: "POST",
      body: { challenge: mfaChallenge, code: firstRecoveryCode },
      jar: adminJar,
    });
    assert(
      result.response.status === 401 &&
        result.body.error.code === "MFA_INVALID",
      "used MFA recovery code was accepted again",
    );
    result = await request(baseUrl, "/api/signature/login/mfa", {
      method: "POST",
      body: { challenge: mfaChallenge, code: secondRecoveryCode },
      jar: adminJar,
    });
    assert(result.response.status === 200, "second MFA recovery login failed");
    result = await request(baseUrl, "/api/platform/mfa", {
      method: "DELETE",
      body: {
        password: "SignifyDemo123!",
        code: disableRecoveryCode,
        reason: "Smoke-test MFA lifecycle",
      },
      jar: adminJar,
    });
    assert(result.response.status === 200, "MFA disable workflow failed");
    result = await request(baseUrl, "/api/platform/owners", { jar: adminJar });
    assert(
      result.response.status === 403 &&
        result.body.error.code === "OWNER_MFA_REQUIRED",
      "required MFA policy did not resume after MFA was disabled",
    );
    application.config.signature.requireOwnerMfa = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      result = await request(baseUrl, "/api/signature/login", {
        method: "POST",
        body: { email: "nobody@example.com", password: "wrong" },
      });
      if (result.response.status === 429) break;
    }
    assert(
      result.response.status === 429 &&
        result.body.error.code === "RATE_LIMITED" &&
        Number(result.response.headers.get("retry-after")) > 0,
      "authentication rate limiting failed",
    );
    assert(
      application.db.prepare("PRAGMA integrity_check").get().integrity_check ===
        "ok",
      "database integrity check failed",
    );
    assert(
      application.db.prepare("PRAGMA foreign_key_check").all().length === 0,
      "database foreign-key check failed",
    );
    assert(
      application.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version='008_query_indexes.sql'",
        )
        .get(),
      "query index migration was not applied",
    );
    assert(
      application.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version='009_stable_starter_plan.sql'",
        )
        .get(),
      "stable Starter plan migration was not applied",
    );
    assert(
      application.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version='010_application_control_plane.sql'",
        )
        .get(),
      "Application Owner control-plane migration was not applied",
    );
    assert(
      application.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version='011_microsoft_oidc_hardening.sql'",
        )
        .get(),
      "Microsoft OIDC hardening migration was not applied",
    );
    assert(
      application.db
        .prepare(
          "SELECT 1 FROM schema_migrations WHERE version='012_application_integrations.sql'",
        )
        .get(),
      "application integration migration was not applied",
    );
    await new Promise((resolve) => server.close(resolve));
    application.db.close();
    const oldEncryptionKey = env.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY,
      newEncryptionKey = Buffer.alloc(32, 9).toString("base64"),
      rotation = spawnSync(
        process.execPath,
        [path.join(__dirname, "rotate-integration-credentials.cjs")],
        {
          cwd: path.join(__dirname, ".."),
          env: {
            ...env,
            SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY: oldEncryptionKey,
            SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: newEncryptionKey,
          },
          encoding: "utf8",
        },
      );
    assert(
      rotation.status === 0 && rotation.stdout.includes("Rotated 1"),
      `credential rotation failed: ${rotation.stderr || rotation.stdout}`,
    );
    env.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY = newEncryptionKey;
    application = createApplication({ env });
    server = http.createServer(application.handler);
    const reopened = await listen(server);
    result = await request(reopened, "/api/health");
    assert(result.response.status === 200, "existing database reopen failed");
    const rotatedMicrosoft = application.db
      .prepare(
        "SELECT encrypted_credentials FROM application_integrations WHERE provider='microsoft'",
      )
      .get();
    assert(
      createCredentialVault(newEncryptionKey).decrypt(
        "microsoft",
        rotatedMicrosoft.encrypted_credentials,
      ).clientSecret === "microsoft-setup-secret",
      "rotated Microsoft credentials could not be decrypted",
    );
    let retiredKeyRejected = false;
    try {
      createCredentialVault(oldEncryptionKey).decrypt(
        "microsoft",
        rotatedMicrosoft.encrypted_credentials,
      );
    } catch (error) {
      retiredKeyRejected = error.code === "CREDENTIAL_DECRYPT_FAILED";
    }
    assert(retiredKeyRejected, "retired credential key still decrypted data");
    console.log(
      "Smoke test passed: migrations, three-tier RBAC, Application Owner MFA and control plane, tenant lifecycle, owner-only Stripe, tenant Microsoft consent, request validation, auth, browser-bound OAuth state, verification retry, invitations, CSRF, tenant isolation, workspace switching, approval integrity, atomic updates, subscription enforcement, recovery, Microsoft directory pagination, image normalization, templates, rollout, campaigns, brand rendering, Stripe webhooks, rate limiting, database integrity, and reopen",
    );
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    try {
      application.db.close();
    } catch (error) {
      if (!String(error.message).includes("database is not open")) throw error;
    }
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}
main().catch((error) => {
  console.error(`Smoke test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
