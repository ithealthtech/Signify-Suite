"use strict";
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const Stripe = require("stripe");
const sharp = require("sharp");
const { createApplication } = require("../server.cjs");
const { loadConfig } = require("../server/config.cjs");
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
    SIGNATURE_ALLOW_DEFAULT_ADMIN: "true",
    SIGNIFY_ALLOW_REGISTRATION: "true",
    SIGNIFY_BOOTSTRAP_EMAIL: "admin@signify.local",
    SIGNIFY_BOOTSTRAP_PASSWORD: "SignifyDemo123!",
    STRIPE_SECRET_KEY: "sk_test_smoke",
    STRIPE_WEBHOOK_SECRET: "whsec_smoke",
    STRIPE_PRICE_STARTER: "price_starter",
    STRIPE_PRICE_TEAM: "price_team",
    MICROSOFT_CLIENT_ID: "client-smoke",
    MICROSOFT_CLIENT_SECRET: "secret-smoke",
    MICROSOFT_TENANT_ID: "tenant-smoke",
    LOG_LEVEL: "silent",
  };
  const graphRequests = [],
    graphResponse = (payload) => ({
      status: 200,
      ok: true,
      json: async () => payload,
    }),
    fetchImpl = async (input) => {
      const url = String(input);
      graphRequests.push(url);
      if (url.includes("login.microsoftonline.com"))
        return graphResponse({ access_token: "graph-token" });
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
  let application = createApplication({ env, fetchImpl }),
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
    assert(
      loadConfig({
        NODE_ENV: "production",
        SIGNIFY_PUBLIC_URL: "https://signatures.example.com",
      }).signature.publicUrl === "https://signatures.example.com",
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
    application.db
      .prepare("UPDATE organization_subscriptions SET seats=100")
      .run();
    result = await request(baseUrl, "/api/signature/directory-sync", {
      method: "POST",
      body: {},
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body?.seen === 2 &&
        result.body?.added === 2 &&
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
    assert(result.body?.user?.role === "admin", "admin session failed");
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
      result.response.status === 503 &&
        result.body.error.code === "MAIL_NOT_CONFIGURED",
      "rollout email ran without Microsoft mail configuration",
    );
    result = await request(baseUrl, "/api/signature/bulk-rollout", {
      method: "POST",
      body: { templateId: rolloutTemplateId, overwrite: true },
      jar: adminJar,
    });
    assert(
      result.response.status === 200 &&
        result.body.updated === 4 &&
        result.body.skipped === 0 &&
        result.body.errors.length === 0,
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
      result.response.status === 503 &&
        result.body.error.code === "MAIL_NOT_CONFIGURED",
      "send-to-self ran without Microsoft mail configuration",
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
    await new Promise((resolve) => server.close(resolve));
    application.db.close();
    application = createApplication({ env });
    server = http.createServer(application.handler);
    const reopened = await listen(server);
    result = await request(reopened, "/api/health");
    assert(result.response.status === 200, "existing database reopen failed");
    console.log(
      "Smoke test passed: migrations, request validation, auth, browser-bound OAuth state, verification retry, invitations, CSRF, RBAC, tenant isolation, workspace switching, approval integrity, atomic updates, subscription enforcement, recovery, Microsoft directory pagination, image normalization, templates, rollout, campaigns, brand rendering, Stripe webhooks, rate limiting, database integrity, and reopen",
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
