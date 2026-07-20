"use strict";

const { randomUUID } = require("node:crypto");
const { limited, safeJson } = require("../validation.cjs");

const EXPORT_TABLES = Object.freeze([
  [
    "templates",
    "SELECT id,name,template_json,created_by,created_at,updated_at FROM signature_templates WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "campaigns",
    "SELECT id,title,message,link_url,image_url,start_date,end_date,status,overlay_json,created_by,created_at,updated_at FROM signature_campaigns WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "trackingLinks",
    "SELECT id,user_id,kind,destination_url,clicks,last_clicked_at,created_at FROM signature_tracking_links WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "departmentDefaults",
    "SELECT department,template_id,accent_color,updated_by,updated_at FROM department_signature_defaults WHERE organization_id=? ORDER BY department",
  ],
  [
    "directorySyncRuns",
    "SELECT id,provider,status,users_seen,users_added,error_message,started_by,started_at,completed_at FROM directory_sync_runs WHERE organization_id=? ORDER BY started_at",
  ],
  [
    "invitations",
    "SELECT id,email,role,invited_by,expires_at,accepted_at,created_at FROM organization_invitations WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "auditLogs",
    "SELECT id,actor_user_id,action,target_type,target_id,metadata_json,created_at FROM audit_logs WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "applicationAuditLogs",
    "SELECT id,actor_user_id,action,target_type,target_id,reason,metadata_json,request_id,created_at FROM application_audit_logs WHERE organization_id=? ORDER BY created_at",
  ],
  [
    "jobs",
    "SELECT id,type,status,attempts,max_attempts,available_at,locked_at,completed_at,dead_lettered_at,last_error,result_json,created_at,updated_at FROM background_jobs WHERE organization_id=? ORDER BY created_at",
  ],
]);

function parseExportRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      key.endsWith("_json") ? safeJson(value) : value,
    ]),
  );
}

function tenantExport(db, organizationId) {
  const organization = db
    .prepare(
      "SELECT id,name,slug,status,settings_json,created_at,updated_at FROM organizations WHERE id=?",
    )
    .get(organizationId);
  if (!organization) return null;
  const subscription = db
      .prepare(
        "SELECT plan,status,seats,trial_ends_at,current_period_end,billing_synced_at,billing_error,updated_at FROM organization_subscriptions WHERE organization_id=?",
      )
      .get(organizationId),
    microsoft = db
      .prepare(
        "SELECT tenant_id,tenant_name,status,sender_email,consented_at,last_verified_at,last_sync_at,last_error,created_at,updated_at FROM organization_microsoft_connections WHERE organization_id=?",
      )
      .get(organizationId),
    members = db
      .prepare(
        `SELECT u.id,u.email,u.display_name,u.status,u.email_verified_at,u.created_at,u.updated_at,u.last_login_at,
        m.role,m.status membership_status,m.signature_json,m.created_at membership_created_at,m.updated_at membership_updated_at
        FROM organization_memberships m JOIN signature_users u ON u.id=m.user_id
        WHERE m.organization_id=? ORDER BY u.email`,
      )
      .all(organizationId)
      .map(parseExportRow),
    data = Object.fromEntries(
      EXPORT_TABLES.map(([name, sql]) => [
        name,
        db.prepare(sql).all(organizationId).map(parseExportRow),
      ]),
    );
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    organization: parseExportRow(organization),
    subscription: subscription || null,
    microsoft: microsoft || null,
    members,
    ...data,
  };
}

