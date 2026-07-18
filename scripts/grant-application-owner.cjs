"use strict";
const path = require("node:path");
const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");

const config = loadConfig(process.env, path.join(__dirname, "..")),
  email = String(
    process.env.SIGNIFY_OWNER_EMAIL || config.signature.applicationOwnerEmail,
  )
    .trim()
    .toLowerCase(),
  db = openDatabase(config.databasePath);

try {
  const account = db
    .prepare(
      "SELECT id,email,display_name FROM signature_users WHERE lower(email)=lower(?)",
    )
    .get(email);
  if (!account) throw new Error(`No Signify account exists for ${email}.`);
  db.prepare(
    `INSERT INTO application_owners(user_id,status) VALUES (?,'active') ON CONFLICT(user_id) DO UPDATE SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(account.id);
  console.log(
    JSON.stringify({
      status: "ok",
      action: "application_owner.granted_offline",
      userId: account.id,
      email: account.email,
    }),
  );
} finally {
  db.close();
}
