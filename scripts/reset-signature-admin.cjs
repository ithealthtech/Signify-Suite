"use strict";
const { randomBytes, scryptSync } = require("node:crypto");
const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(String(password), salt, 64).toString("hex")}`;
}

const email = String(
  process.env.SIGNATURE_ADMIN_EMAIL || "admin@itdoneright.com",
)
  .trim()
  .toLowerCase();
const password =
  process.env.SIGNATURE_ADMIN_PASSWORD ||
  `Temp-${randomBytes(9).toString("base64url")}!`;
if (password.length < 10)
  throw new Error("SIGNATURE_ADMIN_PASSWORD must be at least 10 characters.");

const db = openDatabase(loadConfig().databasePath);
try {
  const user = db
    .prepare("SELECT id,email FROM signature_users WHERE lower(email)=lower(?)")
    .get(email);
  if (!user) throw new Error(`No signature user found for ${email}.`);
  const memberships = db
      .prepare(
        `SELECT m.organization_id,o.name FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? ORDER BY o.name`,
      )
      .all(user.id),
    requestedOrganization = String(
      process.env.SIGNATURE_ORGANIZATION_ID || "",
    ).trim(),
    membership = requestedOrganization
      ? memberships.find(
          (item) => item.organization_id === requestedOrganization,
        )
      : memberships.length === 1
        ? memberships[0]
        : null;
  if (!membership)
    throw new Error(
      memberships.length > 1
        ? `Account belongs to multiple workspaces. Set SIGNATURE_ORGANIZATION_ID to one of: ${memberships.map((item) => item.organization_id).join(", ")}`
        : "No matching workspace membership found for this account.",
    );
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE signature_users SET password_hash=?,role='admin',status='active',email_verified_at=COALESCE(email_verified_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(hashPassword(password), user.id);
    db.prepare(
      `UPDATE organization_memberships SET role='admin',status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND user_id=?`,
    ).run(membership.organization_id, user.id);
    db.prepare("DELETE FROM signature_sessions WHERE user_id=?").run(user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(
    `Signature admin reset\nWorkspace: ${membership.name}\nEmail: ${user.email}\nPassword: ${password}`,
  );
} finally {
  db.close();
}