function deletionDto(row) {
  return row
    ? {
        id: row.id,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        organizationSlug: row.organization_slug,
        status: row.status,
        reason: row.reason,
        executeAfter: row.execute_after,
        canceledAt: row.canceled_at,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function createTenantLifecycle({
  db,
  json,
  readJsonBody,
  recordAudit,
  enqueueJob,
  mediaStorage,
  deletionGraceDays = 7,
}) {
  async function purgeTenant(payload) {
    const request = db
      .prepare(
        "SELECT * FROM tenant_deletion_requests WHERE id=? AND organization_id=? AND status IN ('pending','purging')",
      )
      .get(payload.requestId, payload.organizationId);
    if (!request) return { skipped: true, reason: "request_not_pending" };
    if (Date.parse(request.execute_after) > Date.now())
      throw new Error(
        "Tenant deletion was claimed before its grace period ended.",
      );
    if (request.status === "pending") {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tenant_deletion_requests SET status='purging',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='pending'",
        ).run(request.id);
        db.prepare("DELETE FROM organizations WHERE id=?").run(
          request.organization_id,
        );
        db.prepare(
          `DELETE FROM signature_users
          WHERE NOT EXISTS (SELECT 1 FROM organization_memberships m WHERE m.user_id=signature_users.id)
          AND NOT EXISTS (SELECT 1 FROM application_owners a WHERE a.user_id=signature_users.id)`,
        ).run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    const media = await mediaStorage.deleteTenant(request.organization_id);
    db.prepare(
      "UPDATE tenant_deletion_requests SET status='completed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='purging'",
    ).run(request.id);
    return { organizationId: request.organization_id, media };
  }

  async function routes({ req, res, url, requestId, owner }) {
    const match = url.pathname.match(
      /^\/api\/platform\/organizations\/([^/]+)\/(export|deletion|lifecycle)$/,
    );
    if (!match) return false;
    const organizationId = decodeURIComponent(match[1]),
      action = match[2];
    if (action === "lifecycle" && req.method === "GET") {
      const organization = db
        .prepare("SELECT id FROM organizations WHERE id=?")
        .get(organizationId);
      const deletion = db
        .prepare(
          "SELECT * FROM tenant_deletion_requests WHERE organization_id=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(organizationId);
      if (!organization && !deletion)
        throw Object.assign(new Error("Tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      json(res, 200, { deletion: deletionDto(deletion) }, requestId);
      return true;
    }
    if (action === "export" && req.method === "POST") {
      const body = await readJsonBody(req, { limit: 4096 }),
        reason = limited(body.reason, 500).trim(),
        exported = tenantExport(db, organizationId);
      if (reason.length < 3)
        throw Object.assign(new Error("An export reason is required."), {
          status: 400,
          code: "REASON_REQUIRED",
        });
      if (!exported)
        throw Object.assign(new Error("Tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      recordAudit(
        owner,
        "tenant.exported",
        "organization",
        organizationId,
        organizationId,
        reason,
        {
          members: exported.members.length,
          campaigns: exported.campaigns.length,
        },
        requestId,
      );
      json(res, 200, { export: exported }, requestId);
      return true;
    }
    if (action === "deletion" && req.method === "POST") {
      const body = await readJsonBody(req, { limit: 4096 }),
        reason = limited(body.reason, 500).trim(),
        organization = db
          .prepare("SELECT * FROM organizations WHERE id=?")
          .get(organizationId);
      if (!organization)
        throw Object.assign(new Error("Tenant not found."), {
          status: 404,
          code: "TENANT_NOT_FOUND",
        });
      if (
        reason.length < 3 ||
        body.confirmation !== `DELETE ${organization.slug}`
      )
        throw Object.assign(
          new Error(`Type DELETE ${organization.slug} to schedule deletion.`),
          { status: 400, code: "TENANT_DELETION_CONFIRMATION_REQUIRED" },
        );
      const existing = db
        .prepare(
          "SELECT * FROM tenant_deletion_requests WHERE organization_id=? AND status IN ('pending','purging')",
        )
        .get(organizationId);
      if (existing)
        throw Object.assign(
          new Error("Tenant deletion is already scheduled."),
          {
            status: 409,
            code: "TENANT_DELETION_ALREADY_SCHEDULED",
          },
        );
      const id = randomUUID(),
        executeAfter = new Date(
          Date.now() + deletionGraceDays * 86400000,
        ).toISOString();
      let job;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE organizations SET status='suspended',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        ).run(organizationId);
        db.prepare(
          "DELETE FROM signature_sessions WHERE organization_id=? AND user_id NOT IN (SELECT user_id FROM application_owners WHERE status='active')",
        ).run(organizationId);
        db.prepare(
          `INSERT INTO tenant_deletion_requests(id,organization_id,organization_name,organization_slug,reason,requested_by,execute_after)
          VALUES (?,?,?,?,?,?,?)`,
        ).run(
          id,
          organizationId,
          organization.name,
          organization.slug,
          reason,
          owner.id,
          executeAfter,
        );
        job = enqueueJob(
          "tenant.delete",
          { requestId: id, organizationId },
          {
            dedupeKey: `tenant.delete:${organizationId}`,
            availableAt: executeAfter,
            maxAttempts: 10,
          },
        );
        recordAudit(
          owner,
          "tenant.deletion_scheduled",
          "tenant_deletion_request",
          id,
          organizationId,
          reason,
          { executeAfter },
          requestId,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      json(
        res,
        202,
        {
          deletion: deletionDto(
            db
              .prepare("SELECT * FROM tenant_deletion_requests WHERE id=?")
              .get(id),
          ),
          job: { id: job.id, availableAt: job.available_at },
        },
        requestId,
      );
      return true;
    }
    if (action === "deletion" && req.method === "DELETE") {
      const body = await readJsonBody(req, { limit: 4096 }),
        reason = limited(body.reason, 500).trim();
      if (reason.length < 3)
        throw Object.assign(new Error("A cancellation reason is required."), {
          status: 400,
          code: "REASON_REQUIRED",
        });
      let deletion;
      db.exec("BEGIN IMMEDIATE");
      try {
        deletion = db
          .prepare(
            `UPDATE tenant_deletion_requests SET status='canceled',canceled_by=?,canceled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE organization_id=? AND status='pending' RETURNING *`,
          )
          .get(owner.id, organizationId);
        if (!deletion)
          throw Object.assign(new Error("Pending tenant deletion not found."), {
            status: 404,
            code: "TENANT_DELETION_NOT_FOUND",
          });
        db.prepare(
          "UPDATE background_jobs SET status='completed',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='Canceled by Application Owner.',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dedupe_key=? AND status='queued'",
        ).run(`tenant.delete:${organizationId}`);
        recordAudit(
          owner,
          "tenant.deletion_canceled",
          "tenant_deletion_request",
          deletion.id,
          organizationId,
          reason,
          {},
          requestId,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      json(res, 200, { deletion: deletionDto(deletion) }, requestId);
      return true;
    }
    return false;
  }

  return { jobHandlers: { "tenant.delete": purgeTenant }, routes };
}

module.exports = { createTenantLifecycle, deletionDto, tenantExport };
