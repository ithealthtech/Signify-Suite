"use strict";
const { loadConfig } = require("../server/config.cjs");
const { createCredentialVault } = require("../server/credential-vault.cjs");
const { openDatabase } = require("../server/database.cjs");

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
if (oldVault.keyId === newVault.keyId)
  throw new Error("The old and new credential keys must be different.");

const db = openDatabase(config.databasePath);
try {
  const rows = db
    .prepare(
      "SELECT provider,encrypted_credentials FROM application_integrations WHERE encrypted_credentials IS NOT NULL",
    )
    .all();
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare(
      `UPDATE application_integrations SET encrypted_credentials=?,credential_key_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider=?`,
    );
    for (const row of rows)
      update.run(
        newVault.encrypt(
          row.provider,
          oldVault.decrypt(row.provider, row.encrypted_credentials),
        ),
        newVault.keyId,
        row.provider,
      );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(
    `Rotated ${rows.length} integration credential record(s) to key ${newVault.keyId}.`,
  );
} finally {
  db.close();
}
