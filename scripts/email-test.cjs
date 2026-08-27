"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { applicationReadiness } = require("../server/readiness.cjs");
const { diagnose } = require("./doctor.cjs");
const {
  address,
  createTransactionalEmail,
  plainText,
} = require("../server/transactional-email.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-email-")),
    encryptionKey = Buffer.alloc(32, 7).toString("base64"),
    config = {
      production: true,
      databasePath: path.join(root, "signify.db"),
      signature: {
        publicUrl: "https://signify.example.test",
        credentialEncryptionKey: encryptionKey,
      },
      mail: {
        provider: "resend",
        apiKey: "re_environment_test_key",
        from: "Signify <noreply@example.test>",
        replyTo: "support@example.test",
        endpoint: "https://api.resend.com",
      },
    },
    db = openDatabase(config.databasePath),
    requests = [];
  let attempts = 0;
  const email = createTransactionalEmail({
    config,
    db,
    wait: async () => {},
    fetchImpl: async (url, options) => {
      attempts += 1;
      requests.push({ url, options });
      if (attempts === 1)
        return {
          ok: false,
          status: 500,
          headers: { get: () => "0" },
          json: async () => ({ message: "temporary" }),
        };
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "email_test_123" }),
      };
    },
  });
  assert.equal(
    address("Signify <noreply@example.test>"),
    "Signify <noreply@example.test>",
  );
  assert.equal(address("bad\r\nBcc: attacker@example.test"), "");
  assert.match(plainText("<p>Hello<br>World</p>"), /Hello\nWorld/);
  const delivery = await email.send({
    to: "person@example.test",
    subject: "Verify your account",
    html: "<p>Verification message</p>",
    idempotencyKey: "verification/test-user",
  });
  assert.equal(delivery.id, "email_test_123");
  assert.equal(attempts, 2);
  const sent = JSON.parse(requests.at(-1).options.body);
  assert.deepEqual(sent.to, ["person@example.test"]);
  assert.equal(sent.reply_to, "support@example.test");
  assert.equal(
    requests.at(-1).options.headers["Idempotency-Key"],
    "verification/test-user",
  );
  assert.equal(
    requests.at(-1).options.headers.Authorization,
    "Bearer re_environment_test_key",
  );

  const vault = createCredentialVault(encryptionKey);
  db.prepare(
    `INSERT INTO application_integrations(provider,status,mode,account_name,configuration_json,encrypted_credentials,credential_key_id,last_verified_at) VALUES ('email','connected','resend','Signify',?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ).run(
    JSON.stringify({
      from: "Signify Cloud <cloud@example.test>",
      replyTo: "help@example.test",
      endpoint: "https://api.resend.com",
    }),
    vault.encrypt("email", { apiKey: "re_vault_test_key" }),
    vault.keyId,
  );
  const stored = email.summary();
  assert.equal(stored.configured, true);
  assert.equal(stored.source, "vault");
  assert.equal(stored.from, "Signify Cloud <cloud@example.test>");
  const diagnostics = diagnose({
    ...config,
    backupPath: path.join(root, "backups"),
    jobMode: "embedded",
    mediaStorage: "local",
    recovery: { mode: "local" },
  });
  assert.equal(diagnostics.ok, true);
  assert.match(
    diagnostics.checks.find((check) => check.id === "transactional_email")
      .detail,
    /resend configured from vault/,
  );

  const setupReadiness = applicationReadiness({
    config: { ...config, mail: { provider: "disabled" } },
    db,
    installer: { required: () => true },
    runtimeHealth: { ready: true },
    transactionalEmail: { summary: () => ({ configured: false }) },
    version: "1.1.0",
  });
  assert.equal(setupReadiness.status, "setup_required");
  const optionalReadiness = applicationReadiness({
    config,
    db,
    installer: { required: () => false },
    runtimeHealth: { ready: true },
    transactionalEmail: { summary: () => ({ configured: false }) },
    version: "1.1.0",
  });
  assert.equal(optionalReadiness.status, "ok");
  assert(
    optionalReadiness.checks.some(
      (check) =>
        check.id === "transactional_email" && !check.required && !check.ok,
    ),
  );
  const blockedReadiness = applicationReadiness({
    config: {
      ...config,
      signature: { ...config.signature, allowRegistration: true },
    },
    db,
    installer: { required: () => false },
    runtimeHealth: { ready: true },
    transactionalEmail: { summary: () => ({ configured: false }) },
    version: "1.1.0",
  });
  assert.equal(blockedReadiness.status, "unavailable");
  assert(
    blockedReadiness.checks.some(
      (check) =>
        check.id === "transactional_email" && check.required && !check.ok,
    ),
  );
  const ready = applicationReadiness({
    config,
    db,
    installer: { required: () => false },
    runtimeHealth: { ready: true },
    transactionalEmail: email,
    version: "1.1.0",
  });
  assert.equal(ready.status, "ok");

  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    "Transactional email tests passed: encrypted configuration, retry, idempotency, validation, and production readiness",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
