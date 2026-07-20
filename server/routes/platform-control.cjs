"use strict";

const { randomUUID } = require("node:crypto");
const { limited, safeJson } = require("../validation.cjs");

const FLAG_KEYS = Object.freeze(["campaigns", "directory_sync", "tracking"]);

function flagState(db, organizationId) {
  const rows = db
      .prepare(
        `SELECT flag_key,enabled,configuration_json,organization_id FROM feature_flags
         WHERE organization_id IS NULL OR organization_id=?
         ORDER BY organization_id IS NULL DESC`,
      )
      .all(organizationId),
    flags = Object.fromEntries(
      FLAG_KEYS.map((key) => [key, { enabled: true, configuration: {} }]),
    );
  for (const row of rows)
    flags[row.flag_key] = {
      enabled: Boolean(row.enabled),
      configuration: safeJson(row.configuration_json),
      scope: row.organization_id ? "tenant" : "global",
    };
  return flags;
}

function featureEnabled(db, organizationId, key) {
  return flagState(db, organizationId)[key]?.enabled !== false;
}

function createPlatformControlRoutes({
  db,
  json,
  readJsonBody,
  recordAudit,
  packageVersion,
  mediaStorage,
}) {
  async function routes({ req, res, url, requestId, owner }) {
    if (
      url.pathname === "/api/platform/control/overview" &&
      req.method === "GET"
    ) {
      const organizations = db
          .prepare(
            `SELECT COUNT(*) total,
             SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,
             SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) suspended
             FROM organizations`,
          )
          .get(),
        usage = db
          .prepare(
            `SELECT
             (SELECT COUNT(*) FROM signature_users) users,
             (SELECT COUNT(*) FROM organization_memberships WHERE status='active') memberships,
             (SELECT COUNT(*) FROM signature_templates) templates,
             (SELECT COUNT(*) FROM signature_campaigns) campaigns,
             (SELECT COALESCE(SUM(clicks),0) FROM signature_tracking_links) tracked_clicks,
             (SELECT COUNT(*) FROM background_jobs WHERE status='queued') queued_jobs,
             (SELECT COUNT(*) FROM background_jobs WHERE status='dead_lettered') dead_lettered_jobs`,
          )
          .get(),
        migrations = db
          .prepare(
            "SELECT COUNT(*) count,MAX(applied_at) latest_at FROM schema_migrations",
          )
          .get(),
        supportAccess = db
          .prepare(
            `SELECT g.id,g.organization_id,g.expires_at,o.name organization_name
             FROM support_access_grants g JOIN organizations o ON o.id=g.organization_id
             WHERE g.session_id=? AND g.status='active' AND g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .get(owner.sessionId),
        tenants = db
          .prepare(
            `SELECT o.id,o.name,o.status,
             (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id=o.id AND m.status='active') users,
             (SELECT COUNT(*) FROM signature_templates t WHERE t.organization_id=o.id) templates,
             (SELECT COUNT(*) FROM signature_campaigns c WHERE c.organization_id=o.id) campaigns,
             COALESCE((SELECT SUM(clicks) FROM signature_tracking_links l WHERE l.organization_id=o.id),0) tracked_clicks
             FROM organizations o ORDER BY o.name`,
          )
          .all();
      json(
        res,
        200,
        {
          organizations,
          usage,
          tenants,
          supportAccess: supportAccess
            ? {
                id: supportAccess.id,
                organizationId: supportAccess.organization_id,
                organizationName: supportAccess.organization_name,
                expiresAt: supportAccess.expires_at,
              }
            : null,
          fleet: {
            version: packageVersion,
            database: "sqlite",
            migrations: migrations.count,
            latestMigrationAt: migrations.latest_at,
            mediaStorage: mediaStorage.mode,
          },
        },
        requestId,
      );
      return true;
    }
    const flagsMatch = url.pathname.match(
      /^\/api\/platform\/organizations\/([^/]+)\/feature-flags(?:\/([^/]+))?$/,
    );
    if (flagsMatch && req.method === "GET") {
      const organizationId = decodeURIComponent(flagsMatch[1]);
      if (
        !db
          .prepare("SELECT 1 FROM organizations WHERE id=?")
          .get(organizationId)
      )
        throw Object.assign(new Error("Tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      json(res, 200, { flags: flagState(db, organizationId) }, requestId);
      return true;
    }
    if (flagsMatch && req.method === "PUT") {
      const organizationId = decodeURIComponent(flagsMatch[1]),
        key = decodeURIComponent(flagsMatch[2] || ""),
        body = await readJsonBody(req, { limit: 8192 }),
        reason = limited(body.reason, 500).trim();
      if (!FLAG_KEYS.includes(key))
        throw Object.assign(new Error("Unsupported feature flag."), {
          status: 400,
          code: "FEATURE_FLAG_INVALID",
        });
      if (reason.length < 3)
        throw Object.assign(new Error("A feature flag reason is required."), {
          status: 400,
          code: "REASON_REQUIRED",
        });
      if (
        !db
          .prepare("SELECT 1 FROM organizations WHERE id=?")
          .get(organizationId)
      )
        throw Object.assign(new Error("Tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      db.prepare(
        `INSERT INTO feature_flags(id,flag_key,organization_id,enabled,configuration_json,updated_by)
         VALUES (?,?,?,?,?,?) ON CONFLICT(organization_id,flag_key) WHERE organization_id IS NOT NULL
         DO UPDATE SET enabled=excluded.enabled,configuration_json=excluded.configuration_json,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(
        randomUUID(),
        key,
        organizationId,
        body.enabled === false ? 0 : 1,
        JSON.stringify(body.configuration || {}),
        owner.id,
      );
      recordAudit(
        owner,
        "tenant.feature_flag_changed",
        "feature_flag",
        key,
        organizationId,
        reason,
        { enabled: body.enabled !== false },
        requestId,
      );
      json(res, 200, { flags: flagState(db, organizationId) }, requestId);
      return true;
    }
    const supportMatch = url.pathname.match(
      /^\/api\/platform\/organizations\/([^/]+)\/support-access$/,
    );
    if (supportMatch && req.method === "POST") {
      const organizationId = decodeURIComponent(supportMatch[1]),
        body = await readJsonBody(req, { limit: 4096 }),
        reason = limited(body.reason, 500).trim(),
        minutes = Number(body.minutes || 30);
      if (reason.length < 3)
        throw Object.assign(new Error("A support-access reason is required."), {
          status: 400,
          code: "REASON_REQUIRED",
        });
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120)
        throw Object.assign(
          new Error("Support access must last from 5 to 120 minutes."),
          { status: 400, code: "SUPPORT_DURATION_INVALID" },
        );
      if (
        !db
          .prepare("SELECT 1 FROM organizations WHERE id=? AND status='active'")
          .get(organizationId)
      )
        throw Object.assign(new Error("Active tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      const id = randomUUID(),
        expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE support_access_grants SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id=? AND status='active'",
        ).run(owner.sessionId);
        db.prepare(
          "INSERT INTO support_access_grants(id,organization_id,owner_user_id,session_id,reason,expires_at) VALUES (?,?,?,?,?,?)",
        ).run(id, organizationId, owner.id, owner.sessionId, reason, expiresAt);
        db.prepare(
          "UPDATE signature_sessions SET organization_id=? WHERE id=?",
        ).run(organizationId, owner.sessionId);
        recordAudit(
          owner,
          "support.access_started",
          "support_access_grant",
          id,
          organizationId,
          reason,
          { expiresAt },
          requestId,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      json(
        res,
        201,
        {
          grant: { id, organizationId, expiresAt },
          workspaceUrl: "/admin.html",
        },
        requestId,
      );
      return true;
    }
    if (
      url.pathname === "/api/platform/support-access" &&
      req.method === "DELETE"
    ) {
      const body = await readJsonBody(req, { limit: 4096 }),
        reason = limited(body.reason, 500).trim();
      if (reason.length < 3)
        throw Object.assign(new Error("A revocation reason is required."), {
          status: 400,
          code: "REASON_REQUIRED",
        });
      const grant = db
        .prepare(
          "SELECT * FROM support_access_grants WHERE session_id=? AND status='active'",
        )
        .get(owner.sessionId);
      if (!grant)
        throw Object.assign(new Error("Active support access not found."), {
          status: 404,
          code: "SUPPORT_ACCESS_NOT_FOUND",
        });
      db.prepare(
        "UPDATE support_access_grants SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      ).run(grant.id);
      db.prepare(
        "UPDATE signature_sessions SET organization_id=NULL WHERE id=?",
      ).run(owner.sessionId);
      recordAudit(
        owner,
        "support.access_revoked",
        "support_access_grant",
        grant.id,
        grant.organization_id,
        reason,
        {},
        requestId,
      );
      json(res, 200, { revoked: true }, requestId);
      return true;
    }
    return false;
  }
  return {
    featureEnabled: (organizationId, key) =>
      featureEnabled(db, organizationId, key),
    routes,
  };
}

module.exports = {
  FLAG_KEYS,
  createPlatformControlRoutes,
  featureEnabled,
  flagState,
};
