"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
  randomUUID,
} = require("node:crypto");
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const QRCode = require("qrcode");
const Stripe = require("stripe");
const sharp = require("sharp");
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

const BRAND_FONT_STACKS = Object.freeze({
  system: "'Segoe UI', Helvetica, Arial, sans-serif",
  arial: "Arial, Helvetica, sans-serif",
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  verdana: "Verdana, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
});

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(String(password), salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(String(password), salt, 64),
    expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function cookie(req, name) {
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index > 0 && decodeURIComponent(item.slice(0, index).trim()) === name)
      return decodeURIComponent(item.slice(index + 1).trim());
  }
  return "";
}
function sessionCookie(token, maxAge, secure) {
  return `sig_session=${encodeURIComponent(token || "")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}
function csrfCookie(token, maxAge, secure) {
  return `sig_csrf=${encodeURIComponent(token || "")}; Path=/; SameSite=Strict; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}
function validUrl(value) {
  if (!value) return true;
  try {
    return ["http:", "https:"].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}
function validMediaUrl(value) {
  return !value || String(value).startsWith("/") || validUrl(value);
}
function cleanUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}
function canonicalRole(value) {
  const role = String(value || "editor").toLowerCase();
  return ["admin", "editor", "viewer"].includes(role) ? role : "editor";
}
function canonicalStatus(value) {
  return String(value || "active").toLowerCase() === "disabled"
    ? "disabled"
    : "active";
}
function slug(value) {
  return (
    String(value || "workspace")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "workspace"
  );
}
function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return fallback;
  }
}
function limited(value, max = 240) {
  return String(value || "")
    .trim()
    .slice(0, max);
}
function safeLink(value, max = 1000) {
  const link = limited(value, max);
  return validUrl(link) ? link : "";
}
function safeMedia(value) {
  const link = limited(value, 1000);
  return validMediaUrl(link) ? link : "";
}
function canonicalBrandFont(value) {
  const key = String(value || "system").toLowerCase();
  return BRAND_FONT_STACKS[key] ? key : "system";
}
function normalizedBrand(input = {}, current = {}, companyName = "") {
  const accent = String(input.accent ?? current.accent ?? "#2563eb");
  return {
    locked: Boolean(input.locked ?? current.locked),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#2563eb",
    font: canonicalBrandFont(input.font ?? current.font),
    companyName: limited(
      input.companyName ?? current.companyName ?? companyName,
      120,
    ),
    logoUrl: safeMedia(input.logoUrl ?? current.logoUrl),
  };
}
function validDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function campaignInput(body = {}, existing = {}) {
  return {
    title: limited(body.title ?? existing.title, 64),
    message: limited(body.message ?? existing.message, 240),
    linkUrl: limited(body.linkUrl ?? existing.link_url, 1000),
    imageUrl: limited(body.imageUrl ?? existing.image_url, 1000),
    startDate: String(body.startDate ?? existing.start_date ?? ""),
    endDate: String(body.endDate ?? existing.end_date ?? ""),
    status:
      String(body.status ?? existing.status) === "paused" ? "paused" : "active",
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
function redirect(res, location, headers = {}) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end();
  return true;
}
function textResponse(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8",
  headers = {},
) {
  const data = Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(data);
  return true;
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
function subscriptionDto(row) {
  return row
    ? {
        plan: row.plan,
        status: row.status,
        seats: row.seats,
        trialEndsAt: row.trial_ends_at,
        currentPeriodEnd: row.current_period_end,
        stripeCustomerId: row.stripe_customer_id || null,
      }
    : null;
}
function auditDto(row) {
  return {
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    actorName: row.actor_name || "System",
    metadata: safeJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

function createSignaturePortal({
  db,
  production,
  signature = {},
  json,
  readJsonBody,
  readBody,
  publicRoot = path.join(__dirname, "..", "public"),
}) {
  seed(db, signature);
  const stripe = signature.stripeSecretKey
    ? new Stripe(signature.stripeSecretKey, {
        maxNetworkRetries: 2,
        timeout: 10000,
      })
    : null;
  const microsoftAvailable = Boolean(
    signature.microsoftClientId &&
    signature.microsoftClientSecret &&
    signature.microsoftTenantId,
  );
  const memberSelect = `SELECT u.id,u.email,u.password_hash,u.display_name,u.role,u.status,u.created_at,u.updated_at,u.last_login_at,u.email_verified_at,m.signature_json,m.role AS membership_role,m.status AS membership_status,o.id AS organization_id,o.name AS organization_name,o.slug AS organization_slug,o.settings_json AS organization_settings FROM signature_users u JOIN organization_memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id`;
  const builtinTemplates = Object.entries(TEMPLATES).map(([id, item]) => ({
    id,
    name: item.name,
    blurb: item.blurb,
    kind: "builtin",
  }));

  function requestBase(req) {
    const proto =
      String(req.headers["x-forwarded-proto"] || "").split(",")[0] ||
      (req.socket.encrypted ? "https" : "http");
    return `${proto}://${req.headers.host || "127.0.0.1:4173"}`;
  }
  function workspaceRow(user) {
    return db
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(user.organizationId);
  }
  function workspaceSettings(user) {
    return safeJson(workspaceRow(user)?.settings_json);
  }
  function publicBase(req, user) {
    const settings = user ? workspaceSettings(user) : {};
    return cleanUrl(
      settings.publicUrl || signature.publicUrl || requestBase(req),
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
    Object.defineProperties(user, {
      sessionId: { value: row.session_id },
      csrfTokenHash: { value: row.csrf_token_hash || "" },
    });
    return user;
  }
  function requireAdmin(user) {
    if (user.role !== "admin") {
      const error = new Error("Administrator access required.");
      error.status = 403;
      error.code = "ADMIN_REQUIRED";
      throw error;
    }
  }
  function requireEditor(user) {
    if (!["admin", "editor"].includes(user.role)) {
      const error = new Error("Editor access required.");
      error.status = 403;
      error.code = "EDITOR_REQUIRED";
      throw error;
    }
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
  function mailAvailable() {
    return Boolean(
      signature.microsoftClientId &&
      signature.microsoftClientSecret &&
      signature.microsoftTenantId &&
      signature.microsoftSenderEmail,
    );
  }
  function billingAvailable() {
    return Boolean(
      stripe &&
      signature.stripeWebhookSecret &&
      Object.values(signature.stripePrices || {}).some(Boolean),
    );
  }
  function planForPrice(priceId) {
    return (
      Object.entries(signature.stripePrices || {}).find(
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
    const sig = {
        ...normalizeSignature(
          {
            display_name: user.displayName,
            email: user.email,
            signature_json: "{}",
          },
          input,
        ),
        ...input,
      },
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
      iconBase: `${publicBase(req, user)}/icons`,
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
    return `${cleanUrl(settings.mediaBaseUrl || settings.publicUrl || signature.mediaBaseUrl || publicBase(req, user))}/${url.replace(/^\/+/, "")}`;
  }
  function saveSignatureRow(organizationId, userId, input) {
    const existing = memberById(organizationId, userId),
      normalized = {
        ...normalizeSignature(existing),
        ...input,
        fields: {
          ...normalizeSignature(existing).fields,
          ...(input.fields || {}),
          social: {
            ...normalizeSignature(existing).fields.social,
            ...(input.fields?.social || {}),
          },
        },
        colors: {
          ...normalizeSignature(existing).colors,
          ...(input.colors || {}),
        },
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
        const response = await fetch(url, {
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

  async function graphAppToken() {
    if (
      !signature.microsoftClientId ||
      !signature.microsoftClientSecret ||
      !signature.microsoftTenantId
    )
      throw Object.assign(new Error("Microsoft 365 is not configured."), {
        status: 400,
        code: "MICROSOFT_NOT_CONFIGURED",
      });
    const body = new URLSearchParams({
      client_id: signature.microsoftClientId,
      client_secret: signature.microsoftClientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });
    const response = await fetchWithRetry(
      `https://login.microsoftonline.com/${encodeURIComponent(signature.microsoftTenantId)}/oauth2/v2.0/token`,
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
  async function sendGraphMail(to, subject, html) {
    const token = await graphAppToken(),
      sender = signature.microsoftSenderEmail;
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

  return async function handle(req, res, url, requestId) {
    if (url.pathname === "/webhooks/stripe" && req.method === "POST") {
      if (!stripe || !signature.stripeWebhookSecret)
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
          signature.stripeWebhookSecret,
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
    if (url.pathname === "/auth/microsoft" && req.method === "GET") {
      if (!microsoftAvailable)
        return redirect(res, "/signature.html?auth=microsoft-unavailable");
      const state = randomBytes(24).toString("base64url");
      db.prepare(
        "INSERT INTO oauth_states(token_hash,provider,expires_at) VALUES (?,'microsoft',?)",
      ).run(tokenHash(state), new Date(Date.now() + 600000).toISOString());
      const callback = `${cleanUrl(signature.publicUrl || requestBase(req))}/auth/microsoft/callback`,
        params = new URLSearchParams({
          client_id: signature.microsoftClientId,
          response_type: "code",
          redirect_uri: callback,
          response_mode: "query",
          scope: "openid profile email User.Read",
          state,
        });
      return redirect(
        res,
        `https://login.microsoftonline.com/${encodeURIComponent(signature.microsoftTenantId)}/oauth2/v2.0/authorize?${params}`,
      );
    }
    if (url.pathname === "/auth/microsoft/callback" && req.method === "GET") {
      const state = url.searchParams.get("state"),
        storedState = db
          .prepare(
            `DELETE FROM oauth_states WHERE token_hash=? AND provider='microsoft' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') RETURNING token_hash`,
          )
          .get(tokenHash(state || ""));
      if (!storedState)
        return textResponse(res, 400, "Microsoft sign-in state expired.");
      const callback = `${cleanUrl(signature.publicUrl || requestBase(req))}/auth/microsoft/callback`,
        body = new URLSearchParams({
          client_id: signature.microsoftClientId,
          client_secret: signature.microsoftClientSecret,
          code: url.searchParams.get("code") || "",
          redirect_uri: callback,
          grant_type: "authorization_code",
          scope: "openid profile email User.Read",
        }),
        tokenRes = await fetchWithRetry(
          `https://login.microsoftonline.com/${encodeURIComponent(signature.microsoftTenantId)}/oauth2/v2.0/token`,
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
        );
      const meRes = await fetchWithRetry(
        "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department,businessPhones,mobilePhone",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      if (!meRes.ok)
        return textResponse(res, 502, "Microsoft profile request failed.");
      const profile = await meRes.json(),
        email = String(
          profile.mail || profile.userPrincipalName || "",
        ).toLowerCase();
      if (!validEmail(email))
        return textResponse(
          res,
          400,
          "Microsoft account has no usable email address.",
        );
      let row = db
        .prepare(
          `${memberSelect} WHERE lower(u.email)=lower(?) ORDER BY m.created_at LIMIT 1`,
        )
        .get(email);
      if (!row) {
        return redirect(res, "/signature.html?auth=account-required");
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
    if (!url.pathname.startsWith("/api/signature/")) return false;
    if (url.pathname === "/api/signature/capabilities" && req.method === "GET")
      return json(
        res,
        200,
        {
          registration: signature.allowRegistration,
          microsoft: microsoftAvailable,
          passwordReset: mailAvailable() || !production,
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
      if (production && !mailAvailable())
        return json(
          res,
          503,
          {
            error: {
              code: "MAIL_NOT_CONFIGURED",
              message: "Password recovery is temporarily unavailable.",
            },
          },
          requestId,
        );
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
        if (mailAvailable())
          await sendGraphMail(
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
      if (
        db
          .prepare("SELECT id FROM signature_users WHERE lower(email)=lower(?)")
          .get(email)
      )
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
          `INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES (?,'beta','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'))`,
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
          .toLowerCase(),
        row = db
          .prepare(
            `${memberSelect} WHERE lower(u.email)=lower(?) AND u.status='active' AND m.status='active' AND o.status='active' ORDER BY m.created_at LIMIT 1`,
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
      recordAudit(session.user, "session.login", "user", session.user.id);
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
    if (
      url.pathname === "/api/signature/session/switch" &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req, { limit: 8192 }),
        target = memberById(String(body.organizationId || ""), user.id);
      if (
        !target ||
        target.membership_status !== "active" ||
        target.status !== "active"
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
            microsoft: microsoftAvailable,
            directorySync: Boolean(
              signature.microsoftClientId &&
              signature.microsoftClientSecret &&
              signature.microsoftTenantId,
            ),
            mail: Boolean(signature.microsoftSenderEmail),
            billing: billingAvailable(),
            billingPlans: Object.entries(signature.stripePrices || {})
              .filter(([, price]) => Boolean(price))
              .map(([plan]) => plan),
          },
        },
        requestId,
      );
    }
    if (
      url.pathname === "/api/signature/billing/checkout" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      if (!billingAvailable())
        return json(
          res,
          503,
          {
            error: {
              code: "STRIPE_NOT_CONFIGURED",
              message: "Billing is not configured.",
            },
          },
          requestId,
        );
      const body = await readJsonBody(req, { limit: 8192 }),
        plan = String(body.plan || "starter"),
        price = signature.stripePrices?.[plan];
      if (!price)
        return json(
          res,
          400,
          {
            error: {
              code: "PLAN_INVALID",
              message: "Choose an available plan.",
            },
          },
          requestId,
        );
      const subscription = db
          .prepare(
            "SELECT * FROM organization_subscriptions WHERE organization_id=?",
          )
          .get(user.organizationId),
        base = publicBase(req, user),
        checkout = await stripe.checkout.sessions.create({
          mode: "subscription",
          client_reference_id: user.organizationId,
          ...(subscription?.stripe_customer_id
            ? { customer: subscription.stripe_customer_id }
            : { customer_email: user.email }),
          line_items: [{ price, quantity: 1 }],
          allow_promotion_codes: true,
          success_url: `${base}/admin.html?billing=success#settings`,
          cancel_url: `${base}/admin.html?billing=canceled#settings`,
          metadata: { organization_id: user.organizationId, plan },
          subscription_data: {
            metadata: { organization_id: user.organizationId, plan },
          },
        });
      recordAudit(
        user,
        "billing.checkout_created",
        "organization",
        user.organizationId,
        {
          plan,
        },
      );
      return json(res, 201, { url: checkout.url }, requestId);
    }
    if (
      url.pathname === "/api/signature/billing/portal" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      if (!stripe)
        return json(
          res,
          503,
          {
            error: {
              code: "STRIPE_NOT_CONFIGURED",
              message: "Billing is not configured.",
            },
          },
          requestId,
        );
      const subscription = db
        .prepare(
          "SELECT * FROM organization_subscriptions WHERE organization_id=?",
        )
        .get(user.organizationId);
      if (!subscription?.stripe_customer_id)
        return json(
          res,
          409,
          {
            error: {
              code: "BILLING_CUSTOMER_REQUIRED",
              message: "Start a paid plan before opening billing management.",
            },
          },
          requestId,
        );
      const portal = await stripe.billingPortal.sessions.create({
        customer: subscription.stripe_customer_id,
        return_url: `${publicBase(req, user)}/admin.html#settings`,
      });
      return json(res, 201, { url: portal.url }, requestId);
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !url.pathname.startsWith("/api/signature/billing/") &&
      url.pathname !== "/api/signature/admin-config"
    )
      requireSubscription(user);
    if (
      url.pathname === "/api/signature/invitations" &&
      req.method === "POST"
    ) {
      requireAdmin(user);
      if (production && !mailAvailable())
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
      if (mailAvailable())
        await sendGraphMail(
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
        dir = path.join(publicRoot, "uploads", user.organizationId),
        name = `${slug(body.kind || "image")}-${randomUUID()}.${ext}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), processed.bytes);
      recordAudit(user, "asset.uploaded", "asset", name, {
        kind: limited(body.kind || "image", 40),
        sourceBytes: bytes.length,
        storedBytes: processed.bytes.length,
      });
      return json(
        res,
        201,
        { url: `/uploads/${user.organizationId}/${name}` },
        requestId,
      );
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
      const dir = path.join(
          publicRoot,
          "generated-banners",
          user.organizationId,
        ),
        name = `banner-${randomUUID()}.gif`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.from(gif.bytes()));
      return json(
        res,
        201,
        { url: `/generated-banners/${user.organizationId}/${name}` },
        requestId,
      );
    }
    if (url.pathname === "/api/signature/preview" && req.method === "POST") {
      const body = await readJsonBody(req, { limit: 65536 }),
        target = body.userId
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
      if (body.signature)
        saveSignatureRow(user.organizationId, id, body.signature);
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
      if (body.displayName) {
        const nextEmail = existing.email,
          nextName = String(body.displayName).trim();
        if (!validEmail(nextEmail) || !nextName)
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
        const duplicate = db
          .prepare(
            "SELECT id FROM signature_users WHERE lower(email)=lower(?) AND id<>?",
          )
          .get(nextEmail, id);
        if (duplicate)
          return json(
            res,
            409,
            {
              error: {
                code: "EMAIL_EXISTS",
                message: "That email is already in use.",
              },
            },
            requestId,
          );
        db.prepare(
          `UPDATE signature_users SET email=?,display_name=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(nextEmail, nextName, id);
      }
      if (isAdmin && body.password) {
        if (String(body.password).length < 10)
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
        db.prepare("UPDATE signature_users SET password_hash=? WHERE id=?").run(
          hashPassword(body.password),
          id,
        );
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
          .slice(0, 80);
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
      const id = randomUUID();
      db.prepare(
        "INSERT INTO signature_templates(id,name,template_json,created_by,organization_id) VALUES (?,?,?,?,?)",
      ).run(
        id,
        name,
        JSON.stringify(body.patch || body.signature || {}),
        user.id,
        user.organizationId,
      );
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
      const current = normalizeSignature(
        db.prepare("SELECT * FROM signature_users WHERE id=?").get(user.id),
      );
      current.workflowStatus = "pending";
      current.submittedAt = new Date().toISOString();
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
        "INSERT INTO signature_campaigns(id,organization_id,title,message,link_url,image_url,start_date,end_date,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
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
        `UPDATE signature_campaigns SET title=?,message=?,link_url=?,image_url=?,start_date=?,end_date=?,status=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND organization_id=?`,
      ).run(
        input.title,
        input.message,
        input.linkUrl,
        input.imageUrl,
        input.startDate,
        input.endDate,
        input.status,
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
        department = String(body.department || "").trim();
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
      db.prepare(
        `INSERT INTO department_signature_defaults(organization_id,department,template_id,accent_color,updated_by,updated_at) VALUES (?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(organization_id,department) DO UPDATE SET template_id=excluded.template_id,accent_color=excluded.accent_color,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      ).run(
        user.organizationId,
        department,
        String(body.templateId || "executive"),
        String(body.accent || "#2563eb"),
        user.id,
      );
      recordAudit(user, "department.updated", "department", department);
      return json(res, 200, { ok: true }, requestId);
    }
    const departmentMatch = url.pathname.match(
      /^\/api\/signature\/departments\/([^/]+)$/,
    );
    if (departmentMatch && req.method === "DELETE") {
      requireAdmin(user);
      const department = decodeURIComponent(departmentMatch[1]);
      db.prepare(
        "DELETE FROM department_signature_defaults WHERE organization_id=? AND department=?",
      ).run(user.organizationId, department);
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
        errors = [];
      if (sendEmail && !mailAvailable())
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
      rolloutTemplatePatch(user.organizationId, String(body.templateId || ""));
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
            dept?.template_id || body.templateId || sig.templateId,
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
                rendered = await renderSignature(req, target, target.signature);
              await sendGraphMail(
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
      recordAudit(
        user,
        "rollout.completed",
        "organization",
        user.organizationId,
        {
          updated: updated.length,
          skipped: skipped.length,
          emailed,
          errors: errors.length,
          overwrite,
          sendEmail,
        },
      );
      return json(
        res,
        200,
        {
          updated: updated.length,
          skipped: skipped.length,
          emailed,
          errors,
          total: rows.length,
        },
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
      const runId = randomUUID(),
        subscription = db
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
      db.prepare(
        `INSERT INTO directory_sync_runs(id,organization_id,status,started_by) VALUES (?,?,'running',?)`,
      ).run(runId, user.organizationId, user.id);
      try {
        const token = await graphAppToken(),
          response = await fetchWithRetry(
            "https://graph.microsoft.com/v1.0/users?$select=id,displayName,mail,userPrincipalName,jobTitle,department,businessPhones,mobilePhone,assignedLicenses&$top=999",
            { headers: { Authorization: `Bearer ${token}` } },
          ),
          data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error?.message || "Microsoft Graph directory request failed.",
          );
        const people = (data.value || []).filter(
          (item) => item.assignedLicenses?.length,
        );
        let added = 0;
        for (const person of people) {
          const email = String(
            person.mail || person.userPrincipalName || "",
          ).toLowerCase();
          if (!validEmail(email)) continue;
          let account = db
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
            );
          const existingMembership = memberById(user.organizationId, id);
          if (!existingMembership && added >= availableSeats) continue;
          if (!account) {
            db.prepare(
              `INSERT INTO signature_users(id,email,password_hash,display_name,role,status,signature_json,email_verified_at) VALUES (?,?,?,?,'editor','active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
            ).run(
              id,
              email,
              hashPassword(randomBytes(32).toString("hex")),
              person.displayName || email,
              JSON.stringify(personSignature),
            );
          }
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
        recordAudit(
          user,
          "directory.synced",
          "organization",
          user.organizationId,
          { seen: people.length, added },
        );
        return json(res, 200, { seen: people.length, added }, requestId);
      } catch (error) {
        db.prepare(
          `UPDATE directory_sync_runs SET status='failed',error_message=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(String(error.message).slice(0, 500), runId);
        throw error;
      }
    }
    if (
      url.pathname === "/api/signature/send-to-self" &&
      req.method === "POST"
    ) {
      requireEditor(user);
      if (!mailAvailable())
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
        target = userDto(memberById(user.organizationId, user.id)),
        rendered = await renderSignature(req, target, body.signature || body);
      await sendGraphMail(
        target.email,
        "Your email signature is ready to install",
        installEmailBody(rendered.html),
      );
      recordAudit(user, "signature.emailed_to_self", "user", user.id);
      return json(res, 200, { ok: true }, requestId);
    }
    if (url.pathname === "/api/signature/send" && req.method === "POST") {
      requireAdmin(user);
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
          next = {
            ...current,
            publicUrl: cleanUrl(body.publicUrl ?? current.publicUrl),
            assetBaseUrl: cleanUrl(body.assetBaseUrl ?? current.assetBaseUrl),
            mediaBaseUrl: cleanUrl(body.mediaBaseUrl ?? current.mediaBaseUrl),
            sessionHours: Math.max(
              1,
              Math.min(
                168,
                Number(body.sessionHours ?? current.sessionHours ?? 12),
              ),
            ),
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
          if (value && !validUrl(value))
            return json(
              res,
              400,
              {
                error: {
                  code: "URL_INVALID",
                  message: "Enter valid public and media URLs.",
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
          billing: {
            available: billingAvailable(),
            plans: Object.entries(signature.stripePrices || {})
              .filter(([, price]) => Boolean(price))
              .map(([plan]) => plan),
          },
          integrations: {
            mail: mailAvailable(),
            microsoftDirectory: Boolean(
              signature.microsoftClientId &&
              signature.microsoftClientSecret &&
              signature.microsoftTenantId,
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
                  signature.microsoftClientId &&
                  signature.microsoftClientSecret,
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
    `INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at) VALUES (?,'beta','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days')) ON CONFLICT(organization_id) DO NOTHING`,
  ).run(organization.id);
}

module.exports = { createSignaturePortal };
