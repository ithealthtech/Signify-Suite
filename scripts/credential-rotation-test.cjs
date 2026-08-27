"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { openDatabase } = require("../server/database.cjs");
const { hashPassword } = require("../server/auth-security.cjs");
const { rotateCredentials } = require("./rotate-integration-credentials.cjs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signify-rotation-")),
  db = openDatabase(path.join(directory, "rotation.db")),
  oldVault = createCredentialVault(Buffer.alloc(32, 3).toString("base64")),
  newVault = createCredentialVault(Buffer.alloc(32, 9).toString("base64"));
try {
  db.prepare(
    "INSERT INTO organizations(id,name,slug) VALUES ('tenant','Tenant','tenant')",
  ).run();
  db.prepare(
    `INSERT INTO outlook_addin_deployments(organization_id,deployment_id,token_hash,encrypted_token,credential_key_id)
     VALUES ('tenant','11111111-1111-4111-8111-111111111111','hash',?,?)`,
  ).run(
    oldVault.encrypt("outlook-addin:tenant", { token: "deployment-secret" }),
    oldVault.keyId,
  );
  db.prepare(
    "INSERT INTO signature_users(id,email,password_hash,display_name,role) VALUES ('owner','owner@example.com',?,'Owner','admin')",
  ).run(hashPassword("RotationTest123!"));
  db.prepare(
    `INSERT INTO application_integrations(provider,status,encrypted_credentials,credential_key_id)
     VALUES ('microsoft','connected',?,?)`,
  ).run(
    oldVault.encrypt("microsoft", { clientSecret: "integration-secret" }),
    oldVault.keyId,
  );
  db.prepare(
    `INSERT INTO application_owner_mfa(user_id,status,encrypted_secret,credential_key_id)
     VALUES ('owner','enabled',?,?)`,
  ).run(
    oldVault.encrypt("mfa:owner", { secret: "JBSWY3DPEHPK3PXP" }),
    oldVault.keyId,
  );
  assert.deepEqual(rotateCredentials(db, oldVault, newVault), {
    integrations: 1,
    mfa: 1,
    outlookDeployments: 1,
  });
  const integration = db
      .prepare(
        "SELECT * FROM application_integrations WHERE provider='microsoft'",
      )
      .get(),
    mfa = db
      .prepare("SELECT * FROM application_owner_mfa WHERE user_id='owner'")
      .get(),
    outlook = db
      .prepare(
        "SELECT * FROM outlook_addin_deployments WHERE organization_id='tenant'",
      )
      .get();
  assert.equal(integration.credential_key_id, newVault.keyId);
  assert.equal(mfa.credential_key_id, newVault.keyId);
  assert.equal(outlook.credential_key_id, newVault.keyId);
  assert.equal(
    newVault.decrypt("microsoft", integration.encrypted_credentials)
      .clientSecret,
    "integration-secret",
  );
  assert.equal(
    newVault.decrypt("mfa:owner", mfa.encrypted_secret).secret,
    "JBSWY3DPEHPK3PXP",
  );
  assert.equal(
    newVault.decrypt("outlook-addin:tenant", outlook.encrypted_token).token,
    "deployment-secret",
  );
  assert.throws(() => oldVault.decrypt("mfa:owner", mfa.encrypted_secret));
  console.log(
    "Credential rotation test passed: integrations, MFA, and Outlook deployment secrets rotate atomically",
  );
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
