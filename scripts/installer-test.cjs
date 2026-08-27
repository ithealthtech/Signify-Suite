"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createApplication } = require("../server.cjs");

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
      redirect: "manual",
      ...options,
      headers: options.body ? { "Content-Type": "application/json" } : {},
    }),
    text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { response, body, text };
}

async function main() {
  const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-installer-test-"),
    ),
    setupToken = "installer-test-token-that-is-at-least-32-characters",
    ownerPassword = "InstallerOwner123!",
    application = createApplication({
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_PATH: path.join(temporary, "data", "signify.db"),
        BACKUP_DIR: path.join(temporary, "backups"),
        SIGNATURE_ALLOW_DEFAULT_ADMIN: "false",
        SIGNIFY_PUBLIC_URL: "https://install.example.com",
        SIGNIFY_ASSET_BASE_URL: "https://install.example.com",
        SIGNIFY_MEDIA_BASE_URL: "https://install.example.com",
        SIGNIFY_COMPANY_NAME: "Initial Workspace",
        SIGNIFY_APPLICATION_OWNER_EMAIL: "owner@example.com",
        SIGNIFY_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString(
          "base64",
        ),
        SIGNIFY_SETUP_TOKEN: setupToken,
        SIGNIFY_JOB_MODE: "embedded",
        LOG_LEVEL: "silent",
      },
    }),
    server = http.createServer(application.handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`,
    installBody = {
      setupToken,
      companyName: "Installed Company",
      publicUrl: "https://install.example.com",
      name: "Application Owner",
      email: "owner@example.com",
      password: ownerPassword,
      confirmPassword: ownerPassword,
    };
  try {
    let result = await request(baseUrl, "/api/setup/status");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.required, true);
    assert.equal(result.body.available, true);
    assert.equal(result.body.license.edition, "community");
    assert.equal(result.body.license.maxTenants, 1);
    assert.ok(result.body.license.installationId);
    assert.equal(JSON.stringify(result.body).includes(setupToken), false);

    result = await request(baseUrl, "/signature.html");
    assert.equal(result.response.status, 302);
    assert.equal(result.response.headers.get("location"), "/setup.html");

    result = await request(baseUrl, "/api/signature/me");
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error.code, "INSTALLATION_REQUIRED");

    result = await request(baseUrl, "/api/setup/install", {
      method: "POST",
      body: JSON.stringify({ ...installBody, setupToken: "incorrect-token" }),
    });
    assert.equal(result.response.status, 401);

    result = await request(baseUrl, "/api/setup/install", {
      method: "POST",
      body: JSON.stringify({ ...installBody, confirmPassword: "mismatch" }),
    });
    assert.equal(result.response.status, 400);

    result = await request(baseUrl, "/api/setup/install", {
      method: "POST",
      body: JSON.stringify(installBody),
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.body.installed, true);

    const databaseState = application.db
      .prepare(
        `SELECT u.email,u.display_name,o.status owner_status,m.role membership_role
         FROM signature_users u
         JOIN application_owners o ON o.user_id=u.id
         JOIN organization_memberships m ON m.user_id=u.id
         WHERE u.email=?`,
      )
      .get("owner@example.com");
    assert.deepEqual(
      { ...databaseState },
      {
        email: "owner@example.com",
        display_name: "Application Owner",
        owner_status: "active",
        membership_role: "admin",
      },
    );
    assert.ok(
      application.db
        .prepare(
          "SELECT setting_value FROM application_settings WHERE setting_key='installation_completed'",
        )
        .get()?.setting_value,
    );

    result = await request(baseUrl, "/api/setup/install", {
      method: "POST",
      body: JSON.stringify(installBody),
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "SETUP_LOCKED");

    application.db
      .prepare("UPDATE application_owners SET status='disabled'")
      .run();
    result = await request(baseUrl, "/api/setup/status");
    assert.equal(result.body.required, false);

    result = await request(baseUrl, "/signature.html");
    assert.equal(result.response.status, 200);
    console.log(
      "Installer test passed: readiness, setup gate, token validation, atomic owner provisioning, persistence lock, and application unlock",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    application.db.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Installer test failed: ${error.stack || error.message}`);
  process.exitCode = 1;
});
