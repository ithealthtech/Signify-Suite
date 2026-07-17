"use strict";
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const Stripe = require("stripe");
const { createApplication } = require("../server.cjs");

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
    SIGNATURE_ALLOW_DEFAULT_ADMIN: "true",
    SIGNIFY_ALLOW_REGISTRATION: "true",
    SIGNIFY_BOOTSTRAP_EMAIL: "admin@signify.local",
    SIGNIFY_BOOTSTRAP_PASSWORD: "SignifyDemo123!",
    STRIPE_SECRET_KEY: "sk_test_smoke",
    STRIPE_WEBHOOK_SECRET: "whsec_smoke",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_TEAM: "price_team",
    LOG_LEVEL: "silent",
  };
  let application = createApplication({ env }),
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
    result = await request(baseUrl, "/signature.html");
    assert(
      result.response.status === 200 &&
        result.text.includes("Every signature. One standard."),
      "studio page failed",
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
    result = await request(baseUrl, "/api/signature/session", {
      jar: adminJar,
    });
    assert(result.body?.user?.role === "admin", "admin session failed");
    const primaryOrganizationId = result.body.user.organizationId;
    result = await request(baseUrl, "/api/signature/users", { jar: adminJar });
    assert(
      result.response.status === 200 && result.body.users.length === 1,
      "tenant user list failed",
    );
    const adminId = result.body.users[0].id;
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
        },
      },
      jar: editorJar,
    });
    assert(
      result.response.status === 200,
      `editor signature update failed: ${result.response.status} ${result.text}`,
    );
    assert(
      result.body.user.signature.fields.website === "" &&
        result.body.user.signature.fields.jobTitle ===
          "Primary Workspace Role" &&
        result.body.user.signature.colors.accent === "#2563eb",
      "signature sanitization failed",
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
    const verificationToken = result.body.developmentToken;
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
    result = await request(baseUrl, "/api/signature/session/switch", {
      method: "POST",
      body: { organizationId: primaryOrganizationId },
      jar: secondWorkspaceJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.user.organizationId === primaryOrganizationId &&
        result.body.user.role === "editor" &&
        result.body.user.signature.fields.jobTitle === "Primary Workspace Role",
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
      },
      jar: adminJar,
    });
    assert(result.response.status === 201, "campaign creation failed");
    result = await request(baseUrl, "/api/signature/admin-config", {
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.stats.users === 2 &&
        result.body.audit.length > 0,
      "admin dashboard failed",
    );
    const organizationId = result.body.workspace.id,
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
    for (let attempt = 0; attempt < 7; attempt += 1)
      result = await request(baseUrl, "/api/signature/login", {
        method: "POST",
        body: { email: "nobody@example.com", password: "wrong" },
      });
    assert(
      result.response.status === 429 &&
        result.body.error.code === "RATE_LIMITED" &&
        Number(result.response.headers.get("retry-after")) > 0,
      "authentication rate limiting failed",
    );
    await new Promise((resolve) => server.close(resolve));
    application.db.close();
    application = createApplication({ env });
    server = http.createServer(application.handler);
    const reopened = await listen(server);
    result = await request(reopened, "/api/health");
    assert(result.response.status === 200, "existing database reopen failed");
    console.log(
      "Smoke test passed: migrations, auth, invitations, CSRF, RBAC, tenant isolation, workspace switching, subscription enforcement, recovery, uploads, campaigns, Stripe webhooks, rate limiting, and database reopen",
    );
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    try {
      application.db.close();
    } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`Smoke test failed: ${error.message}`);
  process.exitCode = 1;
});
