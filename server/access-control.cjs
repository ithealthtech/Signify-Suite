"use strict";

function forbidden(message, code) {
  return Object.assign(new Error(message), { status: 403, code });
}

function createAccessControl(db) {
  function isApplicationOwner(userId) {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM application_owners WHERE user_id=? AND status='active'",
        )
        .get(userId),
    );
  }

  function requireApplicationOwner(user) {
    if (!isApplicationOwner(user.id))
      throw forbidden(
        "Application Owner access required.",
        "APPLICATION_OWNER_REQUIRED",
      );
  }

  function requireAdmin(user) {
    if (user.role !== "admin")
      throw forbidden("Administrator access required.", "ADMIN_REQUIRED");
  }

  function requireEditor(user) {
    if (!["admin", "editor"].includes(user.role))
      throw forbidden("Editor access required.", "EDITOR_REQUIRED");
  }

  return Object.freeze({
    isApplicationOwner,
    requireAdmin,
    requireApplicationOwner,
    requireEditor,
  });
}

module.exports = { createAccessControl };
