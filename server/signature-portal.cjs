"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  createHash,
  createPublicKey,
  verify: verifySignature,
  randomUUID,
} = require("node:crypto");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const QRCode = require("qrcode");
const Stripe = require("stripe");
const sharp = require("sharp");
const { createCredentialVault } = require("./credential-vault.cjs");
const { createAccessControl } = require("./access-control.cjs");
const {
  cookie,
  csrfCookie,
  hashPassword,
  jwtPayload,
  oauthStateCookie,
  sessionCookie,
  tokenHash,
  verifyPassword,
} = require("./auth-security.cjs");
const { redirect, textResponse } = require("./http-responses.cjs");
const { writeTenantMedia } = require("./media-storage.cjs");
const {
  createPlatformOperationsRoutes,
} = require("./routes/platform-operations.cjs");
const { createPlatformJobRoutes } = require("./routes/platform-jobs.cjs");
const {
  BRAND_FONT_STACKS,
  campaignInput,
  canonicalBrandFont,
  canonicalRole,
  canonicalStatus,
  cleanUrl,
  limited,
  normalizedBrand,
  safeJson,
  safeLink,
  safeMedia,
  signatureInputError,
  slug,
  validDate,
  validEmail,
  validMediaUrl,
  validUrl,
} = require("./validation.cjs");
const {
  TEMPLATES,
  buildSignatureHtml,
  buildPlainTextSignature,
} = require("./templates.cjs");

const legacyTemplates = [
  [
    "Conference push",
    {
      templateId: "modernMinimal",
      fields: { campaignHeadline: "Join our conference" },
      colors: { accent: "#5367d8" },
    },
  ],
  [
    "Security review",
    {
      templateId: "gradientEdge",
      fields: { campaignHeadline: "Free security review" },
      colors: { accent: "#31bed1" },
    },
  ],
  [
    "Clean everyday",
    { templateId: "minimalLine", colors: { accent: "#2563eb" } },
  ],
];

