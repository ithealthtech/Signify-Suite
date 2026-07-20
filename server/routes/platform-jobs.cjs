"use strict";

const { limited } = require("../validation.cjs");

function reason(body) {
  const value = limited(body.reason, 500).trim();
  if (value.length < 3)
    throw Object.assign(
      new Error("A reason of at least 3 characters is required."),
      { status: 400, code: "OPERATION_REASON_REQUIRED" },
    );
  return value;
}

function jobDto(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name || "Application",
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createPlatformJobRoutes({ db, json, readJsonBody, recordAudit }) {
  return async function handlePlatformJobs({
    req,
    res,
    url,
    requestId,
    owner,
  }) {
    if (!url.pathname.startsWith("/api/platform/jobs")) return false;
    if (url.pathname === "/api/platform/jobs" && req.method === "GET") {
      const allowed = new Set(["all", "queued", "running", "failed"]),
        status = allowed.has(url.searchParams.get("status"))
          ? url.searchParams.get("status")
          : "all",
        limit = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("limit")) || 50),
        ),
        rows = db
          .prepare(
            `SELECT j.id,j.organization_id,o.name organization_name,j.type,j.status,
              j.attempts,j.max_attempts,j.available_at,j.locked_at,j.completed_at,
              j.last_error,j.created_at,j.updated_at
             FROM background_jobs j
             LEFT JOIN organizations o ON o.id=j.organization_id
             WHERE (?='all' OR j.status=?)
             ORDER BY CASE j.status WHEN 'failed' THEN 0 WHEN 'running' THEN 1
               WHEN 'queued' THEN 2 ELSE 3 END,j.updated_at DESC
             LIMIT ?`,
          )
          .all(status, status, limit);
      json(res, 200, { jobs: rows.map(jobDto), status }, requestId);
      return true;
    }
    const retry = url.pathname.match(/^\/api\/platform\/jobs\/([^/]+)\/retry$/);
    if (retry && req.method === "POST") {
      const operationReason = reason(await readJsonBody(req)),
        id = decodeURIComponent(retry[1]),
        job = db
          .prepare(
            `UPDATE background_jobs SET status='queued',attempts=0,locked_at=NULL,
              completed_at=NULL,last_error='',available_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id=? AND status='failed' RETURNING id,type,organization_id`,
          )
          .get(id);
      if (!job)
        throw Object.assign(new Error("Failed job not found."), {
          status: 404,
          code: "FAILED_JOB_NOT_FOUND",
        });
      recordAudit(
        owner,
        "application.job_retried",
        "background_job",
        job.id,
        job.organization_id,
        operationReason,
        { type: job.type },
        requestId,
      );
      json(res, 202, { job: { id: job.id, status: "queued" } }, requestId);
      return true;
    }
    return false;
  };
}

module.exports = { createPlatformJobRoutes, jobDto };
