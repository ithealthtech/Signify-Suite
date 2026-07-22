"use strict";

const fs = require("node:fs");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { hashPassword } = require("./auth-security.cjs");
const { limited, safeJson, validEmail } = require("./validation.cjs");

function equalToken(actual, expected) {
  const left = createHash("sha256")
      .update(String(actual || ""))
      .digest(),
    right = createHash("sha256")
      .update(String(expected || ""))
      .digest();
  return timingSafeEqual(left, right) && Boolean(expected);
}

function createInstaller({ config, db, json, readJsonBody }) {
  function required() {
    const owner = db.prepare("SELECT 1 FROM application_owners LIMIT 1").get(),
      completion = db
        .prepare(
          "SELECT 1 FROM application_settings WHERE setting_key='installation_completed' LIMIT 1",
        )
        .get();
    return !owner && !completion;
  }

  function status() {
    const installationRequired = required(),
      checks = [
        {
          id: "node",
          label: "Node.js runtime",
          ok: Number(process.versions.node.split(".")[0]) >= 22,
          detail: process.versions.node,
        },
        {
          id: "database",
          label: "Application database",
          ok: Boolean(db.prepare("SELECT 1 ready").get().ready),
          detail: "Migrations applied",
        },
        {
          id: "storage",
          label: "Persistent storage",
          ok:
            config.databasePath === ":memory:" ||
            fs.existsSync(config.databasePath),
          detail:
            config.databasePath === ":memory:"
              ? "In-memory test storage"
              : "Database path writable",
        },
        {
          id: "https",
          label: "Public HTTPS URL",
          ok:
            !config.production ||
            /^https:\/\//i.test(config.signature.publicUrl),
          detail: config.signature.publicUrl || "Not configured",
        },
        {
          id: "vault",
          label: "Credential vault",
          ok: Boolean(config.signature.credentialEncryptionKey),
          detail: config.signature.credentialEncryptionKey
            ? "Encryption key configured"
            : "Encryption key required",
        },
        {
          id: "token",
          label: "Setup authorization",
          ok: !installationRequired || Boolean(config.setup.token),
          detail: installationRequired
            ? config.setup.token
              ? "One-time token configured"
              : "SIGNIFY_SETUP_TOKEN is required"
            : "Installation locked",
        },
      ];
    return {
      required: installationRequired,
      available: !installationRequired || checks.every((check) => check.ok),
      companyName: config.signature.companyName,
      publicUrl: config.signature.publicUrl,
      checks,
    };
  }

  async function handle(req, res, url, requestId) {
    if (url.pathname === "/api/setup/status" && req.method === "GET") {
      json(res, 200, status(), requestId);
      return true;
    }
    if (url.pathname !== "/api/setup/install") return false;
    if (req.method !== "POST") {
      json(
        res,
        405,
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
        },
        requestId,
        { Allow: "POST" },
      );
      return true;
    }
    if (!required()) {
      json(
        res,
        409,
        {
          error: {
            code: "SETUP_LOCKED",
            message: "This installation has already been completed.",
          },
        },
        requestId,
      );
      return true;
    }
    const readiness = status();
    if (!readiness.available) {
      json(
        res,
        503,
        {
          error: {
            code: "SETUP_UNAVAILABLE",
            message: "Complete the required hosting configuration first.",
          },
          checks: readiness.checks,
        },
        requestId,
      );
      return true;
    }
    const body = await readJsonBody(req, { limit: 16384 });
    if (!equalToken(body.setupToken, config.setup.token)) {
      json(
        res,
        401,
        {
          error: {
            code: "SETUP_TOKEN_INVALID",
            message: "The setup token is invalid.",
          },
        },
        requestId,
      );
      return true;
    }
    const name = limited(body.name, 120),
      email = limited(body.email, 180).toLowerCase(),
      companyName = limited(body.companyName, 120),
      publicUrl = String(body.publicUrl || "")
        .trim()
        .replace(/\/+$/, ""),
      password = String(body.password || "");
    if (!name || !companyName || !validEmail(email))
      throw Object.assign(
        new Error("Enter the owner name, company, and email."),
        {
          status: 400,
          code: "SETUP_FIELDS_INVALID",
        },
      );
    if (password.length < 12 || password !== String(body.confirmPassword || ""))
      throw Object.assign(
        new Error("Use a matching password of at least 12 characters."),
        { status: 400, code: "SETUP_PASSWORD_INVALID" },
      );
    let parsedUrl;
    try {
      parsedUrl = new URL(publicUrl);
    } catch {
      parsedUrl = null;
    }
    if (!parsedUrl || (config.production && parsedUrl.protocol !== "https:"))
      throw Object.assign(
        new Error("Enter the public HTTPS application URL."),
        {
          status: 400,
          code: "SETUP_URL_INVALID",
        },
      );

    const userId = randomUUID(),
      organization = db
        .prepare("SELECT * FROM organizations ORDER BY created_at LIMIT 1")
        .get(),
      settings = safeJson(organization?.settings_json);
    if (!organization)
      throw Object.assign(new Error("The initial workspace is unavailable."), {
        status: 500,
        code: "SETUP_WORKSPACE_MISSING",
      });
    settings.publicUrl = publicUrl;
    settings.assetBaseUrl = publicUrl;
    settings.mediaBaseUrl = publicUrl;
    settings.brand = {
      locked: false,
      accent: "#2563eb",
      font: "system",
      logoUrl: "",
      ...(settings.brand || {}),
      companyName,
    };
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!required())
        throw Object.assign(
          new Error("Installation was completed concurrently."),
          {
            status: 409,
            code: "SETUP_LOCKED",
          },
        );
      db.prepare(
        `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at)
         VALUES (?,?,?,?,'admin','active','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).run(userId, email, hashPassword(password), name);
      db.prepare(
        "INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,'admin','active','{}')",
      ).run(organization.id, userId);
      db.prepare(
        "INSERT INTO application_owners(user_id,status,granted_by) VALUES (?,'active',?)",
      ).run(userId, userId);
      db.prepare(
        "UPDATE organizations SET name=?,settings_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      ).run(companyName, JSON.stringify(settings), organization.id);
      const writeSetting = db.prepare(
        `INSERT INTO application_settings(setting_key,setting_value,updated_by) VALUES (?,?,?)
         ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      );
      writeSetting.run("company_name", companyName, userId);
      writeSetting.run("public_url", publicUrl, userId);
      writeSetting.run(
        "installation_completed",
        new Date().toISOString(),
        userId,
      );
      db.prepare(
        "INSERT INTO application_audit_logs(id,actor_user_id,organization_id,action,target_type,target_id,reason,metadata_json,request_id) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(
        randomUUID(),
        userId,
        organization.id,
        "application.installed",
        "application",
        "signify-creator",
        "First-run web installation",
        JSON.stringify({ publicUrl }),
        requestId,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (/signature_users\.email/i.test(error.message))
        throw Object.assign(
          new Error("An account with that email already exists."),
          {
            status: 409,
            code: "EMAIL_EXISTS",
          },
        );
      throw error;
    }
    json(
      res,
      201,
      {
        installed: true,
        ownerEmail: email,
        next: "/signature.html?installed=true",
      },
      requestId,
    );
    return true;
  }

  return { handle, required, status };
}

module.exports = { createInstaller, equalToken };
