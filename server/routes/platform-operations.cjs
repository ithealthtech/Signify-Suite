"use strict";

const fs = require("node:fs");
const { limited } = require("../validation.cjs");

function operationReason(body) {
  const reason = limited(body.reason, 500).trim();
  if (reason.length < 3)
    throw Object.assign(
      new Error("A reason of at least 3 characters is required."),
      { status: 400, code: "OPERATION_REASON_REQUIRED" },
    );
  return reason;
}

function createPlatformOperationsRoutes({
  json,
  operations,
  readJsonBody,
  recordAudit,
}) {
  return async function handlePlatformOperations({
    req,
    res,
    url,
    requestId,
    owner,
  }) {
    if (!url.pathname.startsWith("/api/platform/operations")) return false;

    if (url.pathname === "/api/platform/operations" && req.method === "GET") {
      json(res, 200, { backups: operations.listBackups() }, requestId);
      return true;
    }
    if (
      url.pathname === "/api/platform/operations/backups" &&
      req.method === "POST"
    ) {
      const reason = operationReason(await readJsonBody(req)),
        backup = operations.createBackup();
      recordAudit(
        owner,
        "application.backup_created",
        "backup",
        backup.name,
        null,
        reason,
        {},
        requestId,
      );
      json(res, 201, { backup }, requestId);
      return true;
    }
    const backupDownload = url.pathname.match(
      /^\/api\/platform\/operations\/backups\/([^/]+)\/download$/,
    );
    if (backupDownload && req.method === "GET") {
      const name = decodeURIComponent(backupDownload[1]),
        file = operations.managedFile(name);
      if (!fs.existsSync(file))
        throw Object.assign(new Error("Backup not found."), {
          status: 404,
          code: "BACKUP_NOT_FOUND",
        });
      const stat = fs.statSync(file);
      res.writeHead(200, {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Length": stat.size,
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    const backupRestore = url.pathname.match(
      /^\/api\/platform\/operations\/backups\/([^/]+)\/restore$/,
    );
    if (backupRestore && req.method === "POST") {
      const body = await readJsonBody(req),
        reason = operationReason(body),
        name = decodeURIComponent(backupRestore[1]);
      if (body.confirmation !== "RESTORE")
        throw Object.assign(
          new Error("Type RESTORE to confirm this operation."),
          { status: 400, code: "RESTORE_CONFIRMATION_REQUIRED" },
        );
      const restore = operations.stageRestore(name);
      recordAudit(
        owner,
        "application.restore_staged",
        "backup",
        name,
        null,
        reason,
        {},
        requestId,
      );
      json(res, 202, { restore }, requestId);
      return true;
    }
    if (
      url.pathname === "/api/platform/operations/restore" &&
      req.method === "DELETE"
    ) {
      const reason = operationReason(await readJsonBody(req));
      operations.cancelRestore();
      recordAudit(
        owner,
        "application.restore_canceled",
        "backup",
        "pending",
        null,
        reason,
        {},
        requestId,
      );
      json(res, 200, { canceled: true }, requestId);
      return true;
    }
    const backupDelete = url.pathname.match(
      /^\/api\/platform\/operations\/backups\/([^/]+)$/,
    );
    if (backupDelete && req.method === "DELETE") {
      const reason = operationReason(await readJsonBody(req)),
        name = decodeURIComponent(backupDelete[1]);
      operations.deleteBackup(name);
      recordAudit(
        owner,
        "application.backup_deleted",
        "backup",
        name,
        null,
        reason,
        {},
        requestId,
      );
      json(res, 200, { deleted: true }, requestId);
      return true;
    }
    if (
      url.pathname === "/api/platform/operations/updates" &&
      req.method === "GET"
    ) {
      json(res, 200, { update: await operations.checkForUpdates() }, requestId);
      return true;
    }
    return false;
  };
}

module.exports = { createPlatformOperationsRoutes, operationReason };
