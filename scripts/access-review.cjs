"use strict";

const { loadConfig } = require("../server/config.cjs");
const { openDatabase } = require("../server/database.cjs");

const config = loadConfig(),
  db = openDatabase(config.databasePath);
try {
  const owners = db
    .prepare(
      `SELECT u.id,u.email,u.display_name,a.status,a.created_at granted_at,
      CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END mfa_enrolled,
      u.last_login_at,
      (SELECT COUNT(*) FROM signature_sessions s WHERE s.user_id=u.id AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) active_sessions,
      (SELECT MAX(created_at) FROM application_audit_logs l WHERE l.actor_user_id=u.id) last_privileged_action
      FROM application_owners a
      JOIN signature_users u ON u.id=a.user_id
      LEFT JOIN application_owner_mfa m ON m.user_id=u.id
      ORDER BY a.status,u.email`,
    )
    .all();
  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        policy: {
          activeOwnersRequireMfa: config.signature.requireOwnerMfa,
          reviewCadenceDays: 90,
        },
        owners: owners.map((owner) => ({
          id: owner.id,
          email: owner.email,
          displayName: owner.display_name,
          status: owner.status,
          mfaEnrolled: Boolean(owner.mfa_enrolled),
          activeSessions: owner.active_sessions,
          grantedAt: owner.granted_at,
          lastLoginAt: owner.last_login_at,
          lastPrivilegedAction: owner.last_privileged_action,
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  db.close();
}
