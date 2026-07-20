"use strict";
const { loadConfig } = require("../server/config.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { openDatabase } = require("../server/database.cjs");

function rotateCredentials(db, oldVault, newVault) {
  if (!oldVault.configured || !newVault.configured)
    throw new Error("Both old and new credential keys are required.");
  if (oldVault.keyId === newVault.keyId)
    throw new Error("The old and new credential keys must be different.");
  const integrations = db
      .prepare(
        "SELECT provider,encrypted_credentials FROM application_integrations WHERE encrypted_credentials IS NOT NULL",
      )
      .all(),
    mfaRecords = db
      .prepare(
        "SELECT user_id,encrypted_secret FROM application_owner_mfa WHERE encrypted_secret<>''",
      )
      .all();
  db.exec("BEGIN IMMEDIATE");
  try {
    const updateIntegration = db.prepare(
        `UPDATE application_integrations SET encrypted_credentials=?,credential_key_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider=?`,
      ),
      updateMfa = db.prepare(
        `UPDATE application_owner_mfa SET encrypted_secret=?,credential_key_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?`,
      );
    for (const row of integrations)
      updateIntegration.run(
        newVault.encrypt(
          row.provider,
          oldVault.decrypt(row.provider, row.encrypted_credentials),
        ),
        newVault.keyId,
        row.provider,
      );
    for (const row of mfaRecords) {
      const context = `mfa:${row.user_id}`;
      updateMfa.run(
        newVault.encrypt(
          context,
          oldVault.decrypt(context, row.encrypted_secret),
        ),
        newVault.keyId,
        row.user_id,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { integrations: integrations.length, mfa: mfaRecords.length };
}

function main() {
  const config = loadConfig(process.env),
    oldVault = createCredentialVault(
      process.env.SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY,
    ),
    newVault = createCredentialVault(
      process.env.SIGNIFY_CREDENTIAL_ENCRYPTION_KEY,
    );
  if (!oldVault.configured || !newVault.configured)
    throw new Error(
      "Set SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY and SIGNIFY_CREDENTIAL_ENCRYPTION_KEY before rotating credentials.",
    );
  const db = openDatabase(config.databasePath);
  try {
    const result = rotateCredentials(db, oldVault, newVault);
    console.log(
      `Rotated ${result.integrations} integration and ${result.mfa} MFA credential record(s) to key ${newVault.keyId}.`,
    );
  } finally {
    db.close();
  }
}

if (require.main === module) main();
module.exports = { rotateCredentials };