function campaignDto(row) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    linkUrl: row.link_url,
    imageUrl: row.image_url,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    overlay: safeJson(row.overlay_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function installEmailBody(signatureHtml) {
  return `<p>Your email signature is ready.</p>${signatureHtml}<p>Copy the signature above and paste it into your Outlook or Gmail signature settings.</p>`;
}
function imageFormat(bytes) {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "jpeg";
  if (
    bytes.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
  )
    return "gif";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  return "";
}
async function normalizeUploadedImage(bytes, kind, format) {
  if (format === "gif") return { bytes, format };
  const normalizedKind = String(kind || "image").toLowerCase(),
    dimensions = normalizedKind.includes("campaign")
      ? { width: 840, height: 240 }
      : normalizedKind.includes("banner")
        ? { width: 840, height: 200 }
        : normalizedKind.includes("logo")
          ? { width: 400, height: 160 }
          : { width: 300, height: 300 },
    photo =
      !normalizedKind.includes("campaign") &&
      !normalizedKind.includes("banner") &&
      !normalizedKind.includes("logo"),
    pipeline = sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({
        ...dimensions,
        fit: photo ? "cover" : "inside",
        withoutEnlargement: !photo,
      });
  if (format === "png")
    return {
      bytes: await pipeline.png({ compressionLevel: 9 }).toBuffer(),
      format: "png",
    };
  if (format === "webp")
    return {
      bytes: await pipeline.webp({ quality: 88 }).toBuffer(),
      format: "webp",
    };
  return {
    bytes: await pipeline.jpeg({ quality: 88, mozjpeg: true }).toBuffer(),
    format: "jpeg",
  };
}
function profileFrom(row, raw) {
  const profile = raw.profile || {},
    fields = raw.fields || {};
  return {
    fullName:
      fields.name || profile.fullName || raw.fullName || row.display_name || "",
    jobTitle: fields.jobTitle || profile.jobTitle || raw.jobTitle || "",
    email: fields.email || profile.email || raw.email || row.email || "",
    phone: fields.phone || profile.phone || raw.phone || "",
    mobile: fields.mobile || profile.mobile || raw.mobile || "",
    photoUrl: raw.photoUrl || profile.photoUrl || "",
  };
}
function normalizeSignature(row, raw = safeJson(row.signature_json)) {
  const profile = profileFrom(row, raw),
    social = raw.fields?.social || {};
  const templateId = TEMPLATES[raw.templateId]
    ? raw.templateId
    : {
        compact: "compact",
        "clean-card": "minimalLine",
        "event-card": "modernMinimal",
      }[raw.template] || "executive";
  const accent = /^#[0-9a-f]{6}$/i.test(
    String(raw.colors?.accent || raw.accentColor || ""),
  )
    ? String(raw.colors?.accent || raw.accentColor)
    : "#2563eb";
  const workflowStatus = ["draft", "pending", "approved", "rejected"].includes(
    raw.workflowStatus,
  )
    ? raw.workflowStatus
    : "approved";
  return {
    templateId,
    fields: {
      name: limited(profile.fullName, 120),
      jobTitle: limited(profile.jobTitle, 120),
      company: limited(raw.fields?.company || raw.companyName, 120),
      department: limited(raw.fields?.department || raw.department, 120),
      phone: limited(profile.phone, 60),
      mobile: limited(profile.mobile, 60),
      email: limited(profile.email, 180).toLowerCase(),
      website: safeLink(raw.fields?.website || raw.website),
      address: limited(raw.fields?.address || raw.address, 300),
      social: {
        linkedin: safeLink(social.linkedin || raw.linkedinUrl),
        twitter: safeLink(social.twitter || raw.xUrl),
        instagram: safeLink(social.instagram || raw.instagramUrl),
        facebook: safeLink(social.facebook || raw.facebookUrl),
      },
    },
    colors: { accent },
    photoUrl: safeMedia(raw.photoUrl || profile.photoUrl),
    bannerUrl: safeMedia(
      raw.bannerUrl && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(raw.bannerUrl)
        ? raw.bannerUrl
        : raw.bannerImageUrl,
    ),
    vcardEnabled: Boolean(raw.vcardEnabled),
    ribbonText: limited(
      raw.ribbonText || "Seasonal greetings from our team",
      120,
    ),
    workflowStatus,
    reviewNote: limited(raw.reviewNote, 500),
    submittedAt: raw.submittedAt || null,
    approvedAt: raw.approvedAt || null,
    approvedBy: raw.approvedBy || null,
    updatedAt: raw.updatedAt || null,
  };
}
function mergeSignature(row, input = {}) {
  const current = normalizeSignature(row),
    patch =
      input && typeof input === "object" && !Array.isArray(input) ? input : {},
    fields =
      patch.fields &&
      typeof patch.fields === "object" &&
      !Array.isArray(patch.fields)
        ? patch.fields
        : {},
    social =
      fields.social &&
      typeof fields.social === "object" &&
      !Array.isArray(fields.social)
        ? fields.social
        : {},
    colors =
      patch.colors &&
      typeof patch.colors === "object" &&
      !Array.isArray(patch.colors)
        ? patch.colors
        : {};
  return normalizeSignature(row, {
    ...current,
    ...patch,
    fields: {
      ...current.fields,
      ...fields,
      social: { ...current.fields.social, ...social },
    },
    colors: { ...current.colors, ...colors },
  });
}
function userDto(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.membership_role || row.role,
    status: row.membership_status || row.status,
    organizationId: row.organization_id || null,
    organizationName: row.organization_name || "",
    signature: normalizeSignature(row),
    lastLoginAt: row.last_login_at,
    applicationOwner: Boolean(row.application_owner),
  };
}
function templateDto(row) {
  return {
    id: row.id,
    name: row.name,
    kind: "custom",
    organizationId: row.organization_id,
    patch: safeJson(row.template_json),
  };
}
function workspaceDto(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    settings: safeJson(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function subscriptionDto(row, includeProvider = false) {
  return row
    ? {
        plan: row.plan,
        status: row.status,
        seats: row.seats,
        trialEndsAt: row.trial_ends_at,
        currentPeriodEnd: row.current_period_end,
        ...(includeProvider
          ? {
              stripeCustomerId: row.stripe_customer_id || null,
              stripeSubscriptionId: row.stripe_subscription_id || null,
              stripePriceId: row.stripe_price_id || null,
            }
          : {}),
      }
    : null;
}
function auditDto(row) {
  return {
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    organizationId: row.organization_id || null,
    actorName: row.actor_name || "System",
    reason: row.reason || "",
    metadata: safeJson(row.metadata_json),
    createdAt: row.created_at,
  };
}
function microsoftConnectionDto(row) {
  return row
    ? {
        organizationId: row.organization_id,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        status: row.status,
        senderEmail: row.sender_email,
        consentedAt: row.consented_at,
        lastVerifiedAt: row.last_verified_at,
        lastSyncAt: row.last_sync_at,
        lastError: row.last_error,
      }
    : null;
}

function createSignaturePortal({
  db,
  production,
  signature = {},
  json,
  readJsonBody,
  readBody,
  publicRoot = path.join(__dirname, "..", "public"),
  mediaStorage,
  trustProxy = false,
  fetchImpl = fetch,
  stripeFactory = (key) =>
    new Stripe(key, { maxNetworkRetries: 2, timeout: 10000 }),
  operations,
  enqueueJob,
}) {
  seed(db, signature);
  const credentialVault = createCredentialVault(
      signature.credentialEncryptionKey,
    ),
    {
      isApplicationOwner,
      requireAdmin,
      requireApplicationOwner,
      requireEditor,
    } = createAccessControl(db);
  let microsoftJwksCache = { expiresAt: 0, keys: [] };
  const memberSelect = `SELECT u.id,u.email,u.password_hash,u.display_name,u.role,u.status,u.created_at,u.updated_at,u.last_login_at,u.email_verified_at,m.signature_json,m.role AS membership_role,m.status AS membership_status,o.id AS organization_id,o.name AS organization_name,o.slug AS organization_slug,o.status AS organization_status,o.settings_json AS organization_settings FROM signature_users u JOIN organization_memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id`;
  const builtinTemplates = Object.entries(TEMPLATES).map(([id, item]) => ({
    id,
    name: item.name,
    blurb: item.blurb,
    kind: "builtin",
  }));

  function integrationRow(provider) {
    return db
      .prepare("SELECT * FROM application_integrations WHERE provider=?")
      .get(provider);
  }
  function integrationCredentials(provider) {
    const row = integrationRow(provider);
    if (!row?.encrypted_credentials) return null;
    return credentialVault.decrypt(provider, row.encrypted_credentials);
  }
  function stripeSettings() {
    const row = integrationRow("stripe"),
      credentials = integrationCredentials("stripe"),
      configuration = safeJson(row?.configuration_json);
    return credentials
      ? {
          secretKey: credentials.secretKey || "",
          webhookSecret: credentials.webhookSecret || "",
          prices: configuration.prices || {},
          mode: row.mode || "",
          accountId: row.account_id || "",
          accountName: row.account_name || "",
          source: "vault",
        }
      : {
          secretKey: signature.stripeSecretKey || "",
          webhookSecret: signature.stripeWebhookSecret || "",
          prices: signature.stripePrices || {},
          mode: String(signature.stripeSecretKey || "").startsWith("sk_live_")
            ? "live"
            : signature.stripeSecretKey
              ? "test"
              : "",
          accountId: "",
          accountName: "",
          source: signature.stripeSecretKey ? "environment" : "none",
        };
  }
  function microsoftSettings() {
    const row = integrationRow("microsoft"),
      credentials = integrationCredentials("microsoft"),
      configuration = safeJson(row?.configuration_json);
    return credentials
      ? {
          clientId: credentials.clientId || "",
          clientSecret: credentials.clientSecret || "",
          homeTenantId: configuration.homeTenantId || "",
          source: "vault",
        }
      : {
          clientId: signature.microsoftClientId || "",
          clientSecret: signature.microsoftClientSecret || "",
          homeTenantId: signature.microsoftTenantId || "",
          source: signature.microsoftClientId ? "environment" : "none",
        };
  }
  function microsoftAvailable() {
    const settings = microsoftSettings();
    return Boolean(settings.clientId && settings.clientSecret);
  }
  function applicationSetting(key, fallback = "") {
    return (
      db
        .prepare(
          "SELECT setting_value FROM application_settings WHERE setting_key=?",
        )
        .get(key)?.setting_value ?? fallback
    );
  }
  function applicationPublicBase(req) {
    return cleanUrl(
      applicationSetting("public_url", signature.publicUrl || requestBase(req)),
    );
  }
  function stripeClient(settings = stripeSettings()) {
    return settings.secretKey ? stripeFactory(settings.secretKey) : null;
  }
  async function stripeRequest(operation, message) {
    try {
      return await operation();
    } catch (cause) {
      throw Object.assign(new Error(message), {
        status: 502,
        code: "STRIPE_API_FAILED",
        cause,
      });
    }
  }
  function integrationSummary(provider) {
    const row = integrationRow(provider);
    if (!row)
      return {
        provider,
        status: "disconnected",
        mode: "",
        accountId: "",
        accountName: "",
        lastVerifiedAt: null,
        lastError: "",
        source: provider === "stripe" ? stripeSettings().source : "environment",
      };
    return {
      provider,
      status: row.status,
      mode: row.mode,
      accountId: row.account_id,
      accountName: row.account_name,
      lastVerifiedAt: row.last_verified_at,
      lastError: row.last_error,
      source: "vault",
    };
  }

  function requestBase(req) {
    const forwardedProto = trustProxy
        ? String(req.headers["x-forwarded-proto"] || "")
            .split(",")[0]
            .trim()
        : "",
      proto = ["http", "https"].includes(forwardedProto)
        ? forwardedProto
        : req.socket.encrypted
          ? "https"
          : "http",
      requestedHost = String(req.headers.host || "").trim(),
      host = /^[a-z0-9.[\]:-]+$/i.test(requestedHost)
        ? requestedHost
        : "127.0.0.1:4173";
    return `${proto}://${host}`;
  }
  function workspaceRow(user) {
    return db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(user.organizationId);
  }
  function workspaceSettings(user) {
    return safeJson(workspaceRow(user)?.settings_json);
  }
  function effectiveBase(req, configured) {
    const current = cleanUrl(requestBase(req)),
      candidate = cleanUrl(configured);
    if (!candidate) return current;
    if (!production) {
      try {
        const configuredUrl = new URL(candidate),
          currentUrl = new URL(current),
          loopback = (hostname) =>
            ["127.0.0.1", "localhost", "::1"].includes(hostname);
        if (loopback(configuredUrl.hostname) && loopback(currentUrl.hostname))
          return current;
      } catch {
        return current;
      }
    }
    return candidate;
  }
  function publicBase(req, user) {
    const settings = user ? workspaceSettings(user) : {};
    return effectiveBase(
      req,
      settings.publicUrl || signature.publicUrl || requestBase(req),
    );
  }
  function assetBase(req, user) {
    const settings = workspaceSettings(user);
    return effectiveBase(
      req,
      settings.assetBaseUrl ||
        settings.publicUrl ||
        signature.assetBaseUrl ||
        publicBase(req, user),
    );
  }
  function memberById(organizationId, userId) {
    return db
      .prepare(`${memberSelect} WHERE m.organization_id=? AND u.id=?`)
      .get(organizationId, userId);
  }
  function memberByEmail(organizationId, email) {
    return db
      .prepare(
        `${memberSelect} WHERE m.organization_id=? AND lower(u.email)=lower(?)`,
      )
      .get(organizationId, email);
  }
  function userWorkspaces(userId) {
    return db
      .prepare(
        `SELECT o.id,o.name,o.slug,m.role FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.user_id=? AND m.status='active' AND o.status='active' ORDER BY o.name`,
      )
      .all(userId);
  }
  function recordAudit(
    user,
    action,
    targetType,
    targetId = null,
    metadata = {},
  ) {
    db.prepare(
      "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,target_type,target_id,metadata_json) VALUES (?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      user.organizationId,
      user.id,
      action,
      targetType,
      targetId,
      JSON.stringify(metadata),
    );
  }
  function recordApplicationAudit(
    user,
    action,
    targetType,
    targetId = null,
    organizationId = null,
    reason = "",
    metadata = {},
    requestId = null,
  ) {
    db.prepare(
      "INSERT INTO application_audit_logs(id,actor_user_id,organization_id,action,target_type,target_id,reason,metadata_json,request_id) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      user.id,
      organizationId,
      action,
      targetType,
      targetId,
      limited(reason, 500),
      JSON.stringify(metadata),
      requestId,
    );
  }
  function microsoftConnection(organizationId, connectedOnly = false) {
    return db
      .prepare(
        `SELECT * FROM organization_microsoft_connections WHERE organization_id=?${connectedOnly ? " AND status='connected'" : ""}`,
      )
      .get(organizationId);
  }
  function requireSession(req) {
    const token = cookie(req, "sig_session");
    if (!token) {
      const error = new Error("Not signed in.");
      error.status = 401;
      error.code = "AUTH_REQUIRED";
      throw error;
    }
    const row = db
      .prepare(
        `SELECT u.*,m.role AS membership_role,m.status AS membership_status,o.id AS organization_id,o.name AS organization_name,o.slug AS organization_slug,o.settings_json AS organization_settings,s.id AS session_id,s.csrf_token_hash FROM signature_sessions s JOIN signature_users u ON u.id=s.user_id JOIN organization_memberships m ON m.user_id=u.id AND m.organization_id=s.organization_id JOIN organizations o ON o.id=m.organization_id WHERE s.token_hash=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.status='active' AND m.status='active' AND o.status='active'`,
      )
      .get(tokenHash(token));
    if (!row) {
      const error = new Error("Session expired.");
      error.status = 401;
      error.code = "SESSION_EXPIRED";
      throw error;
    }
    db.prepare(
      `UPDATE signature_sessions SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(row.session_id);
    const user = userDto(row);
    user.applicationOwner = isApplicationOwner(user.id);
    Object.defineProperties(user, {
      sessionId: { value: row.session_id },
      csrfTokenHash: { value: row.csrf_token_hash || "" },
    });
    return user;
  }
  function requireApplicationSession(req) {
    const token = cookie(req, "sig_session");
    if (!token)
      throw Object.assign(new Error("Not signed in."), {
        status: 401,
        code: "AUTH_REQUIRED",
      });
    const row = db
      .prepare(
        `SELECT u.*,s.id AS session_id,s.organization_id,s.csrf_token_hash FROM signature_sessions s JOIN signature_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND u.status='active'`,
      )
      .get(tokenHash(token));
    if (!row)
      throw Object.assign(new Error("Application Owner session expired."), {
        status: 401,
        code: "SESSION_EXPIRED",
      });
    db.prepare(
      `UPDATE signature_sessions SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(row.session_id);
    const user = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      applicationOwner: isApplicationOwner(row.id),
      organizationId: row.organization_id,
    };
    Object.defineProperties(user, {
      sessionId: { value: row.session_id },
      csrfTokenHash: { value: row.csrf_token_hash || "" },
    });
    return user;
  }
  function createSession(req, row) {
    const user = userDto(row),
      settings = workspaceSettings(user),
      hours = Math.max(
        1,
        Math.min(
          168,
          Number(settings.sessionHours || signature.sessionHours || 12),
        ),
      ),
      token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url"),
      expires = new Date(Date.now() + hours * 3600000).toISOString();
    user.applicationOwner = isApplicationOwner(user.id);
    db.exec(`DELETE FROM signature_sessions WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');
      DELETE FROM password_reset_tokens WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR used_at IS NOT NULL;
      DELETE FROM email_verification_tokens WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR used_at IS NOT NULL;
      DELETE FROM oauth_states WHERE expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now');`);
    db.prepare(
      "INSERT INTO signature_sessions(id,user_id,token_hash,expires_at,organization_id,csrf_token_hash,created_ip,user_agent) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      user.id,
      tokenHash(token),
      expires,
      user.organizationId,
      tokenHash(csrf),
      String(req.socket.remoteAddress || "").slice(0, 80),
      String(req.headers["user-agent"] || "").slice(0, 500),
    );
    db.prepare(
      `UPDATE signature_users SET last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(user.id);
    return {
      user,
      header: {
        "Set-Cookie": [
          sessionCookie(token, hours * 3600, production),
          csrfCookie(csrf, hours * 3600, production),
        ],
      },
    };
  }
  function refreshCsrf(user) {
    const csrf = randomBytes(32).toString("base64url");
    db.prepare(
      "UPDATE signature_sessions SET csrf_token_hash=? WHERE id=?",
    ).run(tokenHash(csrf), user.sessionId);
    return {
      "Set-Cookie": csrfCookie(
        csrf,
        Math.max(3600, (signature.sessionHours || 12) * 3600),
        production,
      ),
    };
  }
  function enforceCsrf(req, user) {
    const header = String(req.headers["x-csrf-token"] || ""),
      cookieToken = cookie(req, "sig_csrf");
    if (
      !header ||
      header !== cookieToken ||
      !user.csrfTokenHash ||
      tokenHash(header) !== user.csrfTokenHash
    ) {
      const error = new Error(
        "Security token is missing or expired. Refresh the page and try again.",
      );
      error.status = 403;
      error.code = "CSRF_INVALID";
      throw error;
    }
  }
  function createOneTimeToken(table, userId, minutes) {
    const token = randomBytes(32).toString("base64url"),
      expires = new Date(Date.now() + minutes * 60000).toISOString();
    db.prepare(`DELETE FROM ${table} WHERE user_id=? AND used_at IS NULL`).run(
      userId,
    );
    db.prepare(
      `INSERT INTO ${table}(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)`,
    ).run(randomUUID(), userId, tokenHash(token), expires);
    return token;
  }
  function mailAvailable(organizationId) {
    if (!organizationId)
      return Boolean(
        microsoftAvailable() &&
        signature.microsoftTenantId &&
        signature.microsoftSenderEmail,
      );
    const connection = microsoftConnection(organizationId, true);
    return Boolean(microsoftAvailable() && connection?.sender_email);
  }
  function mailOrganizationForUser(userId) {
    return db
      .prepare(
        `SELECT c.organization_id FROM organization_microsoft_connections c JOIN organization_memberships m ON m.organization_id=c.organization_id JOIN organizations o ON o.id=c.organization_id WHERE m.user_id=? AND m.status='active' AND o.status='active' AND c.status='connected' AND c.sender_email<>'' ORDER BY m.created_at LIMIT 1`,
      )
      .get(userId)?.organization_id;
  }
  function billingAvailable() {
    const settings = stripeSettings();
    return Boolean(
      settings.secretKey &&
      settings.webhookSecret &&
      Object.values(settings.prices || {}).some(Boolean),
    );
  }
  function planForPrice(priceId) {
    return (
      Object.entries(stripeSettings().prices || {}).find(
        ([, configured]) => configured && configured === priceId,
      )?.[0] || "starter"
    );
  }
  function seatsForPlan(plan) {
    return { beta: 10, starter: 10, team: 50, business: 250 }[plan] || 10;
  }
  function subscriptionAccess(user) {
    const row = db
      .prepare(
        "SELECT * FROM organization_subscriptions WHERE organization_id=?",
      )
      .get(user.organizationId);
    if (!row) return false;
    if (row.status === "active") return true;
    return (
      row.status === "trialing" &&
      (!row.trial_ends_at || Date.parse(row.trial_ends_at) > Date.now())
    );
  }
  function requireSubscription(user) {
    if (!subscriptionAccess(user)) {
      const error = new Error(
        "Your subscription is inactive. Update billing to continue editing.",
      );
      error.status = 402;
      error.code = "SUBSCRIPTION_REQUIRED";
      throw error;
    }
  }
  function stripeStatus(value) {
    if (value === "active") return "active";
    if (value === "trialing") return "trialing";
    if (value === "canceled") return "canceled";
    return "past_due";
  }
  function eventOrganization(object) {
    const metadataId = object.metadata?.organization_id;
    if (metadataId)
      return db
        .prepare("SELECT id FROM organizations WHERE id=?")
        .get(metadataId);
    const customer =
      typeof object.customer === "string"
        ? object.customer
        : object.customer?.id;
    const subscription =
      typeof object.subscription === "string"
        ? object.subscription
        : object.subscription?.id;
    return db
      .prepare(
        "SELECT organization_id AS id FROM organization_subscriptions WHERE stripe_customer_id=? OR stripe_subscription_id=?",
      )
      .get(customer || "", subscription || object.id || "");
  }
  function applyStripeEvent(event) {
    const object = event.data.object,
      organization = eventOrganization(object);
    if (event.type === "checkout.session.completed") {
      const organizationId =
        object.metadata?.organization_id || object.client_reference_id;
      if (!organizationId) return;
      const plan = object.metadata?.plan || "starter";
      db.prepare(
        `UPDATE organization_subscriptions SET plan=?,status='active',seats=?,stripe_customer_id=?,stripe_subscription_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(
        plan,
        seatsForPlan(plan),
        typeof object.customer === "string"
          ? object.customer
          : object.customer?.id,
        typeof object.subscription === "string"
          ? object.subscription
          : object.subscription?.id,
        organizationId,
      );
      return;
    }
    if (!organization) return;
    if (event.type.startsWith("customer.subscription.")) {
      const priceId = object.items?.data?.[0]?.price?.id || "",
        plan = planForPrice(priceId),
        periodEnd =
          object.current_period_end ||
          object.items?.data?.[0]?.current_period_end;
      db.prepare(
        `UPDATE organization_subscriptions SET plan=?,status=?,seats=?,stripe_customer_id=?,stripe_subscription_id=?,stripe_price_id=?,current_period_end=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(
        plan,
        stripeStatus(object.status),
        seatsForPlan(plan),
        typeof object.customer === "string"
          ? object.customer
          : object.customer?.id,
        object.id,
        priceId,
        periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        organization.id,
      );
      return;
    }
    if (event.type === "invoice.payment_failed")
      db.prepare(
        `UPDATE organization_subscriptions SET status='past_due',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(organization.id);
    if (event.type === "invoice.paid")
      db.prepare(
        `UPDATE organization_subscriptions SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND status<>'canceled'`,
      ).run(organization.id);
  }
  function activeCampaign(user) {
    const today = new Date().toISOString().slice(0, 10),
      row = db
        .prepare(
          `SELECT * FROM signature_campaigns WHERE organization_id=? AND status='active' AND start_date<=? AND end_date>=? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(user.organizationId, today, today);
    return row
      ? {
          id: row.id,
          title: row.title,
          message: row.message,
          linkUrl: row.link_url,
          imageUrl: row.image_url,
          startDate: row.start_date,
          endDate: row.end_date,
        }
      : null;
  }
  function trackedUrl(req, user, kind, destination) {
    if (!destination || !validUrl(destination)) return destination || "";
    let row = db
      .prepare(
        "SELECT id FROM signature_tracking_links WHERE organization_id=? AND user_id=? AND kind=? AND destination_url=?",
      )
      .get(user.organizationId, user.id, kind, destination);
    if (!row) {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO signature_tracking_links(id,organization_id,user_id,kind,destination_url) VALUES (?,?,?,?,?)",
      ).run(id, user.organizationId, user.id, kind, destination);
      row = { id };
    }
    return `${publicBase(req, user)}/r/${row.id}`;
  }
  async function renderSignature(req, user, input) {
    const sig = mergeSignature(
        {
          display_name: user.displayName,
          email: user.email,
          signature_json: JSON.stringify(user.signature || {}),
        },
        input,
      ),
      settings = workspaceSettings(user),
      brand = settings.brand || {},
      colors = { ...(sig.colors || {}) };
    if (brand.locked && brand.accent) colors.accent = brand.accent;
    const hrefs = {},
      social = sig.fields.social || {};
    if (sig.fields.website)
      hrefs.website = trackedUrl(req, user, "website", sig.fields.website);
    for (const kind of ["linkedin", "twitter", "instagram", "facebook"])
      if (social[kind]) hrefs[kind] = trackedUrl(req, user, kind, social[kind]);
    const campaign = activeCampaign(user),
      campaignLinkUrl = campaign
        ? trackedUrl(
            req,
            user,
            `campaign:${campaign.id}`,
            campaign.linkUrl || publicBase(req, user),
          )
        : "";
    let qrDataUri = "",
      vcardLinkUrl = "";
    if (sig.vcardEnabled) {
      vcardLinkUrl = trackedUrl(
        req,
        user,
        "vcard",
        `${publicBase(req, user)}/vcard/${user.organizationId}/${user.id}.vcf`,
      );
      qrDataUri = await QRCode.toDataURL(vcardLinkUrl, {
        margin: 1,
        width: 128,
      });
    }
    const html = buildSignatureHtml(sig.templateId, {
      f: sig.fields,
      colors,
      photoUrl: absoluteMedia(req, user, sig.photoUrl),
      bannerUrl: absoluteMedia(req, user, sig.bannerUrl),
      iconBase: `${assetBase(req, user)}/icons`,
      hrefs,
      campaign: campaign
        ? { ...campaign, imageUrl: absoluteMedia(req, user, campaign.imageUrl) }
        : null,
      campaignLinkUrl,
      qrDataUri,
      vcardLinkUrl,
      ribbonText: sig.ribbonText,
      companyLogoUrl: brand.locked
        ? absoluteMedia(req, user, brand.logoUrl)
        : "",
      companyName: brand.companyName || workspaceRow(user)?.name,
      fontFamily: brand.locked
        ? BRAND_FONT_STACKS[canonicalBrandFont(brand.font)]
        : "",
    });
    return {
      html,
      plainText: buildPlainTextSignature(sig.fields),
      signature: sig,
    };
  }
  function absoluteMedia(req, user, value) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
    const settings = workspaceSettings(user);
    return `${effectiveBase(req, settings.mediaBaseUrl || settings.publicUrl || signature.mediaBaseUrl || publicBase(req, user))}/${url.replace(/^\/+/, "")}`;
  }
  function saveSignatureRow(organizationId, userId, input) {
    const existing = memberById(organizationId, userId),
      normalized = {
        ...mergeSignature(existing, input),
        updatedAt: new Date().toISOString(),
      };
    db.prepare(
      `UPDATE organization_memberships SET signature_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND user_id=?`,
    ).run(JSON.stringify(normalized), organizationId, userId);
    db.prepare(
      `UPDATE signature_users SET display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    ).run(
      String(normalized.fields.name || existing.display_name).trim(),
      userId,
    );
    return normalized;
  }
  function rolloutTemplatePatch(organizationId, templateId) {
    if (TEMPLATES[templateId]) return { templateId };
    const row = db
      .prepare(
        "SELECT template_json FROM signature_templates WHERE id=? AND organization_id=?",
      )
      .get(templateId, organizationId);
    if (!row)
      throw Object.assign(
        new Error("Choose an available signature template."),
        {
          status: 400,
          code: "TEMPLATE_INVALID",
        },
      );
    const saved = safeJson(row.template_json);
    return {
      templateId: TEMPLATES[saved.templateId] ? saved.templateId : "executive",
      colors: saved.colors,
      photoUrl: saved.photoUrl,
      bannerUrl: saved.bannerUrl,
      vcardEnabled: saved.vcardEnabled,
      ribbonText: saved.ribbonText,
    };
  }

  async function fetchWithRetry(url, options = {}, attempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, {
          ...options,
          signal: AbortSignal.timeout(10000),
        });
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === attempts) return response;
        await response.body?.cancel();
        const retryAfter = Number(response.headers.get("retry-after")),
          delay = Number.isFinite(retryAfter)
            ? Math.min(retryAfter * 1000, 5000)
            : attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw Object.assign(
      new Error(
        `External service request failed: ${lastError?.message || "network error"}`,
      ),
      { status: 502, code: "UPSTREAM_UNAVAILABLE" },
    );
  }

  async function verifyMicrosoftIdToken(token, expectedNonce) {
    const microsoftConfiguration = microsoftSettings();
    const parts = String(token || "").split("."),
      header = safeJson(
        parts[0] ? Buffer.from(parts[0], "base64url").toString("utf8") : "{}",
      ),
      payload = jwtPayload(token);
    if (parts.length !== 3 || header.alg !== "RS256" || !header.kid)
      throw Object.assign(
        new Error("Microsoft returned an invalid ID token."),
        {
          status: 502,
          code: "MICROSOFT_ID_TOKEN_INVALID",
        },
      );
    if (microsoftJwksCache.expiresAt <= Date.now()) {
      const response = await fetchWithRetry(
          "https://login.microsoftonline.com/common/discovery/v2.0/keys",
        ),
        data = await response.json();
      if (!response.ok || !Array.isArray(data.keys))
        throw Object.assign(
          new Error("Microsoft signing keys could not be loaded."),
          { status: 502, code: "MICROSOFT_JWKS_FAILED" },
        );
      microsoftJwksCache = {
        expiresAt: Date.now() + 60 * 60 * 1000,
        keys: data.keys,
      };
    }
    const jwk = microsoftJwksCache.keys.find(
      (candidate) => candidate.kid === header.kid,
    );
    if (
      !jwk ||
      !verifySignature(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key: jwk, format: "jwk" }),
        Buffer.from(parts[2], "base64url"),
      )
    )
      throw Object.assign(
        new Error("Microsoft ID token signature verification failed."),
        { status: 502, code: "MICROSOFT_ID_TOKEN_INVALID" },
      );
    const tenantId = String(payload.tid || ""),
      audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud],
      expectedIssuer = `https://login.microsoftonline.com/${tenantId}/v2.0`,
      now = Math.floor(Date.now() / 1000);
    if (
      !audience.includes(microsoftConfiguration.clientId) ||
      payload.iss !== expectedIssuer ||
      payload.nonce !== expectedNonce ||
      !Number.isFinite(payload.exp) ||
      payload.exp <= now - 60 ||
      (Number.isFinite(payload.nbf) && payload.nbf > now + 60)
    )
      throw Object.assign(
        new Error("Microsoft ID token claims failed validation."),
        { status: 502, code: "MICROSOFT_ID_TOKEN_INVALID" },
      );
    return payload;
  }

  async function graphTokenForTenant(tenantId) {
    const microsoftConfiguration = microsoftSettings();
    if (!microsoftAvailable())
      throw Object.assign(new Error("Microsoft 365 is not configured."), {
        status: 400,
        code: "MICROSOFT_NOT_CONFIGURED",
      });
    const body = new URLSearchParams({
      client_id: microsoftConfiguration.clientId,
      client_secret: microsoftConfiguration.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetchWithRetry(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(data.error_description || "Microsoft authentication failed."),
        { status: 502, code: "MICROSOFT_AUTH_FAILED" },
      );
    return data.access_token;
  }
  async function graphAppToken(organizationId) {
    const connection = organizationId
      ? microsoftConnection(organizationId, true)
      : signature.microsoftTenantId
        ? {
            tenant_id: signature.microsoftTenantId,
            sender_email: signature.microsoftSenderEmail || "",
          }
        : null;
    if (!connection)
      throw Object.assign(
        new Error("Connect this tenant to Microsoft 365 before continuing."),
        { status: 409, code: "MICROSOFT_TENANT_NOT_CONNECTED" },
      );
    return {
      token: await graphTokenForTenant(connection.tenant_id),
      connection,
    };
  }
  async function verifyMicrosoftTenant(tenantId) {
    const token = await graphTokenForTenant(tenantId),
      response = await fetchWithRetry(
        "https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains",
        { headers: { Authorization: `Bearer ${token}` } },
      ),
      data = await response.json();
    if (!response.ok || !Array.isArray(data.value) || !data.value[0])
      throw Object.assign(
        new Error(
          data.error?.message ||
            "Microsoft 365 consent could not be verified. Confirm the configured application permissions and grant consent again.",
        ),
        { status: 502, code: "MICROSOFT_CONSENT_VERIFICATION_FAILED" },
      );
    if (String(data.value[0].id).toLowerCase() !== tenantId.toLowerCase())
      throw Object.assign(new Error("Microsoft returned a different tenant."), {
        status: 400,
        code: "MICROSOFT_TENANT_MISMATCH",
      });
    return { token, organization: data.value[0] };
  }
  async function graphDirectoryUsers(token) {
    const users = [];
    let nextUrl =
        "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,businessPhones,mobilePhone,assignedLicenses&$top=999",
      pageCount = 0;
    while (nextUrl) {
      const parsed = new URL(nextUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "graph.microsoft.com"
      )
        throw Object.assign(
          new Error("Microsoft Graph returned an invalid pagination URL."),
          { status: 502, code: "MICROSOFT_GRAPH_INVALID_RESPONSE" },
        );
      pageCount += 1;
      if (pageCount > 100)
        throw Object.assign(
          new Error("Microsoft Graph directory response exceeded 100 pages."),
          { status: 502, code: "MICROSOFT_GRAPH_PAGE_LIMIT" },
        );
      const response = await fetchWithRetry(parsed.href, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        data = await response.json();
      if (!response.ok)
        throw Object.assign(
          new Error(
            data.error?.message || "Microsoft Graph directory request failed.",
          ),
          { status: 502, code: "MICROSOFT_GRAPH_FAILED" },
        );
      if (!Array.isArray(data.value))
        throw Object.assign(
          new Error("Microsoft Graph returned an invalid directory response."),
          { status: 502, code: "MICROSOFT_GRAPH_INVALID_RESPONSE" },
        );
      users.push(...data.value);
      nextUrl = data["@odata.nextLink"] || "";
    }
    return users;
  }
  async function sendGraphMail(organizationId, to, subject, html) {
    const { token, connection } = await graphAppToken(organizationId),
      sender = connection.sender_email;
    if (!sender)
      throw Object.assign(
        new Error("Microsoft sender mailbox is not configured."),
        { status: 400, code: "MICROSOFT_SENDER_REQUIRED" },
      );
    const response = await fetchWithRetry(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: true,
        }),
      },
    );
    if (!response.ok)
      throw Object.assign(
        new Error("Microsoft 365 could not send the message."),
        { status: 502, code: "MICROSOFT_SEND_FAILED" },
      );
  }
  async function downloadMicrosoftProfilePhoto(token, row) {
    const response = await fetchWithRetry(
      "https://graph.microsoft.com/v1.0/me/photo/$value",
      { headers: { Authorization: `Bearer ${token}` } },
      1,
    );
    if (!response.ok) return "";
    const bytes = Buffer.from(await response.arrayBuffer()),
      format = imageFormat(bytes);
    if (!format || bytes.length > 4 * 1024 * 1024) return "";
    const processed = await normalizeUploadedImage(bytes, "photo", format),
      ext = processed.format === "jpeg" ? "jpg" : processed.format,
      dir = path.join(publicRoot, "uploads", row.organization_id),
      name = `microsoft-profile-${row.id}.${ext}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), processed.bytes);
    return `/uploads/${row.organization_id}/${name}`;
  }

  function workflowActor(organizationId, actorUserId) {
    const row = memberById(organizationId, actorUserId);
    if (!row)
      throw Object.assign(new Error("Workflow actor is no longer a member."), {
        code: "WORKFLOW_ACTOR_NOT_FOUND",
      });
    return userDto(row);
  }

  function requestForOrigin(origin) {
    const parsed = new URL(cleanUrl(origin) || "http://127.0.0.1:4173");
    return {
      headers: { host: parsed.host },
      socket: { encrypted: parsed.protocol === "https:" },
    };
  }

  async function performBulkRollout(payload) {
    const user = workflowActor(payload.organizationId, payload.actorUserId),
      overwrite = Boolean(payload.overwrite),
      sendEmail = Boolean(payload.sendEmail),
      rows = db
        .prepare(
          `${memberSelect} WHERE m.organization_id=? AND m.status='active'`,
        )
        .all(user.organizationId),
      defaults = new Map(
        db
          .prepare(
            "SELECT * FROM department_signature_defaults WHERE organization_id=?",
          )
          .all(user.organizationId)
          .map((row) => [row.department.toLowerCase(), row]),
      ),
      updated = [],
      skipped = [],
      errors = [],
      request = requestForOrigin(payload.origin);
    if (sendEmail && !mailAvailable(user.organizationId))
      throw Object.assign(
        new Error("Microsoft 365 email delivery is not configured."),
        { code: "MAIL_NOT_CONFIGURED" },
      );
    rolloutTemplatePatch(user.organizationId, payload.templateId);
    let emailed = 0;
    for (const row of rows) {
      const sig = normalizeSignature(row);
      if (!overwrite && sig.updatedAt) {
        skipped.push(row.id);
        continue;
      }
      const dept = defaults.get(
          String(sig.fields.department || "").toLowerCase(),
        ),
        selectedTemplate = String(
          dept?.template_id || payload.templateId || sig.templateId,
        );
      try {
        const patch = rolloutTemplatePatch(
            user.organizationId,
            selectedTemplate,
          ),
          next = {
            ...sig,
            ...patch,
            fields: sig.fields,
            colors: { ...sig.colors, ...(patch.colors || {}) },
            workflowStatus: "approved",
            approvedAt: new Date().toISOString(),
            approvedBy: user.id,
          };
        if (dept?.accent_color) next.colors.accent = dept.accent_color;
        saveSignatureRow(user.organizationId, row.id, next);
        updated.push(row.id);
        if (sendEmail) {
          try {
            const target = userDto(memberById(user.organizationId, row.id)),
              rendered = await renderSignature(
                request,
                target,
                target.signature,
              );
            await sendGraphMail(
              user.organizationId,
              target.email,
              "Your email signature is ready",
              installEmailBody(rendered.html),
            );
            emailed += 1;
          } catch (error) {
            errors.push({
              userId: row.id,
              email: row.email,
              code: error.code || "EMAIL_DELIVERY_FAILED",
              message: "Signature updated, but its email could not be sent.",
            });
          }
        }
      } catch (error) {
        errors.push({
          userId: row.id,
          email: row.email,
          code: error.code || "ROLLOUT_FAILED",
          message: limited(error.message || "Rollout failed.", 240),
        });
      }
    }
    const result = {
      updated: updated.length,
      skipped: skipped.length,
      emailed,
      errors,
      total: rows.length,
    };
    recordAudit(
      user,
      "rollout.completed",
      "organization",
      user.organizationId,
      { ...result, errors: errors.length, overwrite, sendEmail },
    );
    return result;
  }

  async function performDirectorySync(payload) {
    const user = workflowActor(payload.organizationId, payload.actorUserId),
      runId = payload.runId;
    db.prepare(
      "UPDATE directory_sync_runs SET status='running',error_message=NULL,completed_at=NULL WHERE id=? AND organization_id=?",
    ).run(runId, user.organizationId);
    let transactionStarted = false;
    try {
      const { token } = await graphAppToken(user.organizationId),
        people = (await graphDirectoryUsers(token)).filter(
          (item) => item.assignedLicenses?.length,
        );
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const subscription = db
          .prepare(
            "SELECT seats FROM organization_subscriptions WHERE organization_id=?",
          )
          .get(user.organizationId),
        activeMembers = db
          .prepare(
            "SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id=? AND status='active'",
          )
          .get(user.organizationId).count,
        availableSeats = Math.max(
          0,
          (subscription?.seats || 1) - activeMembers,
        );
      let added = 0;
      for (const person of people) {
        const email = String(
          person.mail || person.userPrincipalName || "",
        ).toLowerCase();
        if (!validEmail(email)) continue;
        const account = db
            .prepare(
              "SELECT * FROM signature_users WHERE lower(email)=lower(?)",
            )
            .get(email),
          id = account?.id || randomUUID(),
          personSignature = normalizeSignature(
            { display_name: person.displayName, email, signature_json: "{}" },
            {
              fields: {
                name: person.displayName,
                email,
                jobTitle: person.jobTitle || "",
                department: person.department || "",
                phone: person.businessPhones?.[0] || "",
                mobile: person.mobilePhone || "",
                company: workspaceRow(user).name,
              },
            },
          ),
          existingMembership = memberById(user.organizationId, id);
        if (!existingMembership && added >= availableSeats) continue;
        if (!account)
          db.prepare(
            `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at) VALUES (?,?,?,?,'editor','active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          ).run(
            id,
            email,
            hashPassword(randomBytes(32).toString("hex")),
            person.displayName || email,
            JSON.stringify(personSignature),
          );
        if (!existingMembership) {
          db.prepare(
            `INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,'editor','active',?)`,
          ).run(user.organizationId, id, JSON.stringify(personSignature));
          added += 1;
        }
      }
      db.prepare(
        `UPDATE directory_sync_runs SET status='completed',users_seen=?,users_added=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(people.length, added, runId);
      db.prepare(
        `UPDATE organization_microsoft_connections SET last_sync_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(user.organizationId);
      recordAudit(
        user,
        "directory.synced",
        "organization",
        user.organizationId,
        { seen: people.length, added },
      );
      db.exec("COMMIT");
      transactionStarted = false;
      return { seen: people.length, added, runId };
    } catch (error) {
      if (transactionStarted) db.exec("ROLLBACK");
      db.prepare(
        `UPDATE directory_sync_runs SET status='failed',error_message=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(String(error.message).slice(0, 500), runId);
      db.prepare(
        `UPDATE organization_microsoft_connections SET last_error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(String(error.message).slice(0, 500), user.organizationId);
      throw error;
    }
  }

  const workflowHandlers = {
    "directory.sync": performDirectorySync,
    "signature.rollout": performBulkRollout,
  };

  const handlePlatformOperations = createPlatformOperationsRoutes({
      json,
      operations,
      readJsonBody,
      recordAudit: recordApplicationAudit,
    }),
    handlePlatformJobs = createPlatformJobRoutes({
      db,
      json,
      readJsonBody,
      recordAudit: recordApplicationAudit,
    });
  const handle = async function handle(req, res, url, requestId) {
    if (url.pathname === "/webhooks/stripe" && req.method === "POST") {
      const stripeConfiguration = stripeSettings(),
        stripe = stripeClient(stripeConfiguration);
      if (!stripe || !stripeConfiguration.webhookSecret)
        return json(
          res,
          503,
          {
            error: {
              code: "STRIPE_NOT_CONFIGURED",
              message: "Billing webhook is not configured.",
            },
          },
          requestId,
        );
      const rawBody = await readBody(req, { limit: 1024 * 1024 });
      let event;
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          String(req.headers["stripe-signature"] || ""),
          stripeConfiguration.webhookSecret,
        );
      } catch {
        return json(
          res,
          400,
          {
            error: {
              code: "STRIPE_SIGNATURE_INVALID",
              message: "Invalid webhook signature.",
            },
          },
          requestId,
        );
      }
      if (
        db
          .prepare("SELECT 1 FROM stripe_webhook_events WHERE event_id=?")
          .get(event.id)
      )
        return json(res, 200, { received: true, duplicate: true }, requestId);
      db.exec("BEGIN IMMEDIATE");
      try {
        applyStripeEvent(event);
        db.prepare(
          "INSERT INTO stripe_webhook_events(event_id,event_type,livemode) VALUES (?,?,?)",
        ).run(event.id, event.type, event.livemode ? 1 : 0);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { received: true }, requestId);
    }
    if (
      url.pathname === "/auth/microsoft/admin-consent" &&
      req.method === "GET"
    ) {
      const user = requireSession(req);
      requireAdmin(user);
      if (!microsoftAvailable())
        return redirect(res, "/admin.html?microsoft=unavailable#settings");
      const state = randomBytes(24).toString("base64url");
      db.prepare(
        "INSERT INTO oauth_states(token_hash,provider,expires_at,purpose,organization_id,user_id) VALUES (?,'microsoft',?,'admin_consent',?,?)",
      ).run(
        tokenHash(state),
        new Date(Date.now() + 600000).toISOString(),
        user.organizationId,
        user.id,
      );
      const microsoftConfiguration = microsoftSettings(),
        callback = `${publicBase(req, user)}/auth/microsoft/admin-consent/callback`,
        params = new URLSearchParams({
          client_id: microsoftConfiguration.clientId,
          scope: "https://graph.microsoft.com/.default",
          redirect_uri: callback,
          state,
        });
      return redirect(
        res,
        `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${params}`,
        { "Set-Cookie": oauthStateCookie(state, 600, production) },
      );
    }
    if (
      url.pathname === "/auth/microsoft/admin-consent/callback" &&
      req.method === "GET"
    ) {
      const clearOauthCookie = oauthStateCookie("", 0, production),
        state = url.searchParams.get("state"),
        stateCookie = cookie(req, "sig_oauth_state");
      if (!state || !stateCookie || tokenHash(state) !== tokenHash(stateCookie))
        return textResponse(
          res,
          400,
          "Microsoft consent state expired.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const storedState = db
        .prepare(
          `DELETE FROM oauth_states WHERE token_hash=? AND provider='microsoft' AND purpose='admin_consent' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING *`,
        )
        .get(tokenHash(state));
      if (!storedState)
        return textResponse(
          res,
          400,
          "Microsoft consent state expired.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const user = requireSession(req);
      requireAdmin(user);
      if (
        user.id !== storedState.user_id ||
        user.organizationId !== storedState.organization_id
      )
        throw Object.assign(new Error("Consent session does not match."), {
          status: 403,
          code: "MICROSOFT_CONSENT_SESSION_MISMATCH",
        });
      if (
        url.searchParams.get("error") ||
        String(url.searchParams.get("admin_consent")).toLowerCase() !== "true"
      )
        return redirect(res, "/admin.html?microsoft=canceled#settings", {
          "Set-Cookie": clearOauthCookie,
        });
      const tenantId = String(url.searchParams.get("tenant") || "").trim();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          tenantId,
        )
      )
        throw Object.assign(
          new Error("Microsoft returned an invalid tenant ID."),
          {
            status: 400,
            code: "MICROSOFT_TENANT_INVALID",
          },
        );
      const existing = db
        .prepare(
          "SELECT organization_id FROM organization_microsoft_connections WHERE tenant_id=? AND organization_id<>?",
        )
        .get(tenantId, user.organizationId);
      if (existing)
        throw Object.assign(
          new Error(
            "This Microsoft 365 tenant is already connected to another Signify tenant.",
          ),
          { status: 409, code: "MICROSOFT_TENANT_ALREADY_CONNECTED" },
        );
      const verified = await verifyMicrosoftTenant(tenantId);
      db.prepare(
        `INSERT INTO organization_microsoft_connections(organization_id,tenant_id,tenant_name,status,connected_by,consented_at,last_verified_at,last_error) VALUES (?,?,?,'connected',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),'') ON CONFLICT(organization_id) DO UPDATE SET tenant_id=excluded.tenant_id,tenant_name=excluded.tenant_name,status='connected',connected_by=excluded.connected_by,consented_at=excluded.consented_at,last_verified_at=excluded.last_verified_at,last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(
        user.organizationId,
        tenantId,
        limited(verified.organization.displayName, 180),
        user.id,
      );
      recordAudit(user, "microsoft.connected", "microsoft_tenant", tenantId, {
        tenantName: verified.organization.displayName,
      });
      return redirect(res, "/admin.html?microsoft=connected#settings", {
        "Set-Cookie": clearOauthCookie,
      });
    }
    if (url.pathname === "/auth/microsoft" && req.method === "GET") {
      if (!microsoftAvailable())
        return redirect(res, "/signature.html?auth=microsoft-unavailable");
      const state = randomBytes(24).toString("base64url"),
        nonce = randomBytes(24).toString("base64url"),
        codeVerifier = randomBytes(48).toString("base64url"),
        codeChallenge = createHash("sha256")
          .update(codeVerifier)
          .digest("base64url");
      db.prepare(
        "INSERT INTO oauth_states(token_hash,provider,expires_at,purpose) VALUES (?,'microsoft',?,'login')",
      ).run(tokenHash(state), new Date(Date.now() + 600000).toISOString());
      db.prepare(
        "INSERT INTO oauth_state_security(token_hash,code_verifier,nonce) VALUES (?,?,?)",
      ).run(tokenHash(state), codeVerifier, nonce);
      const microsoftConfiguration = microsoftSettings(),
        callback = `${applicationPublicBase(req)}/auth/microsoft/callback`,
        params = new URLSearchParams({
          client_id: microsoftConfiguration.clientId,
          response_type: "code",
          redirect_uri: callback,
          response_mode: "query",
          scope: "openid profile email User.Read",
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
      return redirect(
        res,
        `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?${params}`,
        { "Set-Cookie": oauthStateCookie(state, 600, production) },
      );
    }
    if (url.pathname === "/auth/microsoft/callback" && req.method === "GET") {
      const state = url.searchParams.get("state"),
        stateCookie = cookie(req, "sig_oauth_state"),
        clearOauthCookie = oauthStateCookie("", 0, production);
      if (!state || !stateCookie || tokenHash(state) !== tokenHash(stateCookie))
        return textResponse(
          res,
          400,
          "Microsoft sign-in state expired.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const storedState = db
        .prepare(
          `SELECT o.*,s.code_verifier,s.nonce FROM oauth_states o JOIN oauth_state_security s ON s.token_hash=o.token_hash WHERE o.token_hash=? AND o.provider='microsoft' AND o.purpose='login' AND o.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .get(tokenHash(state || ""));
      if (!storedState)
        return textResponse(
          res,
          400,
          "Microsoft sign-in state expired.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      db.prepare("DELETE FROM oauth_states WHERE token_hash=?").run(
        storedState.token_hash,
      );
      if (url.searchParams.get("error"))
        return textResponse(
          res,
          400,
          "Microsoft sign-in was canceled.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const authorizationCode = String(
        url.searchParams.get("code") || "",
      ).trim();
      if (!authorizationCode)
        return textResponse(
          res,
          400,
          "Microsoft sign-in authorization code is missing.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const microsoftConfiguration = microsoftSettings(),
        callback = `${applicationPublicBase(req)}/auth/microsoft/callback`,
        body = new URLSearchParams({
          client_id: microsoftConfiguration.clientId,
          client_secret: microsoftConfiguration.clientSecret,
          code: authorizationCode,
          redirect_uri: callback,
          grant_type: "authorization_code",
          scope: "openid profile email User.Read",
          code_verifier: storedState.code_verifier,
        }),
        tokenRes = await fetchWithRetry(
          `https://login.microsoftonline.com/organizations/oauth2/v2.0/token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body,
          },
        ),
        tokens = await tokenRes.json();
      if (!tokenRes.ok)
        return textResponse(
          res,
          502,
          tokens.error_description || "Microsoft sign-in failed.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const idToken = await verifyMicrosoftIdToken(
          tokens.id_token,
          storedState.nonce,
        ),
        meRes = await fetchWithRetry(
          "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department,businessPhones,mobilePhone",
          { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        );
      if (!meRes.ok)
        return textResponse(
          res,
          502,
          "Microsoft profile request failed.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      const profile = await meRes.json(),
        microsoftTenantId = String(idToken.tid || ""),
        email = String(
          profile.mail || profile.userPrincipalName || "",
        ).toLowerCase();
      if (!validEmail(email))
        return textResponse(
          res,
          400,
          "Microsoft account has no usable email address.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      if (!microsoftTenantId)
        return textResponse(
          res,
          502,
          "Microsoft sign-in did not identify an organization tenant.",
          "text/plain; charset=utf-8",
          { "Set-Cookie": clearOauthCookie },
        );
      let row = db
        .prepare(
          `${memberSelect} JOIN organization_microsoft_connections mc ON mc.organization_id=o.id AND mc.status='connected' WHERE lower(u.email)=lower(?) AND lower(mc.tenant_id)=lower(?) ORDER BY m.created_at LIMIT 1`,
        )
        .get(email, microsoftTenantId);
      if (!row) {
        return redirect(res, "/signature.html?auth=account-required", {
          "Set-Cookie": clearOauthCookie,
        });
      }
      const current = normalizeSignature(row),
        fields = { ...current.fields };
      fields.name = fields.name || limited(profile.displayName, 120);
      fields.jobTitle = fields.jobTitle || limited(profile.jobTitle, 120);
      fields.department = fields.department || limited(profile.department, 120);
      fields.phone = fields.phone || limited(profile.businessPhones?.[0], 60);
      fields.mobile = fields.mobile || limited(profile.mobilePhone, 60);
      let photoUrl = current.photoUrl;
      if (!photoUrl) {
        try {
          photoUrl = await downloadMicrosoftProfilePhoto(
            tokens.access_token,
            row,
          );
        } catch {
          photoUrl = "";
        }
      }
      db.prepare(
        `UPDATE signature_users SET display_name=?,last_login_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(limited(profile.displayName || row.display_name, 120), row.id);
      saveSignatureRow(row.organization_id, row.id, {
        ...current,
        fields,
        photoUrl,
      });
      row = memberById(row.organization_id, row.id);
      const session = createSession(req, row);
      recordAudit(session.user, "profile.microsoft_synced", "user", row.id, {
        photoImported: Boolean(photoUrl && photoUrl !== current.photoUrl),
      });
      session.header["Set-Cookie"].push(clearOauthCookie);
      return redirect(res, "/signature.html", session.header);
    }
    const redirectMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    if (redirectMatch && req.method === "GET") {
      const row = db
        .prepare("SELECT * FROM signature_tracking_links WHERE id=?")
        .get(redirectMatch[1]);
      if (!row || !validUrl(row.destination_url)) return redirect(res, "/");
      db.prepare(
        `UPDATE signature_tracking_links SET clicks=clicks+1,last_clicked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(row.id);
      return redirect(res, row.destination_url);
    }
    const vcardMatch = url.pathname.match(/^\/vcard\/([^/]+)\/([^/]+)\.vcf$/);
    if (vcardMatch && req.method === "GET") {
      const row = memberById(vcardMatch[1], vcardMatch[2]);
      if (!row) return textResponse(res, 404, "Contact not found.");
      const sig = normalizeSignature(row),
        f = sig.fields,
        escape = (v) =>
          String(v || "")
            .replace(/([,;\\])/g, "\\$1")
            .replace(/\n/g, "\\n"),
        card = [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `FN:${escape(f.name)}`,
          `TITLE:${escape(f.jobTitle)}`,
          `ORG:${escape(f.company)}`,
          `EMAIL;TYPE=INTERNET:${escape(f.email)}`,
          f.phone ? `TEL;TYPE=WORK,VOICE:${escape(f.phone)}` : "",
          f.mobile ? `TEL;TYPE=CELL:${escape(f.mobile)}` : "",
          f.website ? `URL:${escape(f.website)}` : "",
          f.address ? `ADR;TYPE=WORK:;;${escape(f.address)};;;;` : "",
          "END:VCARD",
        ]
          .filter(Boolean)
          .join("\r\n");
      return textResponse(res, 200, card, "text/vcard; charset=utf-8", {
        "Content-Disposition": `attachment; filename="${slug(f.name)}.vcf"`,
      });
    }
    if (url.pathname.startsWith("/api/platform/")) {
      const owner = requireApplicationSession(req);
      requireApplicationOwner(owner);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
        enforceCsrf(req, owner);
      if (url.pathname === "/api/platform/session" && req.method === "GET") {
        const counts = db
          .prepare(
            `SELECT COUNT(*) organizations,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) suspended FROM organizations`,
          )
          .get();
        return json(
          res,
          200,
          {
            user: owner,
            stats: {
              organizations: counts.organizations || 0,
              active: counts.active || 0,
              suspended: counts.suspended || 0,
              microsoftConnected: db
                .prepare(
                  "SELECT COUNT(*) count FROM organization_microsoft_connections WHERE status='connected'",
                )
                .get().count,
            },
            stripe: {
              configured: billingAvailable(),
              ...integrationSummary("stripe"),
              vaultConfigured: credentialVault.configured,
              plans: Object.entries(stripeSettings().prices || {})
                .filter(([, price]) => Boolean(price))
                .map(([plan]) => plan),
            },
          },
          requestId,
          refreshCsrf(owner),
        );
      }
      if (await handlePlatformOperations({ req, res, url, requestId, owner }))
        return;
      if (await handlePlatformJobs({ req, res, url, requestId, owner })) return;
      if (url.pathname === "/api/platform/integrations" && req.method === "GET")
        return json(
          res,
          200,
          {
            vault: {
              configured: credentialVault.configured,
              keyId: credentialVault.keyId,
            },
            stripe: {
              ...integrationSummary("stripe"),
              configured: billingAvailable(),
              prices: stripeSettings().prices,
              catalog:
                safeJson(integrationRow("stripe")?.configuration_json)
                  .catalog || [],
            },
            microsoft: {
              ...integrationSummary("microsoft"),
              ...safeJson(integrationRow("microsoft")?.configuration_json),
              configured: microsoftAvailable(),
            },
          },
          requestId,
        );
      if (url.pathname === "/api/platform/setup" && req.method === "GET") {
        const companyName = applicationSetting(
            "company_name",
            signature.companyName || "",
          ),
          publicUrl = applicationSetting(
            "public_url",
            signature.publicUrl || "",
          ),
          stripeSkipped = applicationSetting("stripe_skipped") === "true",
          microsoft = microsoftSettings();
        return json(
          res,
          200,
          {
            company: {
              name: companyName,
              publicUrl,
              ready: Boolean(companyName && publicUrl),
            },
            vault: {
              configured: credentialVault.configured,
              keyId: credentialVault.keyId,
            },
            microsoft: {
              ...integrationSummary("microsoft"),
              configured: microsoftAvailable(),
              homeTenantId: microsoft.homeTenantId,
            },
            stripe: {
              ...integrationSummary("stripe"),
              configured: billingAvailable(),
              skipped: stripeSkipped,
            },
            complete: Boolean(
              companyName &&
              publicUrl &&
              credentialVault.configured &&
              microsoftAvailable() &&
              (billingAvailable() || stripeSkipped),
            ),
          },
          requestId,
        );
      }
      if (
        url.pathname === "/api/platform/setup/application" &&
        req.method === "PUT"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          companyName = limited(body.companyName, 120),
          publicUrl = cleanUrl(body.publicUrl);
        if (companyName.length < 2 || !validUrl(publicUrl))
          throw Object.assign(
            new Error("Enter a company name and valid public application URL."),
            { status: 400, code: "APPLICATION_SETUP_INVALID" },
          );
        if (production && !publicUrl.startsWith("https://"))
          throw Object.assign(
            new Error("The production public URL must use HTTPS."),
            { status: 400, code: "APPLICATION_URL_INSECURE" },
          );
        const update = db.prepare(
          `INSERT INTO application_settings(setting_key,setting_value,updated_by) VALUES (?,?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        );
        db.exec("BEGIN IMMEDIATE");
        try {
          update.run("company_name", companyName, owner.id);
          update.run("public_url", publicUrl, owner.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        recordApplicationAudit(
          owner,
          "application.setup_updated",
          "application_settings",
          "identity",
          null,
          limited(body.reason || "Configure application identity", 500),
          { companyName, publicUrl },
          requestId,
        );
        return json(res, 200, { companyName, publicUrl }, requestId);
      }
      if (
        url.pathname === "/api/platform/setup/stripe-skip" &&
        req.method === "PUT"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          skipped = Boolean(body.skipped);
        db.prepare(
          `INSERT INTO application_settings(setting_key,setting_value,updated_by) VALUES ('stripe_skipped',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(skipped ? "true" : "false", owner.id);
        recordApplicationAudit(
          owner,
          skipped ? "stripe.setup_skipped" : "stripe.setup_required",
          "application_settings",
          "stripe_skipped",
          null,
          limited(body.reason || "Update Stripe setup choice", 500),
          {},
          requestId,
        );
        return json(res, 200, { skipped }, requestId);
      }
      if (
        url.pathname === "/api/platform/integrations/microsoft/connect" &&
        req.method === "POST"
      ) {
        const body = await readJsonBody(req, { limit: 16384 }),
          clientId = limited(body.clientId, 100),
          clientSecret = String(body.clientSecret || "").trim(),
          homeTenantId = limited(body.homeTenantId, 100),
          guid =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!guid.test(clientId) || !guid.test(homeTenantId) || !clientSecret)
          throw Object.assign(
            new Error(
              "Enter the Microsoft application ID, home tenant ID, and client credential.",
            ),
            { status: 400, code: "MICROSOFT_CONFIGURATION_INVALID" },
          );
        const tokenResponse = await fetchWithRetry(
            `https://login.microsoftonline.com/${encodeURIComponent(homeTenantId)}/oauth2/v2.0/token`,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                scope: "https://graph.microsoft.com/.default",
                grant_type: "client_credentials",
              }),
            },
          ),
          tokens = await tokenResponse.json();
        if (!tokenResponse.ok || !tokens.access_token)
          throw Object.assign(
            new Error(
              tokens.error_description ||
                "Microsoft rejected the application credentials.",
            ),
            { status: 502, code: "MICROSOFT_CONFIGURATION_REJECTED" },
          );
        const requiredPermissions = [
            "Mail.Send",
            "Organization.Read.All",
            "User.Read.All",
          ],
          accessClaims = jwtPayload(tokens.access_token),
          permissions = Array.isArray(accessClaims.roles)
            ? accessClaims.roles.sort()
            : [],
          missingPermissions = requiredPermissions.filter(
            (permission) => !permissions.includes(permission),
          );
        if (
          String(tokens.access_token).split(".").length === 3 &&
          missingPermissions.length
        )
          throw Object.assign(
            new Error(
              `Microsoft admin consent is missing: ${missingPermissions.join(", ")}.`,
            ),
            { status: 409, code: "MICROSOFT_PERMISSIONS_MISSING" },
          );
        const organizationResponse = await fetchWithRetry(
            "https://graph.microsoft.com/v1.0/organization?$select=id,displayName,verifiedDomains",
            { headers: { Authorization: `Bearer ${tokens.access_token}` } },
          ),
          organizationData = await organizationResponse.json(),
          organization = organizationData.value?.[0];
        if (!organizationResponse.ok || !organization)
          throw Object.assign(
            new Error("Microsoft Graph organization verification failed."),
            { status: 502, code: "MICROSOFT_CONFIGURATION_REJECTED" },
          );
        const encrypted = credentialVault.encrypt("microsoft", {
          clientId,
          clientSecret,
        });
        db.prepare(
          `INSERT INTO application_integrations(provider,status,mode,account_id,account_name,configuration_json,encrypted_credentials,credential_key_id,last_verified_at,last_error,updated_by) VALUES ('microsoft','connected','multitenant',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'',?) ON CONFLICT(provider) DO UPDATE SET status='connected',mode='multitenant',account_id=excluded.account_id,account_name=excluded.account_name,configuration_json=excluded.configuration_json,encrypted_credentials=excluded.encrypted_credentials,credential_key_id=excluded.credential_key_id,last_verified_at=excluded.last_verified_at,last_error='',updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(
          organization.id || homeTenantId,
          limited(organization.displayName || homeTenantId, 180),
          JSON.stringify({
            homeTenantId,
            permissions,
            requiredPermissions,
            missingPermissions,
          }),
          encrypted,
          credentialVault.keyId,
          owner.id,
        );
        microsoftJwksCache = { expiresAt: 0, keys: [] };
        recordApplicationAudit(
          owner,
          "microsoft.application_connected",
          "application_integration",
          "microsoft",
          null,
          limited(body.reason || "Configure Microsoft application", 500),
          { homeTenantId, organizationName: organization.displayName },
          requestId,
        );
        return json(
          res,
          200,
          { integration: integrationSummary("microsoft") },
          requestId,
        );
      }
      if (
        url.pathname === "/api/platform/integrations/microsoft" &&
        req.method === "DELETE"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          reason = limited(body.reason, 500);
        if (reason.length < 3)
          throw Object.assign(new Error("A reason is required."), {
            status: 400,
            code: "REASON_REQUIRED",
          });
        db.prepare(
          "DELETE FROM application_integrations WHERE provider='microsoft'",
        ).run();
        microsoftJwksCache = { expiresAt: 0, keys: [] };
        recordApplicationAudit(
          owner,
          "microsoft.application_disconnected",
          "application_integration",
          "microsoft",
          null,
          reason,
          {},
          requestId,
        );
        return json(res, 200, { disconnected: true }, requestId);
      }
      if (
        url.pathname === "/api/platform/integrations/stripe/connect" &&
        req.method === "POST"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          secretKey = String(body.secretKey || "").trim();
        if (!/^sk_(test|live)_[A-Za-z0-9_]+$/.test(secretKey))
          throw Object.assign(new Error("Enter a valid Stripe secret key."), {
            status: 400,
            code: "STRIPE_KEY_INVALID",
          });
        const client = stripeFactory(secretKey);
        let account, prices;
        try {
          [account, prices] = await Promise.all([
            client.accounts.retrieve(),
            client.prices.list({
              active: true,
              type: "recurring",
              limit: 100,
              expand: ["data.product"],
            }),
          ]);
        } catch (cause) {
          throw Object.assign(
            new Error("Stripe rejected the key or could not be reached."),
            { status: 502, code: "STRIPE_CONNECTION_FAILED", cause },
          );
        }
        const priceCatalog = prices.data.map((price) => ({
            id: price.id,
            productId:
              typeof price.product === "string"
                ? price.product
                : price.product?.id || "",
            productName:
              typeof price.product === "object"
                ? price.product?.name || "Unnamed product"
                : "Stripe product",
            currency: price.currency,
            unitAmount: price.unit_amount,
            interval: price.recurring?.interval || "",
            intervalCount: price.recurring?.interval_count || 1,
          })),
          encrypted = credentialVault.encrypt("stripe", {
            secretKey,
            webhookSecret: "",
          });
        db.prepare(
          `INSERT INTO application_integrations(provider,status,mode,account_id,account_name,configuration_json,encrypted_credentials,credential_key_id,last_verified_at,last_error,updated_by) VALUES ('stripe','connected',?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'',?) ON CONFLICT(provider) DO UPDATE SET status='connected',mode=excluded.mode,account_id=excluded.account_id,account_name=excluded.account_name,encrypted_credentials=excluded.encrypted_credentials,credential_key_id=excluded.credential_key_id,last_verified_at=excluded.last_verified_at,last_error='',updated_by=excluded.updated_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(
          secretKey.startsWith("sk_live_") ? "live" : "test",
          account.id || "",
          limited(
            account.settings?.dashboard?.display_name ||
              account.business_profile?.name ||
              account.email ||
              account.id,
            180,
          ),
          JSON.stringify({ prices: {}, catalog: priceCatalog }),
          encrypted,
          credentialVault.keyId,
          owner.id,
        );
        recordApplicationAudit(
          owner,
          "stripe.connected",
          "application_integration",
          "stripe",
          null,
          limited(body.reason || "Connect Stripe", 500),
          {
            accountId: account.id,
            mode: secretKey.startsWith("sk_live_") ? "live" : "test",
          },
          requestId,
        );
        return json(
          res,
          200,
          {
            integration: integrationSummary("stripe"),
            prices: priceCatalog,
          },
          requestId,
        );
      }
      if (
        url.pathname === "/api/platform/integrations/stripe/configure" &&
        req.method === "PUT"
      ) {
        const body = await readJsonBody(req, { limit: 16384 }),
          settings = stripeSettings(),
          client = stripeClient(settings);
        if (!client || settings.source !== "vault")
          throw Object.assign(
            new Error("Connect Stripe before mapping plans."),
            {
              status: 409,
              code: "STRIPE_NOT_CONNECTED",
            },
          );
        const selected = Object.fromEntries(
          ["starter", "team", "business"]
            .map((plan) => [plan, limited(body.prices?.[plan], 255)])
            .filter(([, value]) => Boolean(value)),
        );
        if (!Object.keys(selected).length)
          throw Object.assign(
            new Error("Map at least one Signify plan to a Stripe price."),
            { status: 400, code: "STRIPE_PRICE_REQUIRED" },
          );
        let available;
        try {
          available = await client.prices.list({
            active: true,
            type: "recurring",
            limit: 100,
          });
        } catch (cause) {
          throw Object.assign(
            new Error("Stripe prices could not be verified."),
            {
              status: 502,
              code: "STRIPE_PRICE_VERIFICATION_FAILED",
              cause,
            },
          );
        }
        const validPrices = new Set(available.data.map((price) => price.id));
        if (Object.values(selected).some((price) => !validPrices.has(price)))
          throw Object.assign(
            new Error("One or more selected Stripe prices are unavailable."),
            { status: 400, code: "STRIPE_PRICE_INVALID" },
          );
        const webhookUrl = `${applicationPublicBase(req)}/webhooks/stripe`,
          enabledEvents = [
            "checkout.session.completed",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "invoice.paid",
            "invoice.payment_failed",
          ],
          currentConfiguration = safeJson(
            integrationRow("stripe")?.configuration_json,
          );
        let endpoint;
        try {
          endpoint = currentConfiguration.webhookEndpointId
            ? {
                ...(await client.webhookEndpoints.update(
                  currentConfiguration.webhookEndpointId,
                  {
                    url: webhookUrl,
                    description: "Signify Creator subscription events",
                    enabled_events: enabledEvents,
                  },
                )),
                secret: settings.webhookSecret,
              }
            : await client.webhookEndpoints.create({
                url: webhookUrl,
                description: "Signify Creator subscription events",
                enabled_events: enabledEvents,
              });
        } catch (cause) {
          throw Object.assign(
            new Error(
              "Stripe could not create the webhook endpoint. Confirm the public application URL is reachable over HTTPS.",
            ),
            { status: 502, code: "STRIPE_WEBHOOK_CREATE_FAILED", cause },
          );
        }
        const encrypted = credentialVault.encrypt("stripe", {
          secretKey: settings.secretKey,
          webhookSecret: endpoint.secret,
        });
        db.prepare(
          `UPDATE application_integrations SET status='connected',configuration_json=?,encrypted_credentials=?,credential_key_id=?,last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='',updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE provider='stripe'`,
        ).run(
          JSON.stringify({
            prices: selected,
            catalog: currentConfiguration.catalog || [],
            webhookEndpointId: endpoint.id,
          }),
          encrypted,
          credentialVault.keyId,
          owner.id,
        );
        recordApplicationAudit(
          owner,
          "stripe.configured",
          "application_integration",
          "stripe",
          null,
          limited(body.reason || "Configure Stripe plans", 500),
          { plans: Object.keys(selected), webhookEndpointId: endpoint.id },
          requestId,
        );
        return json(
          res,
          200,
          { integration: integrationSummary("stripe"), prices: selected },
          requestId,
        );
      }
      if (
        url.pathname === "/api/platform/integrations/stripe/test-checkout" &&
        req.method === "POST"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          settings = stripeSettings(),
          client = stripeClient(settings),
          plan = String(body.plan || "starter"),
          price = settings.prices?.[plan],
          customerEmail = limited(body.customerEmail, 180).toLowerCase();
        if (settings.mode !== "test")
          throw Object.assign(
            new Error(
              "Sandbox Checkout is available only with a Stripe test key.",
            ),
            { status: 409, code: "STRIPE_TEST_MODE_REQUIRED" },
          );
        if (!client || !price || !validEmail(customerEmail))
          throw Object.assign(
            new Error("Choose a mapped plan and enter a test customer email."),
            { status: 400, code: "STRIPE_TEST_CHECKOUT_INVALID" },
          );
        const checkout = await stripeRequest(
          () =>
            client.checkout.sessions.create({
              mode: "subscription",
              customer_email: customerEmail,
              line_items: [{ price, quantity: 1 }],
              success_url: `${applicationPublicBase(req)}/platform.html?billing=test-success`,
              cancel_url: `${applicationPublicBase(req)}/platform.html?billing=test-canceled`,
              metadata: { setup_test: "true", plan },
              subscription_data: {
                metadata: { setup_test: "true", plan },
              },
            }),
          "Stripe could not create the sandbox Checkout session.",
        );
        recordApplicationAudit(
          owner,
          "stripe.test_checkout_created",
          "application_integration",
          "stripe",
          null,
          limited(body.reason || "Stripe sandbox Checkout test", 500),
          { plan, checkoutSessionId: checkout.id },
          requestId,
        );
        return json(res, 201, { url: checkout.url }, requestId);
      }
      if (
        url.pathname === "/api/platform/integrations/stripe" &&
        req.method === "DELETE"
      ) {
        const body = await readJsonBody(req, { limit: 8192 }),
          reason = limited(body.reason, 500),
          settings = stripeSettings(),
          configuration = safeJson(
            integrationRow("stripe")?.configuration_json,
          ),
          client = stripeClient(settings);
        if (reason.length < 3)
          throw Object.assign(new Error("A reason is required."), {
            status: 400,
            code: "REASON_REQUIRED",
          });
        if (client && configuration.webhookEndpointId)
          try {
            await client.webhookEndpoints.del(configuration.webhookEndpointId);
          } catch (cause) {
            throw Object.assign(
              new Error(
                "Stripe webhook revocation failed; the integration was not disconnected.",
              ),
              { status: 502, code: "STRIPE_DISCONNECT_FAILED", cause },
            );
          }
        db.prepare(
          "DELETE FROM application_integrations WHERE provider='stripe'",
        ).run();
        recordApplicationAudit(
          owner,
          "stripe.disconnected",
          "application_integration",
          "stripe",
          null,
          reason,
          {},
          requestId,
        );
        return json(res, 200, { disconnected: true }, requestId);
      }
      if (
        url.pathname === "/api/platform/organizations" &&
        req.method === "GET"
      ) {
        const search = limited(url.searchParams.get("search"), 120),
          status = String(url.searchParams.get("status") || ""),
          page = Math.max(1, Number(url.searchParams.get("page")) || 1),
          pageSize = Math.min(
            100,
            Math.max(1, Number(url.searchParams.get("pageSize")) || 25),
          ),
          where = ["1=1"],
          params = [];
        if (search) {
          where.push(
            "(lower(o.name) LIKE lower(?) OR lower(o.slug) LIKE lower(?))",
          );
          params.push(`%${search}%`, `%${search}%`);
        }
        if (["active", "suspended"].includes(status)) {
          where.push("o.status=?");
          params.push(status);
        }
        const filter = where.join(" AND "),
          total = db
            .prepare(
              `SELECT COUNT(*) count FROM organizations o WHERE ${filter}`,
            )
            .get(...params).count,
          rows = db
            .prepare(
              `SELECT o.*,s.plan,s.status subscription_status,s.seats,s.trial_ends_at,s.current_period_end,s.stripe_customer_id,s.stripe_subscription_id,mc.tenant_id microsoft_tenant_id,mc.tenant_name microsoft_tenant_name,mc.status microsoft_status,mc.sender_email,(SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id=o.id AND m.status='active') member_count FROM organizations o LEFT JOIN organization_subscriptions s ON s.organization_id=o.id LEFT JOIN organization_microsoft_connections mc ON mc.organization_id=o.id WHERE ${filter} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
            )
            .all(...params, pageSize, (page - 1) * pageSize);
        return json(
          res,
          200,
          {
            organizations: rows.map((row) => ({
              ...workspaceDto(row),
              memberCount: row.member_count,
              subscription: {
                plan: row.plan,
                status: row.subscription_status,
                seats: row.seats,
                trialEndsAt: row.trial_ends_at,
                currentPeriodEnd: row.current_period_end,
                stripeCustomerId: row.stripe_customer_id || null,
                stripeSubscriptionId: row.stripe_subscription_id || null,
              },
              microsoft: row.microsoft_tenant_id
                ? {
                    tenantId: row.microsoft_tenant_id,
                    tenantName: row.microsoft_tenant_name,
                    status: row.microsoft_status,
                    senderEmail: row.sender_email,
                  }
                : null,
            })),
            pagination: {
              page,
              pageSize,
              total,
              pages: Math.max(1, Math.ceil(total / pageSize)),
            },
          },
          requestId,
        );
      }
      if (
        url.pathname === "/api/platform/organizations" &&
        req.method === "POST"
      ) {
        const body = await readJsonBody(req, { limit: 16384 }),
          name = limited(body.name, 180).trim(),
          adminEmail = limited(body.adminEmail, 180).trim().toLowerCase(),
          plan = ["starter", "team", "business"].includes(body.plan)
            ? body.plan
            : "starter",
          seats = Math.min(
            10000,
            Math.max(1, Number(body.seats) || seatsForPlan(plan)),
          );
        if (name.length < 2 || !validEmail(adminEmail))
          return json(
            res,
            400,
            {
              error: {
                code: "TENANT_INVALID",
                message: "Enter a tenant name and valid administrator email.",
              },
            },
            requestId,
          );
        const organizationId = randomUUID(),
          invitationId = randomUUID(),
          invitationToken = randomBytes(32).toString("base64url"),
          organizationSlug = `${slug(name)}-${organizationId.slice(0, 8)}`,
          expires = new Date(Date.now() + 7 * 86400000).toISOString(),
          settings = {
            publicUrl: signature.publicUrl || "",
            assetBaseUrl: signature.assetBaseUrl || signature.publicUrl || "",
            mediaBaseUrl: signature.mediaBaseUrl || signature.publicUrl || "",
            sessionHours: signature.sessionHours || 12,
            requireApproval: false,
            brand: {
              locked: false,
              accent: "#2563eb",
              font: "system",
              companyName: name,
              logoUrl: "",
            },
          };
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "INSERT INTO organizations(id,name,slug,status,settings_json) VALUES (?,?,?,'active',?)",
          ).run(
            organizationId,
            name,
            organizationSlug,
            JSON.stringify(settings),
          );
          db.prepare(
            "INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES (?,?,'trialing',?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))",
          ).run(organizationId, plan, seats);
          db.prepare(
            "INSERT INTO organization_invitations(id,organization_id,email,role,token_hash,invited_by,expires_at) VALUES (?,?,?,'admin',?,?,?)",
          ).run(
            invitationId,
            organizationId,
            adminEmail,
            tokenHash(invitationToken),
            owner.id,
            expires,
          );
          recordApplicationAudit(
            owner,
            "tenant.created",
            "organization",
            organizationId,
            organizationId,
            limited(body.reason || "New customer onboarding", 500),
            { name, adminEmail, plan, seats },
            requestId,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json(
          res,
          201,
          {
            organization: {
              id: organizationId,
              name,
              slug: organizationSlug,
              status: "active",
            },
            adminEmail,
            invitationUrl: `${cleanUrl(signature.publicUrl || requestBase(req))}/signature.html?invite=${encodeURIComponent(invitationToken)}`,
            invitationExpiresAt: expires,
          },
          requestId,
        );
      }
      const organizationMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)$/,
      );
      if (organizationMatch && req.method === "GET") {
        const organizationId = organizationMatch[1],
          organization = db
            .prepare("SELECT * FROM organizations WHERE id=?")
            .get(organizationId);
        if (!organization)
          return json(
            res,
            404,
            { error: { code: "NOT_FOUND", message: "Tenant not found." } },
            requestId,
          );
        const members = db
            .prepare(
              `SELECT u.id,u.email,u.display_name,m.role,m.status,m.created_at FROM organization_memberships m JOIN signature_users u ON u.id=m.user_id WHERE m.organization_id=? ORDER BY m.role,u.display_name`,
            )
            .all(organizationId),
          subscription = db
            .prepare(
              "SELECT * FROM organization_subscriptions WHERE organization_id=?",
            )
            .get(organizationId),
          microsoft = microsoftConnection(organizationId),
          audit = db
            .prepare(
              `SELECT a.*,u.display_name actor_name FROM application_audit_logs a LEFT JOIN signature_users u ON u.id=a.actor_user_id WHERE a.organization_id=? ORDER BY a.created_at DESC LIMIT 50`,
            )
            .all(organizationId);
        return json(
          res,
          200,
          {
            organization: workspaceDto(organization),
            members: members.map((member) => ({
              id: member.id,
              email: member.email,
              displayName: member.display_name,
              role: member.role,
              status: member.status,
              createdAt: member.created_at,
            })),
            subscription: subscription
              ? {
                  ...subscriptionDto(subscription, true),
                }
              : null,
            microsoft: microsoftConnectionDto(microsoft),
            audit: audit.map(auditDto),
          },
          requestId,
        );
      }
      const statusMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)\/status$/,
      );
      if (statusMatch && req.method === "PUT") {
        const body = await readJsonBody(req, { limit: 8192 }),
          status = String(body.status || ""),
          reason = limited(body.reason, 500).trim();
        if (!["active", "suspended"].includes(status) || reason.length < 3)
          return json(
            res,
            400,
            {
              error: {
                code: "TENANT_STATUS_INVALID",
                message: "Choose a valid status and provide a reason.",
              },
            },
            requestId,
          );
        const changed = db
          .prepare(
            `UPDATE organizations SET status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? RETURNING id,name,status`,
          )
          .get(status, statusMatch[1]);
        if (!changed)
          return json(
            res,
            404,
            { error: { code: "NOT_FOUND", message: "Tenant not found." } },
            requestId,
          );
        if (status === "suspended")
          db.prepare(
            "DELETE FROM signature_sessions WHERE organization_id=? AND user_id NOT IN (SELECT user_id FROM application_owners WHERE status='active')",
          ).run(changed.id);
        recordApplicationAudit(
          owner,
          `tenant.${status}`,
          "organization",
          changed.id,
          changed.id,
          reason,
          {},
          requestId,
        );
        return json(res, 200, { organization: changed }, requestId);
      }
      const subscriptionMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)\/subscription$/,
      );
      if (subscriptionMatch && req.method === "PUT") {
        const body = await readJsonBody(req, { limit: 8192 }),
          plan = String(body.plan || ""),
          status = String(body.status || ""),
          seats = Number(body.seats),
          reason = limited(body.reason, 500).trim();
        if (
          !["starter", "team", "business"].includes(plan) ||
          !["trialing", "active", "past_due", "canceled"].includes(status) ||
          !Number.isInteger(seats) ||
          seats < 1 ||
          seats > 10000 ||
          reason.length < 3
        )
          return json(
            res,
            400,
            {
              error: {
                code: "SUBSCRIPTION_INVALID",
                message: "Choose a valid plan, status, seat count, and reason.",
              },
            },
            requestId,
          );
        const subscription = db
          .prepare(
            `UPDATE organization_subscriptions SET plan=?,status=?,seats=?,stripe_customer_id=?,stripe_subscription_id=?,stripe_price_id=?,current_period_end=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? RETURNING *`,
          )
          .get(
            plan,
            status,
            seats,
            limited(body.stripeCustomerId, 255) || null,
            limited(body.stripeSubscriptionId, 255) || null,
            limited(body.stripePriceId, 255) || null,
            body.currentPeriodEnd || null,
            subscriptionMatch[1],
          );
        if (!subscription)
          return json(
            res,
            404,
            { error: { code: "NOT_FOUND", message: "Tenant not found." } },
            requestId,
          );
        recordApplicationAudit(
          owner,
          "subscription.updated",
          "organization_subscription",
          subscriptionMatch[1],
          subscriptionMatch[1],
          reason,
          { plan, status, seats },
          requestId,
        );
        return json(
          res,
          200,
          { subscription: subscriptionDto(subscription) },
          requestId,
        );
      }
      const checkoutMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)\/billing\/checkout$/,
      );
      if (checkoutMatch && req.method === "POST") {
        if (!billingAvailable())
          return json(
            res,
            503,
            {
              error: {
                code: "STRIPE_NOT_CONFIGURED",
                message: "Stripe is not configured.",
              },
            },
            requestId,
          );
        const stripeConfiguration = stripeSettings(),
          stripe = stripeClient(stripeConfiguration),
          body = await readJsonBody(req, { limit: 8192 }),
          plan = String(body.plan || "starter"),
          price = stripeConfiguration.prices?.[plan],
          customerEmail = limited(body.customerEmail, 180).toLowerCase(),
          subscription = db
            .prepare(
              "SELECT * FROM organization_subscriptions WHERE organization_id=?",
            )
            .get(checkoutMatch[1]);
        if (
          !price ||
          !subscription ||
          (!subscription.stripe_customer_id && !validEmail(customerEmail))
        )
          return json(
            res,
            400,
            {
              error: {
                code: "CHECKOUT_INVALID",
                message: "Choose an available plan and customer email.",
              },
            },
            requestId,
          );
        const base = cleanUrl(signature.publicUrl || requestBase(req)),
          checkout = await stripeRequest(
            () =>
              stripe.checkout.sessions.create({
                mode: "subscription",
                client_reference_id: checkoutMatch[1],
                ...(subscription.stripe_customer_id
                  ? { customer: subscription.stripe_customer_id }
                  : { customer_email: customerEmail }),
                line_items: [{ price, quantity: 1 }],
                allow_promotion_codes: true,
                success_url: `${base}/platform.html?billing=success`,
                cancel_url: `${base}/platform.html?billing=canceled`,
                metadata: { organization_id: checkoutMatch[1], plan },
                subscription_data: {
                  metadata: { organization_id: checkoutMatch[1], plan },
                },
              }),
            "Stripe could not create the tenant Checkout session.",
          );
        recordApplicationAudit(
          owner,
          "stripe.checkout_created",
          "organization_subscription",
          checkoutMatch[1],
          checkoutMatch[1],
          limited(body.reason || "Subscription checkout", 500),
          { plan },
          requestId,
        );
        return json(res, 201, { url: checkout.url }, requestId);
      }
      const portalMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)\/billing\/portal$/,
      );
      if (portalMatch && req.method === "POST") {
        const settings = stripeSettings(),
          stripe = stripeClient(settings),
          subscription = db
            .prepare(
              "SELECT * FROM organization_subscriptions WHERE organization_id=?",
            )
            .get(portalMatch[1]);
        if (!stripe || !subscription?.stripe_customer_id)
          throw Object.assign(
            new Error("This tenant does not have a Stripe customer yet."),
            { status: 409, code: "STRIPE_CUSTOMER_REQUIRED" },
          );
        const session = await stripeRequest(
          () =>
            stripe.billingPortal.sessions.create({
              customer: subscription.stripe_customer_id,
              return_url: `${applicationPublicBase(req)}/platform.html`,
            }),
          "Stripe could not create the billing portal session.",
        );
        recordApplicationAudit(
          owner,
          "stripe.portal_created",
          "organization_subscription",
          portalMatch[1],
          portalMatch[1],
          "Open Stripe billing portal",
          {},
          requestId,
        );
        return json(res, 201, { url: session.url }, requestId);
      }
      const stripeSubscriptionMatch = url.pathname.match(
        /^\/api\/platform\/organizations\/([^/]+)\/billing\/subscription$/,
      );
      if (stripeSubscriptionMatch && req.method === "PUT") {
        const body = await readJsonBody(req, { limit: 8192 }),
          action = String(body.action || ""),
          reason = limited(body.reason, 500),
          settings = stripeSettings(),
          stripe = stripeClient(settings),
          subscription = db
            .prepare(
              "SELECT * FROM organization_subscriptions WHERE organization_id=?",
            )
            .get(stripeSubscriptionMatch[1]);
        if (reason.length < 3)
          throw Object.assign(new Error("A reason is required."), {
            status: 400,
            code: "REASON_REQUIRED",
          });
        if (!stripe || !subscription?.stripe_subscription_id)
          throw Object.assign(
            new Error("This tenant does not have a Stripe subscription yet."),
            { status: 409, code: "STRIPE_SUBSCRIPTION_REQUIRED" },
          );
        let updated;
        if (action === "change_plan") {
          const plan = String(body.plan || ""),
            price = settings.prices?.[plan];
          if (!price)
            throw Object.assign(new Error("Choose a mapped Stripe plan."), {
              status: 400,
              code: "STRIPE_PLAN_INVALID",
            });
          const current = await stripeRequest(
            () =>
              stripe.subscriptions.retrieve(
                subscription.stripe_subscription_id,
              ),
            "Stripe could not load the subscription.",
          );
          const item = current.items?.data?.[0];
          if (!item?.id)
            throw Object.assign(
              new Error("Stripe subscription has no billable item."),
              { status: 409, code: "STRIPE_ITEM_REQUIRED" },
            );
          updated = await stripeRequest(
            () =>
              stripe.subscriptions.update(current.id, {
                items: [{ id: item.id, price }],
                proration_behavior: "create_prorations",
                metadata: {
                  ...(current.metadata || {}),
                  organization_id: stripeSubscriptionMatch[1],
                  plan,
                },
              }),
            "Stripe could not change the subscription plan.",
          );
        } else if (["cancel", "reactivate"].includes(action)) {
          updated = await stripeRequest(
            () =>
              stripe.subscriptions.update(subscription.stripe_subscription_id, {
                cancel_at_period_end: action === "cancel",
              }),
            "Stripe could not update the cancellation setting.",
          );
        } else
          throw Object.assign(new Error("Choose a billing action."), {
            status: 400,
            code: "STRIPE_ACTION_INVALID",
          });
        recordApplicationAudit(
          owner,
          `stripe.subscription_${action}`,
          "organization_subscription",
          stripeSubscriptionMatch[1],
          stripeSubscriptionMatch[1],
          reason,
          { stripeSubscriptionId: updated.id, plan: body.plan || null },
          requestId,
        );
        return json(
          res,
          202,
          {
            accepted: true,
            stripeSubscriptionId: updated.id,
            cancelAtPeriodEnd: Boolean(updated.cancel_at_period_end),
          },
          requestId,
        );
      }
      if (url.pathname === "/api/platform/owners" && req.method === "GET") {
        const owners = db
          .prepare(
            `SELECT u.id,u.email,u.display_name,a.status,a.created_at FROM application_owners a JOIN signature_users u ON u.id=a.user_id ORDER BY u.display_name`,
          )
          .all();
        return json(
          res,
          200,
          {
            owners: owners.map((item) => ({
              id: item.id,
              email: item.email,
              displayName: item.display_name,
              status: item.status,
              createdAt: item.created_at,
            })),
          },
          requestId,
        );
      }
      if (url.pathname === "/api/platform/owners" && req.method === "POST") {
        const body = await readJsonBody(req, { limit: 8192 }),
          email = limited(body.email, 180).trim().toLowerCase(),
          account = db
            .prepare(
              "SELECT id,email,display_name FROM signature_users WHERE lower(email)=lower(?)",
            )
            .get(email);
        if (!account)
          return json(
            res,
            404,
            {
              error: {
                code: "ACCOUNT_NOT_FOUND",
                message:
                  "The account must exist before it can become an Application Owner.",
              },
            },
            requestId,
          );
        db.prepare(
          `INSERT INTO application_owners(user_id,status,granted_by) VALUES (?,'active',?) ON CONFLICT(user_id) DO UPDATE SET status='active',granted_by=excluded.granted_by,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(account.id, owner.id);
        recordApplicationAudit(
          owner,
          "application_owner.granted",
          "user",
          account.id,
          null,
          limited(body.reason || "Application Owner access granted", 500),
          { email: account.email },
          requestId,
        );
        return json(res, 201, { owner: account }, requestId);
      }
      const ownerMatch = url.pathname.match(
        /^\/api\/platform\/owners\/([^/]+)$/,
      );
      if (ownerMatch && req.method === "DELETE") {
        const body = await readJsonBody(req, { limit: 8192 }),
          reason = limited(body.reason, 500).trim(),
          activeOwners = db
            .prepare(
              "SELECT COUNT(*) count FROM application_owners WHERE status='active'",
            )
            .get().count;
        if (
          ownerMatch[1] === owner.id ||
          activeOwners <= 1 ||
          reason.length < 3
        )
          return json(
            res,
            409,
            {
              error: {
                code: "APPLICATION_OWNER_REQUIRED",
                message:
                  "You cannot remove yourself or the final Application Owner. A reason is required.",
              },
            },
            requestId,
          );
        const changed = db
          .prepare(
            `UPDATE application_owners SET status='disabled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND status='active' RETURNING user_id`,
          )
          .get(ownerMatch[1]);
        if (!changed)
          return json(
            res,
            404,
            {
              error: {
                code: "NOT_FOUND",
                message: "Application Owner not found.",
              },
            },
            requestId,
          );
        recordApplicationAudit(
          owner,
          "application_owner.revoked",
          "user",
          changed.user_id,
          null,
          reason,
          {},
          requestId,
        );
        return json(res, 200, { ok: true }, requestId);
      }
      if (url.pathname === "/api/platform/audit" && req.method === "GET") {
        const rows = db
          .prepare(
            `SELECT a.*,u.display_name actor_name FROM application_audit_logs a LEFT JOIN signature_users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT 250`,
          )
          .all();
        return json(res, 200, { audit: rows.map(auditDto) }, requestId);
      }
      return json(
        res,
        405,
        {
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." },
        },
        requestId,
      );
    }
    if (!url.pathname.startsWith("/api/signature/")) return false;
    if (url.pathname === "/api/signature/capabilities" && req.method === "GET")
      return json(
        res,
        200,
        {
          registration: signature.allowRegistration,
          microsoft: microsoftAvailable(),
          passwordReset:
            mailAvailable() ||
            Boolean(
              db
                .prepare(
                  "SELECT 1 FROM organization_microsoft_connections WHERE status='connected' AND sender_email<>'' LIMIT 1",
                )
                .get(),
            ) ||
            !production,
        },
        requestId,
      );
    if (url.pathname === "/api/signature/session" && req.method === "GET") {
      try {
        const current = requireSession(req);
        return json(
          res,
          200,
          { user: current, workspaces: userWorkspaces(current.id) },
          requestId,
          refreshCsrf(current),
        );
      } catch {
        return json(res, 200, { user: null }, requestId);
      }
    }
    if (
      url.pathname === "/api/signature/email/verify" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 8192 }),
        row = db
          .prepare(
            `SELECT * FROM email_verification_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .get(tokenHash(String(body.token || "")));
      if (!row)
        return json(
          res,
          400,
          {
            error: {
              code: "TOKEN_INVALID",
              message: "Verification link is invalid or expired.",
            },
          },
          requestId,
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE signature_users SET email_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(row.user_id);
        db.prepare(
          `UPDATE email_verification_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(row.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      url.pathname === "/api/signature/password/forgot" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 8192 }),
        account = db
          .prepare(
            `SELECT * FROM signature_users WHERE lower(email)=lower(?) AND status='active'`,
          )
          .get(
            String(body.email || "")
              .trim()
              .toLowerCase(),
          );
      let developmentToken = null;
      if (account) {
        const token = createOneTimeToken(
            "password_reset_tokens",
            account.id,
            30,
          ),
          link = `${cleanUrl(signature.publicUrl || requestBase(req))}/signature.html?reset=${encodeURIComponent(token)}`;
        const mailOrganizationId = mailOrganizationForUser(account.id);
        if (mailAvailable(mailOrganizationId))
          await sendGraphMail(
            mailOrganizationId,
            account.email,
            "Reset your Signify password",
            `<p>A password reset was requested for your Signify account.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
          );
        else if (mailAvailable())
          await sendGraphMail(
            null,
            account.email,
            "Reset your Signify password",
            `<p>A password reset was requested for your Signify account.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 30 minutes.</p>`,
          );
        else developmentToken = token;
      }
      return json(
        res,
        200,
        {
          ok: true,
          ...(!production && developmentToken ? { developmentToken } : {}),
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/password/reset" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 8192 }),
        password = String(body.password || "");
      if (password.length < 10)
        return json(
          res,
          400,
          {
            error: {
              code: "PASSWORD_WEAK",
              message: "Password must be at least 10 characters.",
            },
          },
          requestId,
        );
      const row = db
        .prepare(
          `SELECT * FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .get(tokenHash(String(body.token || "")));
      if (!row)
        return json(
          res,
          400,
          {
            error: {
              code: "TOKEN_INVALID",
              message: "Reset link is invalid or expired.",
            },
          },
          requestId,
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `UPDATE signature_users SET password_hash=?,email_verified_at=COALESCE(email_verified_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(hashPassword(password), row.user_id);
        db.prepare(
          `UPDATE password_reset_tokens SET used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(row.id);
        db.prepare("DELETE FROM signature_sessions WHERE user_id=?").run(
          row.user_id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      url.pathname === "/api/signature/invitations/accept" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 16384 }),
        password = String(body.password || ""),
        invitation = db
          .prepare(
            `SELECT * FROM organization_invitations WHERE token_hash=? AND accepted_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          )
          .get(tokenHash(String(body.token || "")));
      if (!invitation)
        return json(
          res,
          400,
          {
            error: {
              code: "INVITATION_INVALID",
              message: "Invitation is invalid or expired.",
            },
          },
          requestId,
        );
      if (password.length < 10)
        return json(
          res,
          400,
          {
            error: {
              code: "PASSWORD_WEAK",
              message: "Password must be at least 10 characters.",
            },
          },
          requestId,
        );
      const subscription = db
          .prepare(
            "SELECT * FROM organization_subscriptions WHERE organization_id=?",
          )
          .get(invitation.organization_id),
        activeMembers = db
          .prepare(
            "SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id=? AND status='active'",
          )
          .get(invitation.organization_id).count;
      if (activeMembers >= (subscription?.seats || 1))
        return json(
          res,
          409,
          {
            error: {
              code: "SEAT_LIMIT_REACHED",
              message: "This workspace has no available seats.",
            },
          },
          requestId,
        );
      let account = db
          .prepare("SELECT * FROM signature_users WHERE lower(email)=lower(?)")
          .get(invitation.email),
        userId = account?.id || randomUUID(),
        organization = db
          .prepare("SELECT name FROM organizations WHERE id=?")
          .get(invitation.organization_id),
        displayName = limited(
          account?.display_name || body.name || invitation.email.split("@")[0],
          120,
        ),
        membershipSignature = normalizeSignature(
          {
            display_name: displayName,
            email: invitation.email,
            signature_json: "{}",
          },
          {
            fields: {
              name: displayName,
              email: invitation.email,
              company: organization.name,
            },
          },
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!account) {
          db.prepare(
            `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at) VALUES (?,?,?,?,'editor','active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          ).run(
            userId,
            invitation.email,
            hashPassword(password),
            displayName,
            JSON.stringify(membershipSignature),
          );
        }
        db.prepare(
          `INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,?,'active',?) ON CONFLICT(organization_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        ).run(
          invitation.organization_id,
          userId,
          invitation.role,
          JSON.stringify(membershipSignature),
        );
        db.prepare(
          `UPDATE organization_invitations SET accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(invitation.id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const row = memberById(invitation.organization_id, userId),
        session = createSession(req, row);
      recordAudit(session.user, "invitation.accepted", "user", userId);
      return json(res, 200, { user: session.user }, requestId, session.header);
    }
    if (url.pathname === "/api/signature/register" && req.method === "POST") {
      if (!signature.allowRegistration)
        return json(
          res,
          403,
          {
            error: {
              code: "REGISTRATION_DISABLED",
              message: "Workspace registration is disabled.",
            },
          },
          requestId,
        );
      if (production && !mailAvailable())
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Registration requires email delivery configuration.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req, { limit: 16384 }),
        email = String(body.email || "")
          .trim()
          .toLowerCase(),
        password = String(body.password || ""),
        name = String(body.name || "").trim(),
        company = String(body.company || "").trim();
      if (!name || !company)
        return json(
          res,
          400,
          {
            error: {
              code: "REGISTRATION_FIELDS_REQUIRED",
              message: "Enter your name and company.",
            },
          },
          requestId,
        );
      if (!validEmail(email))
        return json(
          res,
          400,
          {
            error: {
              code: "EMAIL_INVALID",
              message: "Enter a valid work email.",
            },
          },
          requestId,
        );
      if (password.length < 10)
        return json(
          res,
          400,
          {
            error: {
              code: "PASSWORD_WEAK",
              message: "Password must be at least 10 characters.",
            },
          },
          requestId,
        );
      const existingAccount = db
        .prepare("SELECT * FROM signature_users WHERE lower(email)=lower(?)")
        .get(email);
      if (existingAccount) {
        if (
          !existingAccount.email_verified_at &&
          verifyPassword(password, existingAccount.password_hash)
        ) {
          const verificationToken = createOneTimeToken(
              "email_verification_tokens",
              existingAccount.id,
              24 * 60,
            ),
            link = `${cleanUrl(signature.publicUrl || requestBase(req))}/signature.html?verify=${encodeURIComponent(verificationToken)}`;
          const mailOrganizationId = mailOrganizationForUser(
            existingAccount.id,
          );
          if (mailAvailable(mailOrganizationId))
            await sendGraphMail(
              mailOrganizationId,
              email,
              "Verify your Signify email",
              `<p>Verify your email to activate your Signify workspace.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
            );
          return json(
            res,
            200,
            {
              requiresVerification: true,
              resent: true,
              ...(!production ? { developmentToken: verificationToken } : {}),
            },
            requestId,
          );
        }
        return json(
          res,
          409,
          {
            error: {
              code: "EMAIL_EXISTS",
              message: "An account with that email already exists.",
            },
          },
          requestId,
        );
      }
      const orgId = randomUUID(),
        userId = randomUUID(),
        baseSlug = `${slug(company)}-${randomBytes(3).toString("hex")}`,
        settings = {
          publicUrl: signature.publicUrl,
          assetBaseUrl: signature.assetBaseUrl,
          mediaBaseUrl: signature.mediaBaseUrl,
          sessionHours: signature.sessionHours,
          requireApproval: false,
          brand: {
            locked: false,
            accent: "#2563eb",
            font: "system",
            companyName: company,
            logoUrl: "",
          },
        };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "INSERT INTO organizations(id,name,slug,settings_json) VALUES (?,?,?,?)",
        ).run(orgId, company, baseSlug, JSON.stringify(settings));
        db.prepare(
          `INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES (?,'starter','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))`,
        ).run(orgId);
        const sig = normalizeSignature(
          { display_name: name, email, signature_json: "{}" },
          { fields: { name, email, company } },
        );
        db.prepare(
          "INSERT INTO signature_users(id,email,password_hash,display_name,role,signature_json) VALUES (?,?,?,?,?,?)",
        ).run(
          userId,
          email,
          hashPassword(password),
          name,
          "admin",
          JSON.stringify(sig),
        );
        db.prepare(
          `INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,'admin','active',?)`,
        ).run(orgId, userId, JSON.stringify(sig));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const row = memberById(orgId, userId),
        created = userDto(row),
        verificationToken = createOneTimeToken(
          "email_verification_tokens",
          userId,
          24 * 60,
        ),
        link = `${cleanUrl(signature.publicUrl || requestBase(req))}/signature.html?verify=${encodeURIComponent(verificationToken)}`;
      recordAudit(created, "workspace.created", "organization", orgId, {
        name: company,
      });
      if (mailAvailable())
        await sendGraphMail(
          null,
          email,
          "Verify your Signify email",
          `<p>Verify your email to activate your Signify workspace.</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
        );
      return json(
        res,
        201,
        {
          requiresVerification: true,
          ...(!production ? { developmentToken: verificationToken } : {}),
        },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/login" && req.method === "POST") {
      const body = await readJsonBody(req, { limit: 8192 }),
        email = String(body.email || "")
          .trim()
          .toLowerCase();
      let row = db
        .prepare(
          `${memberSelect} WHERE lower(u.email)=lower(?) AND u.status='active' AND m.status='active' AND o.status='active' ORDER BY m.created_at LIMIT 1`,
        )
        .get(email);
      if (!row)
        row = db
          .prepare(
            `${memberSelect} JOIN application_owners ao ON ao.user_id=u.id AND ao.status='active' WHERE lower(u.email)=lower(?) AND u.status='active' ORDER BY m.created_at LIMIT 1`,
          )
          .get(email);
      if (!row)
        row = db
          .prepare(
            `SELECT u.id,u.email,u.password_hash,u.display_name,u.role,u.status,u.created_at,u.updated_at,u.last_login_at,u.email_verified_at,u.signature_json,NULL AS membership_role,NULL AS membership_status,NULL AS organization_id,'' AS organization_name,'' AS organization_slug,'active' AS organization_status,'{}' AS organization_settings FROM signature_users u JOIN application_owners ao ON ao.user_id=u.id AND ao.status='active' WHERE lower(u.email)=lower(?) AND u.status='active' LIMIT 1`,
          )
          .get(email);
      if (!row || !verifyPassword(body.password, row.password_hash))
        return json(
          res,
          401,
          {
            error: {
              code: "INVALID_LOGIN",
              message: "Invalid email or password.",
            },
          },
          requestId,
        );
      if (!row.email_verified_at)
        return json(
          res,
          403,
          {
            error: {
              code: "EMAIL_NOT_VERIFIED",
              message: "Verify your email before signing in.",
            },
          },
          requestId,
        );
      const session = createSession(req, row);
      if (session.user.organizationId)
        recordAudit(session.user, "session.login", "user", session.user.id);
      else
        recordApplicationAudit(
          session.user,
          "session.login",
          "user",
          session.user.id,
          null,
          "Application Owner login",
          {},
          requestId,
        );
      return json(res, 200, { user: session.user }, requestId, session.header);
    }
    if (url.pathname === "/api/signature/logout" && req.method === "POST") {
      let current = null;
      try {
        current = requireSession(req);
        enforceCsrf(req, current);
      } catch (error) {
        if (error.code !== "AUTH_REQUIRED" && error.code !== "SESSION_EXPIRED")
          throw error;
      }
      const token = cookie(req, "sig_session");
      if (token)
        db.prepare("DELETE FROM signature_sessions WHERE token_hash=?").run(
          tokenHash(token),
        );
      return json(res, 200, { ok: true }, requestId, {
        "Set-Cookie": [
          sessionCookie("", 0, production),
          csrfCookie("", 0, production),
        ],
      });
    }
    const user = requireSession(req);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method))
      enforceCsrf(req, user);
    const jobMatch = url.pathname.match(/^\/api\/signature\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === "GET") {
      requireAdmin(user);
      const row = db
        .prepare(
          `SELECT id,type,status,attempts,max_attempts,result_json,last_error,created_at,updated_at,completed_at,dead_lettered_at
           FROM background_jobs
           WHERE id=? AND organization_id=? AND type IN ('directory.sync','signature.rollout')`,
        )
        .get(decodeURIComponent(jobMatch[1]), user.organizationId);
      if (!row)
        return json(
          res,
          404,
          { error: { code: "JOB_NOT_FOUND", message: "Job not found." } },
          requestId,
        );
      return json(
        res,
        200,
        {
          job: {
            id: row.id,
            type: row.type,
            status: row.status,
            attempts: row.attempts,
            maxAttempts: row.max_attempts,
            result: safeJson(row.result_json),
            error: row.last_error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            completedAt: row.completed_at,
            deadLetteredAt: row.dead_lettered_at,
          },
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/session/switch" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 8192 }),
        target = memberById(String(body.organizationId || ""), user.id);
      if (
        !target ||
        target.membership_status !== "active" ||
        target.status !== "active" ||
        target.organization_status !== "active"
      )
        return json(
          res,
          404,
          {
            error: {
              code: "WORKSPACE_NOT_FOUND",
              message: "Workspace membership not found.",
            },
          },
          requestId,
        );
      db.prepare(
        "UPDATE signature_sessions SET organization_id=? WHERE id=?",
      ).run(target.organization_id, user.sessionId);
      const switched = userDto(target);
      recordAudit(
        switched,
        "session.workspace_switched",
        "organization",
        target.organization_id,
      );
      return json(
        res,
        200,
        { user: switched, workspaces: userWorkspaces(user.id) },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/runtime-config" &&
      req.method === "GET"
    ) {
      const organization = workspaceDto(workspaceRow(user)),
        settings = organization.settings,
        subscription = subscriptionDto(
          db
            .prepare(
              "SELECT * FROM organization_subscriptions WHERE organization_id=?",
            )
            .get(user.organizationId),
        );
      return json(
        res,
        200,
        {
          companyName: organization.name,
          publicUrl:
            settings.publicUrl || signature.publicUrl || requestBase(req),
          assetBaseUrl:
            settings.assetBaseUrl ||
            settings.publicUrl ||
            signature.assetBaseUrl ||
            requestBase(req),
          mediaBaseUrl:
            settings.mediaBaseUrl ||
            settings.publicUrl ||
            signature.mediaBaseUrl ||
            requestBase(req),
          organization,
          subscription,
          capabilities: {
            microsoft: microsoftAvailable(),
            directorySync: Boolean(
              microsoftAvailable() &&
              microsoftConnection(user.organizationId, true),
            ),
            mail: mailAvailable(user.organizationId),
          },
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/microsoft-connection" &&
      req.method === "PUT"
    ) {
      requireAdmin(user);
      const body = await readJsonBody(req, { limit: 8192 }),
        senderEmail = limited(body.senderEmail, 180).trim().toLowerCase(),
        connection = microsoftConnection(user.organizationId, true);
      if (!connection)
        return json(
          res,
          409,
          {
            error: {
              code: "MICROSOFT_TENANT_NOT_CONNECTED",
              message:
                "Connect Microsoft 365 before choosing a sender mailbox.",
            },
          },
          requestId,
        );
      if (!validEmail(senderEmail))
        return json(
          res,
          400,
          {
            error: {
              code: "MICROSOFT_SENDER_INVALID",
              message: "Enter a valid Microsoft 365 sender email.",
            },
          },
          requestId,
        );
      const { token } = await graphAppToken(user.organizationId),
        response = await fetchWithRetry(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}?$select=id,mail,userPrincipalName`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
      if (!response.ok)
        return json(
          res,
          400,
          {
            error: {
              code: "MICROSOFT_SENDER_NOT_FOUND",
              message: "Microsoft Graph could not access that sender mailbox.",
            },
          },
          requestId,
        );
      db.prepare(
        `UPDATE organization_microsoft_connections SET sender_email=?,last_verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_error='',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=?`,
      ).run(senderEmail, user.organizationId);
      recordAudit(
        user,
        "microsoft.sender_updated",
        "microsoft_tenant",
        connection.tenant_id,
        { senderEmail },
      );
      return json(
        res,
        200,
        {
          microsoft: microsoftConnectionDto(
            microsoftConnection(user.organizationId),
          ),
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/microsoft-connection" &&
      req.method === "DELETE"
    ) {
      requireAdmin(user);
      const body = await readJsonBody(req, { limit: 8192 }),
        reason = limited(body.reason, 500).trim(),
        connection = microsoftConnection(user.organizationId);
      if (!connection)
        return json(
          res,
          404,
          {
            error: {
              code: "NOT_FOUND",
              message: "Microsoft 365 is not connected.",
            },
          },
          requestId,
        );
      if (reason.length < 3)
        return json(
          res,
          400,
          {
            error: {
              code: "REASON_REQUIRED",
              message: "Provide a reason for disconnecting Microsoft 365.",
            },
          },
          requestId,
        );
      db.prepare(
        "DELETE FROM organization_microsoft_connections WHERE organization_id=?",
      ).run(user.organizationId);
      recordAudit(
        user,
        "microsoft.disconnected",
        "microsoft_tenant",
        connection.tenant_id,
        { reason },
      );
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      url.pathname !== "/api/signature/admin-config"
    )
      requireSubscription(user);
    if (
      url.pathname === "/api/signature/invitations" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      if (production && !mailAvailable(user.organizationId))
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Email delivery is required for invitations.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req, { limit: 8192 }),
        email = limited(body.email, 180).toLowerCase(),
        role = canonicalRole(body.role);
      if (!validEmail(email))
        return json(
          res,
          400,
          {
            error: {
              code: "EMAIL_INVALID",
              message: "Enter a valid work email.",
            },
          },
          requestId,
        );
      if (memberByEmail(user.organizationId, email))
        return json(
          res,
          409,
          {
            error: {
              code: "USER_EXISTS",
              message: "That person is already in this workspace.",
            },
          },
          requestId,
        );
      const token = randomBytes(32).toString("base64url"),
        expires = new Date(Date.now() + 7 * 86400000).toISOString();
      db.prepare(
        `INSERT INTO organization_invitations(id,organization_id,email,role,token_hash,invited_by,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(organization_id,email) DO UPDATE SET role=excluded.role,token_hash=excluded.token_hash,invited_by=excluded.invited_by,expires_at=excluded.expires_at,accepted_at=NULL,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      ).run(
        randomUUID(),
        user.organizationId,
        email,
        role,
        tokenHash(token),
        user.id,
        expires,
      );
      const link = `${publicBase(req, user)}/signature.html?invite=${encodeURIComponent(token)}`;
      if (mailAvailable(user.organizationId))
        await sendGraphMail(
          user.organizationId,
          email,
          `Join ${workspaceRow(user).name} on Signify`,
          `<p>You were invited to manage your email signature in ${workspaceRow(user).name}.</p><p><a href="${link}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
        );
      recordAudit(user, "invitation.sent", "invitation", email, { role });
      return json(
        res,
        201,
        { ok: true, ...(!production ? { developmentToken: token } : {}) },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/upload" && req.method === "POST") {
      requireEditor(user);
      const body = await readJsonBody(req, { limit: 6 * 1024 * 1024 }),
        match = String(body.dataUrl || "").match(
          /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/,
        );
      if (!match)
        return json(
          res,
          400,
          {
            error: {
              code: "IMAGE_REQUIRED",
              message: "Choose a PNG, JPEG, GIF, or WebP image.",
            },
          },
          requestId,
        );
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > 4 * 1024 * 1024)
        return json(
          res,
          413,
          {
            error: {
              code: "IMAGE_TOO_LARGE",
              message: "Image must be 4 MB or smaller.",
            },
          },
          requestId,
        );
      const detected = imageFormat(bytes);
      if (!detected || detected !== match[1])
        return json(
          res,
          400,
          {
            error: {
              code: "IMAGE_CONTENT_INVALID",
              message: "Image content does not match its declared format.",
            },
          },
          requestId,
        );
      let processed;
      try {
        processed = await normalizeUploadedImage(
          bytes,
          body.kind || "image",
          detected,
        );
      } catch {
        return json(
          res,
          400,
          {
            error: {
              code: "IMAGE_PROCESSING_FAILED",
              message: "The image could not be decoded or resized.",
            },
          },
          requestId,
        );
      }
      const ext = processed.format === "jpeg" ? "jpg" : processed.format,
        name = `${slug(body.kind || "image")}-${randomUUID()}.${ext}`,
        stored = await (mediaStorage
          ? mediaStorage.write({
              organizationId: user.organizationId,
              collection: "uploads",
              name,
              bytes: processed.bytes,
              limitBytes: signature.mediaLimitBytes || 250 * 1024 * 1024,
            })
          : writeTenantMedia({
              publicRoot,
              organizationId: user.organizationId,
              collection: "uploads",
              name,
              bytes: processed.bytes,
              limitBytes: signature.mediaLimitBytes || 250 * 1024 * 1024,
            }));
      recordAudit(user, "asset.uploaded", "asset", name, {
        kind: limited(body.kind || "image", 40),
        sourceBytes: bytes.length,
        storedBytes: processed.bytes.length,
        usageBytes: stored.usageBytes,
      });
      return json(res, 201, stored, requestId);
    }
    if (
      url.pathname === "/api/signature/generated-banners" &&
      req.method === "POST"
    ) {
      requireEditor(user);
      const body = await readJsonBody(req, { limit: 12 * 1024 * 1024 });
      if (
        !Array.isArray(body.frames) ||
        body.frames.length < 1 ||
        body.frames.length > 30
      )
        return json(
          res,
          400,
          {
            error: {
              code: "GIF_FRAMES_INVALID",
              message: "Animated banner must include 1 to 30 frames.",
            },
          },
          requestId,
        );
      const width = Math.max(1, Math.min(1200, Number(body.width) || 650)),
        height = Math.max(1, Math.min(400, Number(body.height) || 78)),
        delay = Math.max(40, Math.min(500, Number(body.delay) || 90)),
        frames = body.frames.map((frame) =>
          Buffer.from(String(frame || ""), "base64"),
        );
      if (frames.some((frame) => frame.length !== width * height * 4))
        return json(
          res,
          400,
          {
            error: {
              code: "GIF_FRAME_SIZE_INVALID",
              message: "Animated banner frame data is invalid.",
            },
          },
          requestId,
        );
      const palette = quantize(Buffer.concat(frames), 256, {
          format: "rgb565",
        }),
        gif = GIFEncoder();
      frames.forEach((frame, index) =>
        gif.writeFrame(applyPalette(frame, palette, "rgb565"), width, height, {
          palette: index === 0 ? palette : undefined,
          delay,
          repeat: 0,
        }),
      );
      gif.finish();
      const name = `banner-${randomUUID()}.gif`,
        stored = await (mediaStorage
          ? mediaStorage.write({
              organizationId: user.organizationId,
              collection: "generated-banners",
              name,
              bytes: Buffer.from(gif.bytes()),
              limitBytes: signature.mediaLimitBytes || 250 * 1024 * 1024,
            })
          : writeTenantMedia({
              publicRoot,
              organizationId: user.organizationId,
              collection: "generated-banners",
              name,
              bytes: Buffer.from(gif.bytes()),
              limitBytes: signature.mediaLimitBytes || 250 * 1024 * 1024,
            }));
      recordAudit(user, "asset.generated", "asset", name, {
        kind: "animated-banner",
        frames: frames.length,
        width,
        height,
        storedBytes: stored.storedBytes,
        usageBytes: stored.usageBytes,
      });
      return json(res, 201, stored, requestId);
    }
    if (url.pathname === "/api/signature/preview" && req.method === "POST") {
      const body = await readJsonBody(req, { limit: 65536 }),
        signatureError = signatureInputError(body.signature);
      if (signatureError)
        return json(
          res,
          400,
          {
            error: { code: "SIGNATURE_INVALID", message: signatureError },
          },
          requestId,
        );
      const target = body.userId
        ? user.role === "admin" || body.userId === user.id
          ? memberById(user.organizationId, body.userId)
          : null
        : memberById(user.organizationId, user.id);
      if (!target)
        return json(
          res,
          403,
          {
            error: {
              code: "TARGET_FORBIDDEN",
              message: "You cannot preview that user.",
            },
          },
          requestId,
        );
      return json(
        res,
        200,
        await renderSignature(
          req,
          userDto(target),
          body.signature || normalizeSignature(target),
        ),
        requestId,
      );
    }
    if (url.pathname === "/api/signature/users" && req.method === "GET") {
      const rows =
        user.role === "admin"
          ? db
              .prepare(
                `${memberSelect} WHERE m.organization_id=? ORDER BY u.display_name`,
              )
              .all(user.organizationId)
          : [memberById(user.organizationId, user.id)];
      return json(res, 200, { users: rows.map(userDto) }, requestId);
    }
    if (url.pathname === "/api/signature/users" && req.method === "POST") {
      requireAdmin(user);
      const subscription = db
          .prepare(
            "SELECT * FROM organization_subscriptions WHERE organization_id=?",
          )
          .get(user.organizationId),
        activeMembers = db
          .prepare(
            "SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id=? AND status='active'",
          )
          .get(user.organizationId).count;
      if (activeMembers >= (subscription?.seats || 1))
        return json(
          res,
          409,
          {
            error: {
              code: "SEAT_LIMIT_REACHED",
              message: "Your plan has no available seats.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req),
        email = String(body.email || "")
          .trim()
          .toLowerCase(),
        displayName = String(body.displayName || "").trim(),
        password = String(
          body.password || randomBytes(18).toString("base64url"),
        );
      if (!displayName || !validEmail(email))
        return json(
          res,
          400,
          {
            error: {
              code: "USER_INVALID",
              message: "Enter a name and valid email.",
            },
          },
          requestId,
        );
      if (password.length < 10)
        return json(
          res,
          400,
          {
            error: {
              code: "PASSWORD_WEAK",
              message: "Temporary password must be at least 10 characters.",
            },
          },
          requestId,
        );
      let account = db
          .prepare("SELECT * FROM signature_users WHERE lower(email)=lower(?)")
          .get(email),
        id = account?.id || randomUUID();
      if (memberByEmail(user.organizationId, email))
        return json(
          res,
          409,
          {
            error: {
              code: "USER_EXISTS",
              message: "That user is already in this workspace.",
            },
          },
          requestId,
        );
      const initial = normalizeSignature(
        { display_name: displayName, email, signature_json: "{}" },
        {
          fields: {
            name: displayName,
            email,
            jobTitle: body.jobTitle || "",
            department: body.department || "",
            company: workspaceRow(user).name,
          },
        },
      );
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!account) {
          db.prepare(
            `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at) VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          ).run(
            id,
            email,
            hashPassword(password),
            displayName,
            canonicalRole(body.role),
            canonicalStatus(body.status),
            JSON.stringify(initial),
          );
        }
        db.prepare(
          "INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,?,?,?)",
        ).run(
          user.organizationId,
          id,
          canonicalRole(body.role),
          canonicalStatus(body.status),
          JSON.stringify(initial),
        );
        recordAudit(user, "member.created", "user", id, {
          email,
          role: canonicalRole(body.role),
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(
        res,
        201,
        {
          user: userDto(memberById(user.organizationId, id)),
          temporaryPassword: account ? null : password,
        },
        requestId,
      );
    }
    const userMatch = url.pathname.match(/^\/api\/signature\/users\/([^/]+)$/);
    if (userMatch && req.method === "PUT") {
      const id = decodeURIComponent(userMatch[1]),
        existing = memberById(user.organizationId, id);
      if (!existing)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "User not found." } },
          requestId,
        );
      if (user.id !== id) requireAdmin(user);
      else requireEditor(user);
      const body = await readJsonBody(req),
        isAdmin = user.role === "admin",
        nextRole = isAdmin
          ? canonicalRole(body.role || existing.membership_role)
          : existing.membership_role,
        nextStatus = isAdmin
          ? canonicalStatus(body.status || existing.membership_status)
          : existing.membership_status;
      if (
        user.role === "admin" &&
        id === user.id &&
        (nextRole !== "admin" || nextStatus !== "active")
      )
        return json(
          res,
          400,
          {
            error: {
              code: "CANNOT_DEMOTE_SELF",
              message: "You cannot remove your own administrator access.",
            },
          },
          requestId,
        );
      if (
        body.email &&
        String(body.email).trim().toLowerCase() !== existing.email.toLowerCase()
      )
        return json(
          res,
          400,
          {
            error: {
              code: "EMAIL_CHANGE_UNSUPPORTED",
              message:
                "Login email changes require account verification and are not available here.",
            },
          },
          requestId,
        );
      const nextName =
        body.displayName === undefined ? null : limited(body.displayName, 120);
      if (body.displayName !== undefined && !nextName)
        return json(
          res,
          400,
          {
            error: {
              code: "USER_INVALID",
              message: "Enter a valid display name.",
            },
          },
          requestId,
        );
      if (body.password && (!isAdmin || String(body.password).length < 10))
        return json(
          res,
          isAdmin ? 400 : 403,
          {
            error: {
              code: isAdmin ? "PASSWORD_WEAK" : "ADMIN_REQUIRED",
              message: isAdmin
                ? "Password must be at least 10 characters."
                : "Administrator access required.",
            },
          },
          requestId,
        );
      const signatureError = signatureInputError(body.signature);
      if (signatureError)
        return json(
          res,
          400,
          {
            error: {
              code: "SIGNATURE_INVALID",
              message: signatureError,
            },
          },
          requestId,
        );
      let signaturePatch = body.signature;
      if (signaturePatch && !isAdmin) {
        const requiresApproval = Boolean(
          workspaceSettings(user).requireApproval,
        );
        signaturePatch = {
          ...signaturePatch,
          workflowStatus: requiresApproval ? "draft" : "approved",
          reviewNote: "",
          submittedAt: null,
          approvedAt: requiresApproval ? null : new Date().toISOString(),
          approvedBy: requiresApproval ? null : user.id,
        };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        if (signaturePatch)
          saveSignatureRow(user.organizationId, id, signaturePatch);
        if (nextName)
          db.prepare(
            `UPDATE signature_users SET display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
          ).run(nextName, id);
        if (isAdmin && body.password) {
          db.prepare(
            `UPDATE signature_users SET password_hash=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
          ).run(hashPassword(body.password), id);
          db.prepare("DELETE FROM signature_sessions WHERE user_id=?").run(id);
        }
        db.prepare(
          `UPDATE organization_memberships SET role=?,status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id=? AND user_id=?`,
        ).run(nextRole, nextStatus, user.organizationId, id);
        if (nextStatus === "disabled")
          db.prepare(
            "DELETE FROM signature_sessions WHERE user_id=? AND organization_id=?",
          ).run(id, user.organizationId);
        recordAudit(user, "member.updated", "user", id, {
          role: nextRole,
          status: nextStatus,
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(
        res,
        200,
        { user: userDto(memberById(user.organizationId, id)) },
        requestId,
      );
    }
    if (userMatch && req.method === "DELETE") {
      requireAdmin(user);
      const id = decodeURIComponent(userMatch[1]);
      if (id === user.id)
        return json(
          res,
          400,
          {
            error: {
              code: "CANNOT_DELETE_SELF",
              message: "You cannot remove your own account.",
            },
          },
          requestId,
        );
      if (!memberById(user.organizationId, id))
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "User not found." } },
          requestId,
        );
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "DELETE FROM organization_memberships WHERE organization_id=? AND user_id=?",
        ).run(user.organizationId, id);
        if (
          !db
            .prepare("SELECT 1 FROM organization_memberships WHERE user_id=?")
            .get(id)
        )
          db.prepare("DELETE FROM signature_users WHERE id=?").run(id);
        recordAudit(user, "member.removed", "user", id);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(res, 200, { ok: true }, requestId);
    }
    if (url.pathname === "/api/signature/templates" && req.method === "GET")
      return json(
        res,
        200,
        {
          builtins: builtinTemplates,
          templates: db
            .prepare(
              "SELECT * FROM signature_templates WHERE organization_id=? ORDER BY name",
            )
            .all(user.organizationId)
            .map(templateDto),
        },
        requestId,
      );
    if (url.pathname === "/api/signature/templates" && req.method === "POST") {
      requireEditor(user);
      const body = await readJsonBody(req),
        name = String(body.name || "")
          .trim()
          .slice(0, 80),
        patch = body.patch || body.signature || {},
        signatureError = signatureInputError(patch);
      if (!name)
        return json(
          res,
          400,
          {
            error: {
              code: "TEMPLATE_NAME_REQUIRED",
              message: "Enter a template name.",
            },
          },
          requestId,
        );
      if (signatureError)
        return json(
          res,
          400,
          {
            error: { code: "SIGNATURE_INVALID", message: signatureError },
          },
          requestId,
        );
      const id = randomUUID();
      db.prepare(
        "INSERT INTO signature_templates(id,name,template_json,created_by,organization_id) VALUES (?,?,?,?,?)",
      ).run(id, name, JSON.stringify(patch), user.id, user.organizationId);
      recordAudit(user, "template.created", "template", id, { name });
      return json(
        res,
        201,
        {
          template: templateDto(
            db.prepare("SELECT * FROM signature_templates WHERE id=?").get(id),
          ),
        },
        requestId,
      );
    }
    const templateMatch = url.pathname.match(
      /^\/api\/signature\/templates\/([^/]+)$/,
    );
    if (templateMatch && req.method === "DELETE") {
      requireEditor(user);
      const id = decodeURIComponent(templateMatch[1]),
        existing = db
          .prepare(
            "SELECT * FROM signature_templates WHERE id=? AND organization_id=?",
          )
          .get(id, user.organizationId);
      if (!existing)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "Template not found." } },
          requestId,
        );
      if (user.role !== "admin" && existing.created_by !== user.id)
        return json(
          res,
          403,
          {
            error: {
              code: "FORBIDDEN",
              message:
                "Only the creator or an administrator can delete this template.",
            },
          },
          requestId,
        );
      db.prepare("DELETE FROM signature_templates WHERE id=?").run(id);
      recordAudit(user, "template.deleted", "template", id, {
        name: existing.name,
      });
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      url.pathname === "/api/signature/workflow/submit" &&
      req.method === "POST"
    ) {
      requireEditor(user);
      if (!workspaceSettings(user).requireApproval)
        return json(
          res,
          409,
          {
            error: {
              code: "APPROVAL_NOT_REQUIRED",
              message: "This workspace does not require signature approval.",
            },
          },
          requestId,
        );
      const member = memberById(user.organizationId, user.id),
        current = normalizeSignature(member);
      if (current.workflowStatus === "pending")
        return json(
          res,
          409,
          {
            error: {
              code: "APPROVAL_ALREADY_PENDING",
              message: "This signature is already awaiting approval.",
            },
          },
          requestId,
        );
      current.workflowStatus = "pending";
      current.submittedAt = new Date().toISOString();
      current.reviewNote = "";
      current.approvedAt = null;
      current.approvedBy = null;
      saveSignatureRow(user.organizationId, user.id, current);
      recordAudit(user, "signature.submitted", "user", user.id);
      return json(res, 200, { signature: current }, requestId);
    }
    if (url.pathname === "/api/signature/approvals" && req.method === "GET") {
      requireAdmin(user);
      const rows = db
        .prepare(
          `${memberSelect} WHERE m.organization_id=? AND json_extract(m.signature_json,'$.workflowStatus')='pending' ORDER BY json_extract(m.signature_json,'$.submittedAt')`,
        )
        .all(user.organizationId);
      return json(res, 200, { approvals: rows.map(userDto) }, requestId);
    }
    const approvalMatch = url.pathname.match(
      /^\/api\/signature\/approvals\/([^/]+)\/(approve|reject)$/,
    );
    if (approvalMatch && req.method === "POST") {
      requireAdmin(user);
      const target = memberById(user.organizationId, approvalMatch[1]);
      if (!target)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "User not found." } },
          requestId,
        );
      const body = await readJsonBody(req),
        sig = normalizeSignature(target);
      if (sig.workflowStatus !== "pending")
        return json(
          res,
          409,
          {
            error: {
              code: "APPROVAL_NOT_PENDING",
              message: "This signature is not awaiting approval.",
            },
          },
          requestId,
        );
      sig.workflowStatus =
        approvalMatch[2] === "approve" ? "approved" : "rejected";
      sig.reviewNote = String(body.note || "").slice(0, 500);
      sig.approvedAt =
        approvalMatch[2] === "approve" ? new Date().toISOString() : null;
      sig.approvedBy = user.id;
      saveSignatureRow(user.organizationId, target.id, sig);
      recordAudit(user, `signature.${sig.workflowStatus}`, "user", target.id, {
        note: sig.reviewNote,
      });
      return json(
        res,
        200,
        { user: userDto(memberById(user.organizationId, target.id)) },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/campaigns" && req.method === "GET") {
      requireAdmin(user);
      return json(
        res,
        200,
        {
          campaigns: db
            .prepare(
              "SELECT * FROM signature_campaigns WHERE organization_id=? ORDER BY start_date DESC",
            )
            .all(user.organizationId)
            .map(campaignDto),
        },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/campaigns" && req.method === "POST") {
      requireAdmin(user);
      const body = await readJsonBody(req),
        id = randomUUID(),
        input = campaignInput(body);
      if (
        !input.title ||
        !validDate(input.startDate) ||
        !validDate(input.endDate) ||
        input.endDate < input.startDate
      )
        return json(
          res,
          400,
          {
            error: {
              code: "CAMPAIGN_INVALID",
              message: "Enter a title and valid date range.",
            },
          },
          requestId,
        );
      if (
        (input.linkUrl && !validUrl(input.linkUrl)) ||
        (input.imageUrl && !validMediaUrl(input.imageUrl))
      )
        return json(
          res,
          400,
          {
            error: {
              code: "URL_INVALID",
              message: "Enter valid campaign and banner URLs.",
            },
          },
          requestId,
        );
      db.prepare(
        "INSERT INTO signature_campaigns(id,organization_id,title,message,link_url,image_url,start_date,end_date,status,overlay_json,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        user.organizationId,
        input.title,
        input.message,
        input.linkUrl,
        input.imageUrl,
        input.startDate,
        input.endDate,
        input.status,
        JSON.stringify(input.overlay),
        user.id,
      );
      const campaign = db
        .prepare("SELECT * FROM signature_campaigns WHERE id=?")
        .get(id);
      recordAudit(user, "campaign.created", "campaign", id, {
        title: input.title,
      });
      return json(res, 201, { id, campaign: campaignDto(campaign) }, requestId);
    }
    const campaignMatch = url.pathname.match(
      /^\/api\/signature\/campaigns\/([^/]+)$/,
    );
    if (campaignMatch && req.method === "PUT") {
      requireAdmin(user);
      const id = decodeURIComponent(campaignMatch[1]),
        existing = db
          .prepare(
            "SELECT * FROM signature_campaigns WHERE id=? AND organization_id=?",
          )
          .get(id, user.organizationId);
      if (!existing)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "Campaign not found." } },
          requestId,
        );
      const input = campaignInput(await readJsonBody(req), existing);
      if (
        !input.title ||
        !validDate(input.startDate) ||
        !validDate(input.endDate) ||
        input.endDate < input.startDate
      )
        return json(
          res,
          400,
          {
            error: {
              code: "CAMPAIGN_INVALID",
              message: "Enter a title and valid date range.",
            },
          },
          requestId,
        );
      if (
        (input.linkUrl && !validUrl(input.linkUrl)) ||
        (input.imageUrl && !validMediaUrl(input.imageUrl))
      )
        return json(
          res,
          400,
          {
            error: {
              code: "URL_INVALID",
              message: "Enter valid campaign and banner URLs.",
            },
          },
          requestId,
        );
      db.prepare(
        `UPDATE signature_campaigns SET title=?,message=?,link_url=?,image_url=?,start_date=?,end_date=?,status=?,overlay_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=?`,
      ).run(
        input.title,
        input.message,
        input.linkUrl,
        input.imageUrl,
        input.startDate,
        input.endDate,
        input.status,
        JSON.stringify(input.overlay),
        id,
        user.organizationId,
      );
      const campaign = db
        .prepare("SELECT * FROM signature_campaigns WHERE id=?")
        .get(id);
      recordAudit(user, "campaign.updated", "campaign", id, {
        title: input.title,
      });
      return json(res, 200, { campaign: campaignDto(campaign) }, requestId);
    }
    if (campaignMatch && req.method === "DELETE") {
      requireAdmin(user);
      const row = db
        .prepare(
          "SELECT * FROM signature_campaigns WHERE id=? AND organization_id=?",
        )
        .get(campaignMatch[1], user.organizationId);
      if (!row)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "Campaign not found." } },
          requestId,
        );
      db.prepare("DELETE FROM signature_campaigns WHERE id=?").run(row.id);
      recordAudit(user, "campaign.deleted", "campaign", row.id, {
        title: row.title,
      });
      return json(res, 200, { ok: true }, requestId);
    }
    if (url.pathname === "/api/signature/departments" && req.method === "GET") {
      requireAdmin(user);
      return json(
        res,
        200,
        {
          departments: db
            .prepare(
              "SELECT * FROM department_signature_defaults WHERE organization_id=? ORDER BY department",
            )
            .all(user.organizationId)
            .map((row) => ({
              department: row.department,
              templateId: row.template_id,
              accent: row.accent_color,
            })),
        },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/departments" && req.method === "PUT") {
      requireAdmin(user);
      const body = await readJsonBody(req),
        department = limited(body.department, 120),
        templateId = String(body.templateId || "executive"),
        accent = String(body.accent || "#2563eb");
      if (!department)
        return json(
          res,
          400,
          {
            error: {
              code: "DEPARTMENT_REQUIRED",
              message: "Enter a department.",
            },
          },
          requestId,
        );
      if (
        !TEMPLATES[templateId] &&
        !db
          .prepare(
            "SELECT 1 FROM signature_templates WHERE id=? AND organization_id=?",
          )
          .get(templateId, user.organizationId)
      )
        return json(
          res,
          400,
          {
            error: {
              code: "TEMPLATE_INVALID",
              message: "Choose an available signature template.",
            },
          },
          requestId,
        );
      if (!/^#[0-9a-f]{6}$/i.test(accent))
        return json(
          res,
          400,
          {
            error: {
              code: "ACCENT_INVALID",
              message: "Choose a valid accent color.",
            },
          },
          requestId,
        );
      db.prepare(
        `INSERT INTO department_signature_defaults(organization_id,department,template_id,accent_color,updated_by,updated_at) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(organization_id,department) DO UPDATE SET template_id=excluded.template_id,accent_color=excluded.accent_color,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      ).run(user.organizationId, department, templateId, accent, user.id);
      recordAudit(user, "department.updated", "department", department);
      return json(res, 200, { ok: true }, requestId);
    }
    const departmentMatch = url.pathname.match(
      /^\/api\/signature\/departments\/([^/]+)$/,
    );
    if (departmentMatch && req.method === "DELETE") {
      requireAdmin(user);
      const department = decodeURIComponent(departmentMatch[1]),
        result = db
          .prepare(
            "DELETE FROM department_signature_defaults WHERE organization_id=? AND department=?",
          )
          .run(user.organizationId, department);
      if (!result.changes)
        return json(
          res,
          404,
          {
            error: {
              code: "NOT_FOUND",
              message: "Department default not found.",
            },
          },
          requestId,
        );
      recordAudit(user, "department.deleted", "department", department);
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      url.pathname === "/api/signature/bulk-rollout" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      const body = await readJsonBody(req),
        overwrite = Boolean(body.overwrite ?? body.overwriteExisting),
        sendEmail = Boolean(body.sendEmail),
        templateId = String(body.templateId || "");
      if (sendEmail && !mailAvailable(user.organizationId))
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Microsoft 365 email delivery is not configured.",
            },
          },
          requestId,
        );
      rolloutTemplatePatch(user.organizationId, templateId);
      const job = enqueueJob(
        "signature.rollout",
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          templateId,
          overwrite,
          sendEmail,
          origin: publicBase(req, user),
        },
        {
          organizationId: user.organizationId,
          dedupeKey: `signature.rollout:${user.organizationId}`,
        },
      );
      recordAudit(user, "rollout.queued", "job", job.id, {
        overwrite,
        sendEmail,
      });
      return json(
        res,
        202,
        { job: { id: job.id, status: job.status } },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/analytics" && req.method === "GET") {
      requireAdmin(user);
      const rows = db
          .prepare(
            `SELECT u.id,u.display_name,u.email,COALESCE(SUM(l.clicks),0) AS clicks,MAX(l.last_clicked_at) AS last_clicked_at FROM organization_memberships m JOIN signature_users u ON u.id=m.user_id LEFT JOIN signature_tracking_links l ON l.user_id=u.id AND l.organization_id=m.organization_id WHERE m.organization_id=? GROUP BY u.id ORDER BY clicks DESC,u.display_name`,
          )
          .all(user.organizationId),
        breakdowns = db
          .prepare(
            "SELECT user_id,kind,clicks FROM signature_tracking_links WHERE organization_id=? ORDER BY clicks DESC",
          )
          .all(user.organizationId);
      return json(
        res,
        200,
        {
          analytics: rows.map((row) => ({
            ...row,
            breakdown: breakdowns
              .filter((item) => item.user_id === row.id)
              .map((item) => ({ kind: item.kind, clicks: item.clicks })),
          })),
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/directory-sync" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      const active = db
        .prepare(
          "SELECT id,status FROM background_jobs WHERE organization_id=? AND type='directory.sync' AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
        )
        .get(user.organizationId);
      if (active)
        return json(res, 202, { job: active, existing: true }, requestId);
      const runId = randomUUID();
      db.prepare(
        `INSERT INTO directory_sync_runs(id,organization_id,status,started_by) VALUES (?,?,'queued',?)`,
      ).run(runId, user.organizationId, user.id);
      const job = enqueueJob(
        "directory.sync",
        {
          organizationId: user.organizationId,
          actorUserId: user.id,
          runId,
        },
        {
          organizationId: user.organizationId,
          dedupeKey: `directory.sync:${user.organizationId}`,
        },
      );
      recordAudit(user, "directory.sync_queued", "job", job.id, { runId });
      return json(
        res,
        202,
        { job: { id: job.id, status: job.status }, runId },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/send-to-self" &&
      req.method === "POST"
    ) {
      requireEditor(user);
      if (!mailAvailable(user.organizationId))
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Microsoft 365 email delivery is not configured.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req, { limit: 65536 }),
        signatureError = signatureInputError(body.signature || body),
        target = userDto(memberById(user.organizationId, user.id)),
        rendered = signatureError
          ? null
          : await renderSignature(req, target, body.signature || body);
      if (signatureError)
        return json(
          res,
          400,
          {
            error: { code: "SIGNATURE_INVALID", message: signatureError },
          },
          requestId,
        );
      await sendGraphMail(
        user.organizationId,
        target.email,
        "Your email signature is ready to install",
        installEmailBody(rendered.html),
      );
      recordAudit(user, "signature.emailed_to_self", "user", user.id);
      return json(res, 200, { ok: true }, requestId);
    }
    if (url.pathname === "/api/signature/send" && req.method === "POST") {
      requireAdmin(user);
      if (!mailAvailable(user.organizationId))
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Microsoft 365 email delivery is not configured.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req),
        target = body.userId
          ? memberById(user.organizationId, body.userId)
          : memberByEmail(user.organizationId, body.email);
      if (!target)
        return json(
          res,
          404,
          { error: { code: "NOT_FOUND", message: "User not found." } },
          requestId,
        );
      const targetUser = userDto(target),
        rendered = await renderSignature(req, targetUser, targetUser.signature),
        mail = installEmailBody(rendered.html);
      await sendGraphMail(
        user.organizationId,
        targetUser.email,
        "Your email signature is ready",
        mail,
      );
      recordAudit(user, "signature.emailed", "user", targetUser.id);
      return json(res, 200, { ok: true }, requestId);
    }
    if (
      url.pathname === "/api/signature/admin-config" &&
      ["GET", "PUT"].includes(req.method)
    ) {
      requireAdmin(user);
      if (req.method === "PUT") {
        const body = await readJsonBody(req, { limit: 32768 }),
          row = workspaceRow(user),
          current = safeJson(row.settings_json),
          sessionHours = Number(
            body.sessionHours ?? current.sessionHours ?? 12,
          );
        if (
          !Number.isInteger(sessionHours) ||
          sessionHours < 1 ||
          sessionHours > 168
        )
          return json(
            res,
            400,
            {
              error: {
                code: "SESSION_HOURS_INVALID",
                message: "Session length must be from 1 to 168 hours.",
              },
            },
            requestId,
          );
        const next = {
          ...current,
          publicUrl: cleanUrl(body.publicUrl ?? current.publicUrl),
          assetBaseUrl: cleanUrl(body.assetBaseUrl ?? current.assetBaseUrl),
          mediaBaseUrl: cleanUrl(body.mediaBaseUrl ?? current.mediaBaseUrl),
          sessionHours,
          requireApproval: Boolean(body.requireApproval),
          backupPath: String(body.backupPath ?? current.backupPath ?? "")
            .trim()
            .slice(0, 260),
          brand: normalizedBrand(
            body.brand || {},
            current.brand || {},
            body.name || row.name,
          ),
        };
        for (const value of [
          next.publicUrl,
          next.assetBaseUrl,
          next.mediaBaseUrl,
        ])
          if (
            value &&
            (!validUrl(value) || (production && !value.startsWith("https://")))
          )
            return json(
              res,
              400,
              {
                error: {
                  code: "URL_INVALID",
                  message: production
                    ? "Public and media URLs must use HTTPS."
                    : "Enter valid public and media URLs.",
                },
              },
              requestId,
            );
        const name =
          String(body.name || row.name)
            .trim()
            .slice(0, 120) || row.name;
        db.prepare(
          `UPDATE organizations SET name=?,settings_json=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(name, JSON.stringify(next), user.organizationId);
        recordAudit(
          user,
          "workspace.updated",
          "organization",
          user.organizationId,
        );
        return json(
          res,
          200,
          { workspace: workspaceDto(workspaceRow(user)) },
          requestId,
        );
      }
      const stats = {
        users: db
          .prepare(
            "SELECT COUNT(*) count FROM organization_memberships WHERE organization_id=?",
          )
          .get(user.organizationId).count,
        activeUsers: db
          .prepare(
            `SELECT COUNT(*) count FROM organization_memberships WHERE organization_id=? AND status='active'`,
          )
          .get(user.organizationId).count,
        templates:
          db
            .prepare(
              "SELECT COUNT(*) count FROM signature_templates WHERE organization_id=?",
            )
            .get(user.organizationId).count + builtinTemplates.length,
        campaigns: db
          .prepare(
            "SELECT COUNT(*) count FROM signature_campaigns WHERE organization_id=?",
          )
          .get(user.organizationId).count,
        clicks: db
          .prepare(
            "SELECT COALESCE(SUM(clicks),0) count FROM signature_tracking_links WHERE organization_id=?",
          )
          .get(user.organizationId).count,
      };
      const audit = db
          .prepare(
            `SELECT a.*,u.display_name actor_name FROM audit_logs a LEFT JOIN signature_users u ON u.id=a.actor_user_id WHERE a.organization_id=? ORDER BY a.created_at DESC LIMIT 40`,
          )
          .all(user.organizationId)
          .map(auditDto),
        sync = db
          .prepare(
            "SELECT * FROM directory_sync_runs WHERE organization_id=? ORDER BY started_at DESC LIMIT 1",
          )
          .get(user.organizationId);
      return json(
        res,
        200,
        {
          workspace: workspaceDto(workspaceRow(user)),
          subscription: subscriptionDto(
            db
              .prepare(
                "SELECT * FROM organization_subscriptions WHERE organization_id=?",
              )
              .get(user.organizationId),
          ),
          stats,
          audit,
          lastDirectorySync: sync || null,
          integrations: {
            mail: mailAvailable(user.organizationId),
            microsoftDirectory: Boolean(
              microsoftAvailable() &&
              microsoftConnection(user.organizationId, true),
            ),
            microsoft: microsoftConnectionDto(
              microsoftConnection(user.organizationId),
            ),
          },
          readiness: {
            ready: Boolean(
              workspaceSettings(user).mediaBaseUrl ||
              workspaceSettings(user).publicUrl,
            ),
            checks: [
              { id: "workspace", label: "Workspace active", ok: true },
              {
                id: "members",
                label: "At least one active member",
                ok: stats.activeUsers > 0,
              },
              {
                id: "media",
                label: "Public media URL configured",
                ok: Boolean(
                  workspaceSettings(user).mediaBaseUrl ||
                  workspaceSettings(user).publicUrl,
                ),
              },
              {
                id: "microsoft",
                label: "Microsoft 365 connected",
                ok: Boolean(
                  microsoftAvailable() &&
                  microsoftConnection(user.organizationId, true),
                ),
              },
            ],
          },
        },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/audit" && req.method === "GET") {
      requireAdmin(user);
      const rows = db
        .prepare(
          `SELECT a.*,u.display_name actor_name FROM audit_logs a LEFT JOIN signature_users u ON u.id=a.actor_user_id WHERE a.organization_id=? ORDER BY a.created_at DESC LIMIT 100`,
        )
        .all(user.organizationId);
      return json(res, 200, { audit: rows.map(auditDto) }, requestId);
    }
    return json(
      res,
      405,
      { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } },
      requestId,
    );
  };
  handle.jobHandlers = workflowHandlers;
  return handle;
}

function seed(db, signature = {}) {
  const organization = db
    .prepare("SELECT * FROM organizations ORDER BY created_at LIMIT 1")
    .get();
  if (!organization) return;
  const current = safeJson(organization.settings_json),
    settings = {
      publicUrl: signature.publicUrl || current.publicUrl || "",
      assetBaseUrl: signature.assetBaseUrl || current.assetBaseUrl || "",
      mediaBaseUrl: signature.mediaBaseUrl || current.mediaBaseUrl || "",
      sessionHours: signature.sessionHours || current.sessionHours || 12,
      requireApproval: Boolean(current.requireApproval),
      brand: {
        locked: false,
        accent: "#2563eb",
        font: "system",
        companyName: signature.companyName || organization.name,
        logoUrl: "",
        ...(current.brand || {}),
      },
      ...current,
    };
  if (signature.companyName && organization.name === "Signify Workspace")
    db.prepare(
      "UPDATE organizations SET name=?,settings_json=? WHERE id=?",
    ).run(signature.companyName, JSON.stringify(settings), organization.id);
  else
    db.prepare("UPDATE organizations SET settings_json=? WHERE id=?").run(
      JSON.stringify(settings),
      organization.id,
    );
  if (
    !db.prepare("SELECT COUNT(*) count FROM signature_users").get().count &&
    signature.allowDefaultAdmin !== false
  ) {
    const id = randomUUID(),
      email = signature.bootstrapEmail || "admin@signify.local",
      name = `${signature.companyName || "Signify"} Admin`,
      sig = normalizeSignature(
        { display_name: name, email, signature_json: "{}" },
        {
          fields: {
            name,
            email,
            company: signature.companyName || organization.name,
          },
        },
      );
    db.prepare(
      `INSERT INTO signature_users(id,email,password_hash,display_name,role,signature_json,email_verified_at) VALUES (?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      id,
      email,
      hashPassword(signature.bootstrapPassword || "SignifyDemo123!"),
      name,
      "admin",
      JSON.stringify(sig),
    );
  }
  const users = db.prepare("SELECT * FROM signature_users").all();
  for (const user of users)
    db.prepare(
      `INSERT INTO organization_memberships(organization_id,user_id,role,status,signature_json) VALUES (?,?,?,?,?) ON CONFLICT(organization_id,user_id) DO NOTHING`,
    ).run(
      organization.id,
      user.id,
      user.role,
      user.status,
      user.signature_json,
    );
  if (!db.prepare("SELECT 1 FROM application_owners LIMIT 1").get()) {
    let owner = db
      .prepare(
        `SELECT id FROM signature_users WHERE lower(email)=lower(?) LIMIT 1`,
      )
      .get(signature.applicationOwnerEmail || signature.bootstrapEmail || "");
    if (!owner && signature.allowDefaultAdmin)
      owner = db
        .prepare(
          `SELECT u.id FROM signature_users u JOIN organization_memberships m ON m.user_id=u.id WHERE m.role='admin' ORDER BY u.created_at LIMIT 1`,
        )
        .get();
    if (owner)
      db.prepare(
        "INSERT INTO application_owners(user_id,status) VALUES (?,'active')",
      ).run(owner.id);
  }
  if (
    signature.microsoftTenantId &&
    !db
      .prepare(
        "SELECT 1 FROM organization_microsoft_connections WHERE organization_id=?",
      )
      .get(organization.id)
  )
    db.prepare(
      `INSERT INTO organization_microsoft_connections(organization_id,tenant_id,tenant_name,status,sender_email,consented_at,last_verified_at) VALUES (?,?,?,'connected',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      organization.id,
      signature.microsoftTenantId,
      "Legacy Microsoft 365 tenant",
      signature.microsoftSenderEmail || "",
    );
  db.prepare(
    `UPDATE signature_templates SET organization_id=? WHERE organization_id IS NULL`,
  ).run(organization.id);
  if (
    !db
      .prepare(
        "SELECT COUNT(*) count FROM signature_templates WHERE organization_id=?",
      )
      .get(organization.id).count
  )
    for (const [name, patch] of legacyTemplates)
      db.prepare(
        "INSERT INTO signature_templates(id,name,template_json,organization_id) VALUES (?,?,?,?)",
      ).run(randomUUID(), name, JSON.stringify(patch), organization.id);
  db.prepare(
    `INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES (?,'starter','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')) ON CONFLICT(organization_id) DO NOTHING`,
  ).run(organization.id);
}

module.exports = { createSignaturePortal };
