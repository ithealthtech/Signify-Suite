"use strict";

const { createPublicKey, randomUUID, verify } = require("node:crypto");

const SUPPORTED_FEATURES = new Set([
  "multi_tenant",
  "tenant_billing",
  "advanced_reporting",
]);

function licenseError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function installationId(db) {
  let row = db
    .prepare(
      "SELECT setting_value FROM application_settings WHERE setting_key='installation_id'",
    )
    .get();
  if (!row) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO application_settings(setting_key,setting_value) VALUES ('installation_id',?)",
    ).run(id);
    row = { setting_value: id };
  }
  return row.setting_value;
}

function parseToken(token) {
  const parts = String(token || "")
    .trim()
    .split(".");
  if (parts.length !== 3 || parts[0] !== "SIG1")
    throw licenseError(
      "Enter a valid Signify license key.",
      400,
      "LICENSE_INVALID",
    );
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    claims = null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims))
    throw licenseError(
      "The license payload is invalid.",
      400,
      "LICENSE_INVALID",
    );
  return {
    claims,
    payload: Buffer.from(parts[1], "base64url"),
    signature: Buffer.from(parts[2], "base64url"),
    token: parts.join("."),
  };
}

function createLicensing({
  db,
  publicKey = "",
  authorityUrl = "",
  fetchFn = globalThis.fetch,
  now = () => new Date(),
}) {
  const id = installationId(db),
    verificationKey = String(publicKey || "")
      .replaceAll("\\n", "\n")
      .trim(),
    authority = String(authorityUrl || "")
      .trim()
      .replace(/\/+$/, "");
  let publicKeyObject = null;
  if (verificationKey) {
    try {
      publicKeyObject = createPublicKey(verificationKey);
    } catch {
      throw new Error(
        "SIGNIFY_LICENSE_PUBLIC_KEY must contain a valid public key.",
      );
    }
    if (publicKeyObject.asymmetricKeyType !== "ed25519")
      throw new Error(
        "SIGNIFY_LICENSE_PUBLIC_KEY must be an Ed25519 public key.",
      );
  }

  function row() {
    return db
      .prepare("SELECT * FROM installation_licenses WHERE id='primary'")
      .get();
  }

  function community(status = "community", current = null) {
    return {
      installationId: id,
      verificationConfigured: Boolean(verificationKey),
      authorityConfigured: Boolean(authority),
      authorityUrl: authority,
      edition: "community",
      status,
      customerName: current?.customer_name || "",
      licenseId: current?.license_id || null,
      features: [],
      maxTenants: 1,
      maxUsersPerTenant: 10,
      issuedAt: current?.issued_at || null,
      expiresAt: current?.expires_at || null,
      graceEndsAt: current?.grace_ends_at || null,
      lastRefreshedAt: current?.last_refreshed_at || null,
      lastRefreshAttemptAt: current?.last_refresh_attempt_at || null,
      lastRefreshError: current?.last_refresh_error || "",
      revokedAt: current?.revoked_at || null,
      revocationReason: current?.revocation_reason || "",
    };
  }

  function summary() {
    const current = row();
    if (!current) return community();
    const permanentlyRevoked = db
      .prepare(
        "SELECT revoked_at,reason FROM installation_license_revocations WHERE license_id=?",
      )
      .get(current.license_id);
    if (permanentlyRevoked)
      return community("revoked", {
        ...current,
        revoked_at: permanentlyRevoked.revoked_at,
        revocation_reason: permanentlyRevoked.reason,
      });
    if (current.revoked_at) return community("suspended", current);
    const timestamp = now().getTime(),
      expires = Date.parse(current.expires_at),
      graceEnds = Date.parse(current.grace_ends_at),
      status =
        timestamp <= expires
          ? "active"
          : timestamp <= graceEnds
            ? "grace"
            : "expired";
    if (status === "expired") return community("expired", current);
    return {
      installationId: id,
      verificationConfigured: Boolean(verificationKey),
      authorityConfigured: Boolean(authority),
      authorityUrl: authority,
      edition: current.edition,
      status,
      customerName: current.customer_name,
      licenseId: current.license_id,
      features: JSON.parse(current.features_json),
      maxTenants: current.max_tenants,
      maxUsersPerTenant: current.max_users_per_tenant,
      issuedAt: current.issued_at,
      expiresAt: current.expires_at,
      graceEndsAt: current.grace_ends_at,
      lastRefreshedAt: current.last_refreshed_at || null,
      lastRefreshAttemptAt: current.last_refresh_attempt_at || null,
      lastRefreshError: current.last_refresh_error || "",
      revokedAt: null,
      revocationReason: "",
    };
  }

  function validate(token, { authoritative = false } = {}) {
    if (!publicKeyObject)
      throw licenseError(
        "Commercial license verification is not configured for this build.",
        503,
        "LICENSE_VERIFICATION_UNAVAILABLE",
      );
    const parsed = parseToken(token);
    let authentic = false;
    try {
      authentic = verify(
        null,
        parsed.payload,
        publicKeyObject,
        parsed.signature,
      );
    } catch {
      authentic = false;
    }
    if (!authentic)
      throw licenseError(
        "The license signature is invalid.",
        400,
        "LICENSE_SIGNATURE_INVALID",
      );
    const claims = parsed.claims,
      features = Array.isArray(claims.features)
        ? [
            ...new Set(
              claims.features.filter((item) => SUPPORTED_FEATURES.has(item)),
            ),
          ]
        : [],
      maxTenants = Number(claims.maxTenants),
      maxUsersPerTenant = Number(claims.maxUsersPerTenant ?? 100000),
      issuedAt = Date.parse(claims.issuedAt),
      expiresAt = Date.parse(claims.expiresAt),
      graceEndsAt = Date.parse(claims.graceEndsAt);
    if (
      claims.installationId !== id ||
      claims.product !== "signify-creator" ||
      claims.edition !== "enterprise" ||
      typeof claims.licenseId !== "string" ||
      !claims.licenseId.trim() ||
      typeof claims.customerName !== "string" ||
      !claims.customerName.trim() ||
      !Number.isInteger(maxTenants) ||
      maxTenants < 2 ||
      maxTenants > 100000 ||
      !Number.isInteger(maxUsersPerTenant) ||
      maxUsersPerTenant < 10 ||
      maxUsersPerTenant > 100000 ||
      !features.includes("multi_tenant") ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(graceEndsAt) ||
      issuedAt > expiresAt ||
      issuedAt > now().getTime() + 5 * 60 * 1000 ||
      expiresAt > graceEndsAt
    )
      throw licenseError(
        "This license is not valid for this installation or edition.",
        400,
        "LICENSE_CLAIMS_INVALID",
      );
    if (
      !authoritative &&
      db
        .prepare(
          "SELECT 1 FROM installation_license_revocations WHERE license_id=?",
        )
        .get(claims.licenseId.trim())
    )
      throw licenseError(
        "This license has been revoked.",
        410,
        "LICENSE_REVOKED",
      );
    if (now().getTime() > graceEndsAt)
      throw licenseError(
        "This license and its grace period have expired.",
        400,
        "LICENSE_EXPIRED",
      );
    return {
      ...parsed,
      authoritative,
      claims: {
        licenseId: claims.licenseId.trim().slice(0, 180),
        product: "signify-creator",
        customerName: claims.customerName.trim().slice(0, 180),
        edition: "enterprise",
        installationId: id,
        features,
        maxTenants,
        maxUsersPerTenant,
        issuedAt: new Date(issuedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        graceEndsAt: new Date(graceEndsAt).toISOString(),
      },
    };
  }

  function persist(validated, actorUserId = null, refreshed = false) {
    const claims = validated.claims,
      refreshedAt = refreshed ? now().toISOString() : null;
    db.prepare(
      `INSERT INTO installation_licenses(id,license_id,customer_name,edition,signed_token,features_json,max_tenants,max_users_per_tenant,issued_at,expires_at,grace_ends_at,activated_by,authority_url,last_refreshed_at,last_refresh_attempt_at,last_refresh_error,revoked_at,revocation_reason)
       VALUES ('primary',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'')
       ON CONFLICT(id) DO UPDATE SET license_id=excluded.license_id,customer_name=excluded.customer_name,edition=excluded.edition,signed_token=excluded.signed_token,features_json=excluded.features_json,max_tenants=excluded.max_tenants,max_users_per_tenant=excluded.max_users_per_tenant,issued_at=excluded.issued_at,expires_at=excluded.expires_at,grace_ends_at=excluded.grace_ends_at,activated_by=COALESCE(excluded.activated_by,installation_licenses.activated_by),authority_url=excluded.authority_url,last_refreshed_at=COALESCE(excluded.last_refreshed_at,installation_licenses.last_refreshed_at),last_refresh_attempt_at=COALESCE(excluded.last_refresh_attempt_at,installation_licenses.last_refresh_attempt_at),last_refresh_error='',revoked_at=NULL,revocation_reason='',activated_at=CASE WHEN excluded.activated_by IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE installation_licenses.activated_at END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(
      claims.licenseId,
      claims.customerName,
      claims.edition,
      validated.token,
      JSON.stringify(claims.features),
      claims.maxTenants,
      claims.maxUsersPerTenant,
      claims.issuedAt,
      claims.expiresAt,
      claims.graceEndsAt,
      actorUserId,
      authority,
      refreshedAt,
      refreshedAt,
      "",
    );
    if (validated.authoritative)
      db.prepare(
        "DELETE FROM installation_license_revocations WHERE license_id=?",
      ).run(claims.licenseId);
    return summary();
  }

  function activate(token, actorUserId = null) {
    return persist(validate(token), actorUserId, false);
  }

  async function authorityRequest(path, body) {
    if (!authority || typeof fetchFn !== "function")
      throw licenseError(
        "The Signify licensing service is not configured for this build.",
        503,
        "LICENSE_AUTHORITY_UNAVAILABLE",
      );
    let response;
    try {
      response = await fetchFn(`${authority}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw licenseError(
        "The Signify licensing service could not be reached.",
        503,
        "LICENSE_AUTHORITY_UNAVAILABLE",
      );
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw licenseError(
        payload.error?.message ||
          "The licensing service rejected this request.",
        response.status,
        payload.error?.code || "LICENSE_AUTHORITY_REJECTED",
      );
    if (!payload.licenseToken)
      throw licenseError(
        "The licensing service returned an invalid response.",
        502,
        "LICENSE_AUTHORITY_INVALID_RESPONSE",
      );
    return validate(payload.licenseToken, { authoritative: true });
  }

  async function prepareActivation(key) {
    const value = String(key || "").trim();
    return value.startsWith("SIG1.")
      ? validate(value)
      : authorityRequest("/v1/licenses/activate", {
          activationKey: value,
          installationId: id,
        });
  }

  async function activateKey(key, actorUserId = null) {
    const value = String(key || "").trim();
    return persist(
      await prepareActivation(value),
      actorUserId,
      !value.startsWith("SIG1."),
    );
  }

  function markRefreshFailure(error) {
    const current = row();
    if (!current) return summary();
    const attemptedAt = now().toISOString();
    if (["LICENSE_REVOKED", "LICENSE_NOT_FOUND"].includes(error.code)) {
      db.prepare(
        "INSERT INTO installation_license_revocations(license_id,revoked_at,reason) VALUES (?,?,?) ON CONFLICT(license_id) DO UPDATE SET revoked_at=excluded.revoked_at,reason=excluded.reason",
      ).run(current.license_id, attemptedAt, error.message.slice(0, 500));
      db.prepare(
        "UPDATE installation_licenses SET revoked_at=?,revocation_reason=?,last_refresh_attempt_at=?,last_refresh_error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='primary'",
      ).run(
        attemptedAt,
        error.message.slice(0, 500),
        attemptedAt,
        error.message.slice(0, 500),
      );
    } else if (error.code === "LICENSE_SUSPENDED") {
      db.prepare(
        "UPDATE installation_licenses SET revoked_at=?,revocation_reason=?,last_refresh_attempt_at=?,last_refresh_error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='primary'",
      ).run(
        attemptedAt,
        error.message.slice(0, 500),
        attemptedAt,
        error.message.slice(0, 500),
      );
    } else {
      db.prepare(
        "UPDATE installation_licenses SET last_refresh_attempt_at=?,last_refresh_error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='primary'",
      ).run(attemptedAt, error.message.slice(0, 500));
    }
    return summary();
  }

  async function refresh({ throwOnFailure = false } = {}) {
    const current = row();
    if (!current)
      throw licenseError(
        "No commercial license is active.",
        409,
        "LICENSE_NOT_ACTIVE",
      );
    try {
      const validated = await authorityRequest("/v1/licenses/refresh", {
        licenseToken: current.signed_token,
        installationId: id,
      });
      return persist(validated, null, true);
    } catch (error) {
      const entitlement = markRefreshFailure(error);
      if (throwOnFailure) throw Object.assign(error, { entitlement });
      return entitlement;
    }
  }

  function startAutoRefresh(intervalMs = 12 * 60 * 60 * 1000) {
    if (!authority) return { stop() {} };
    const refreshIfActive = () => {
      if (row()) void refresh();
    };
    const first = setTimeout(refreshIfActive, Math.min(30000, intervalMs));
    first.unref();
    const timer = globalThis.setInterval(refreshIfActive, intervalMs);
    timer.unref();
    return {
      stop() {
        clearTimeout(first);
        globalThis.clearInterval(timer);
      },
    };
  }

  function deactivate() {
    db.prepare("DELETE FROM installation_licenses WHERE id='primary'").run();
    return summary();
  }

  function requireTenantCapacity(requestedCount) {
    const entitlement = summary();
    if (requestedCount > entitlement.maxTenants)
      throw Object.assign(
        new Error(
          entitlement.edition === "community"
            ? "Community Edition supports one tenant. Enter a commercial license to add tenants."
            : `This license supports ${entitlement.maxTenants} tenants.`,
        ),
        { status: 403, code: "LICENSE_TENANT_LIMIT", entitlement },
      );
    return entitlement;
  }

  function requireFeature(feature) {
    if (!SUPPORTED_FEATURES.has(feature))
      throw new TypeError(`Unknown license feature: ${feature}`);
    const entitlement = summary();
    if (!entitlement.features.includes(feature))
      throw Object.assign(
        new Error(
          "This operation requires a commercial license with the corresponding feature enabled.",
        ),
        { status: 403, code: "LICENSE_FEATURE_REQUIRED", entitlement },
      );
    return entitlement;
  }

  function userCapacity(organizationId) {
    const entitlement = summary(),
      memberCount = db
        .prepare(
          "SELECT COUNT(*) count FROM organization_memberships WHERE organization_id=?",
        )
        .get(organizationId).count,
      pendingInvitations = db
        .prepare(
          `SELECT COUNT(*) count FROM organization_invitations
           WHERE organization_id=? AND accepted_at IS NULL
             AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .get(organizationId).count,
      used = memberCount + pendingInvitations;
    return {
      edition: entitlement.edition,
      memberCount,
      pendingInvitations,
      used,
      maxUsers: entitlement.maxUsersPerTenant,
      remaining: Math.max(0, entitlement.maxUsersPerTenant - used),
    };
  }

  function requireUserCapacity(organizationId, additions = 1) {
    const requested = Number(additions),
      capacity = userCapacity(organizationId);
    if (!Number.isInteger(requested) || requested < 0)
      throw new TypeError(
        "User capacity additions must be a positive integer.",
      );
    if (capacity.used + requested > capacity.maxUsers)
      throw Object.assign(
        new Error(
          capacity.edition === "community"
            ? "Community Edition supports 10 users per workspace. Activate a commercial license to add more."
            : `This license supports ${capacity.maxUsers} users per tenant.`,
        ),
        { status: 403, code: "LICENSE_USER_LIMIT", capacity },
      );
    return capacity;
  }

  return Object.freeze({
    activate,
    activateKey,
    deactivate,
    installationId: id,
    prepareActivation,
    persist,
    refresh,
    requireFeature,
    requireTenantCapacity,
    requireUserCapacity,
    startAutoRefresh,
    summary,
    userCapacity,
    validate,
  });
}

module.exports = { createLicensing, parseToken };
