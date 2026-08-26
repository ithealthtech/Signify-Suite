"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, sign } = require("node:crypto");
const { openDatabase } = require("../server/database.cjs");
const { createLicensing } = require("../server/licensing.cjs");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "signify-license-")),
  db = openDatabase(path.join(directory, "license.db")),
  { privateKey, publicKey } = generateKeyPairSync("ed25519"),
  publicPem = publicKey.export({ type: "spki", format: "pem" });

let clock = new Date("2026-08-25T12:00:00.000Z"),
  remoteMode = "active";

function licenseKey(claims) {
  const payload = Buffer.from(JSON.stringify(claims)),
    signature = sign(null, payload, privateKey);
  return `SIG1.${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

function claims(installationId, overrides = {}) {
  return {
    licenseId: "license-enterprise-test",
    product: "signify-creator",
    installationId,
    customerName: "Enterprise Test",
    edition: "enterprise",
    features: ["multi_tenant", "tenant_billing"],
    maxTenants: 25,
    maxUsersPerTenant: 250,
    issuedAt: clock.toISOString(),
    expiresAt: new Date(clock.getTime() + 86400000).toISOString(),
    graceEndsAt: new Date(clock.getTime() + 8 * 86400000).toISOString(),
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function main() {
  try {
    let installation;
    const fetchFn = async () => {
        if (remoteMode === "offline") throw new Error("network unavailable");
        if (remoteMode === "revoked")
          return jsonResponse(
            {
              error: { code: "LICENSE_REVOKED", message: "License revoked." },
            },
            410,
          );
        if (remoteMode === "suspended")
          return jsonResponse(
            {
              error: {
                code: "LICENSE_SUSPENDED",
                message: "Subscription is past due.",
              },
            },
            402,
          );
        const maxTenants = remoteMode === "downgraded" ? 5 : 25,
          maxUsersPerTenant = remoteMode === "downgraded" ? 20 : 250;
        return jsonResponse({
          licenseToken: licenseKey(
            claims(installation.installationId, {
              maxTenants,
              maxUsersPerTenant,
            }),
          ),
        });
      },
      licensing = createLicensing({
        db,
        publicKey: publicPem,
        authorityUrl: "https://license.example.test",
        fetchFn,
        now: () => clock,
      });
    installation = licensing;
    assert.equal(licensing.summary().edition, "community");
    assert.equal(licensing.summary().maxTenants, 1);
    assert.equal(licensing.summary().maxUsersPerTenant, 10);
    assert.throws(
      () => licensing.requireTenantCapacity(2),
      (error) => error.code === "LICENSE_TENANT_LIMIT",
    );
    assert.throws(
      () => licensing.requireFeature("tenant_billing"),
      (error) => error.code === "LICENSE_FEATURE_REQUIRED",
    );
    for (let index = 0; index < 9; index += 1) {
      db.prepare(
        "INSERT INTO signature_users(id,email,password_hash,display_name) VALUES (?,?,?,?)",
      ).run(
        `community-user-${index}`,
        `community-${index}@example.test`,
        "not-used",
        `Community User ${index}`,
      );
      db.prepare(
        "INSERT INTO organization_memberships(organization_id,user_id,role,status) VALUES ('org-default',?,'editor',?)",
      ).run(`community-user-${index}`, index === 8 ? "disabled" : "active");
    }
    db.prepare(
      `INSERT INTO organization_invitations(id,organization_id,email,role,token_hash,expires_at)
       VALUES ('capacity-invite','org-default','pending@example.test','editor','capacity-token','2099-01-01T00:00:00.000Z')`,
    ).run();
    assert.deepEqual(licensing.userCapacity("org-default"), {
      edition: "community",
      memberCount: 9,
      pendingInvitations: 1,
      used: 10,
      maxUsers: 10,
      remaining: 0,
    });
    assert.throws(
      () => licensing.requireUserCapacity("org-default", 1),
      (error) => error.code === "LICENSE_USER_LIMIT",
    );

    const token = licenseKey(claims(licensing.installationId));
    const activated = licensing.activate(token);
    assert.equal(activated.maxTenants, 25);
    assert.equal(activated.maxUsersPerTenant, 250);
    assert.equal(
      licensing.requireFeature("tenant_billing").edition,
      "enterprise",
    );
    assert.equal(licensing.userCapacity("org-default").remaining, 240);

    const parts = token.split("."),
      forgedClaims = { ...claims(licensing.installationId), maxTenants: 999 },
      forged = `SIG1.${Buffer.from(JSON.stringify(forgedClaims)).toString("base64url")}.${parts[2]}`;
    assert.throws(
      () => licensing.activate(forged),
      (error) => error.code === "LICENSE_SIGNATURE_INVALID",
    );
    assert.throws(
      () =>
        licensing.activate(
          licenseKey(claims("00000000-0000-4000-8000-000000000000")),
        ),
      (error) => error.code === "LICENSE_CLAIMS_INVALID",
    );

    remoteMode = "offline";
    const offline = await licensing.refresh();
    assert.equal(offline.edition, "enterprise");
    assert.match(offline.lastRefreshError, /could not be reached/i);

    remoteMode = "suspended";
    await assert.rejects(
      licensing.refresh({ throwOnFailure: true }),
      (error) => error.code === "LICENSE_SUSPENDED",
    );
    assert.equal(licensing.summary().status, "suspended");
    assert.equal(licensing.summary().maxTenants, 1);

    remoteMode = "downgraded";
    const downgraded = await licensing.refresh({ throwOnFailure: true });
    assert.equal(downgraded.maxTenants, 5);
    assert.equal(downgraded.maxUsersPerTenant, 20);
    assert.throws(
      () => licensing.requireTenantCapacity(6),
      (error) => error.code === "LICENSE_TENANT_LIMIT",
    );

    remoteMode = "revoked";
    await assert.rejects(
      licensing.refresh({ throwOnFailure: true }),
      (error) => error.code === "LICENSE_REVOKED",
    );
    assert.equal(licensing.summary().status, "revoked");
    assert.equal(licensing.summary().maxTenants, 1);
    assert.throws(
      () => licensing.activate(token),
      (error) => error.code === "LICENSE_REVOKED",
    );
    remoteMode = "active";
    const reinstated = await licensing.refresh({ throwOnFailure: true });
    assert.equal(reinstated.status, "active");
    assert.equal(reinstated.edition, "enterprise");
    assert.equal(reinstated.maxTenants, 25);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) count FROM installation_license_revocations WHERE license_id=?",
        )
        .get("license-enterprise-test").count,
      0,
    );

    const expiryDb = openDatabase(path.join(directory, "expiry.db"));
    try {
      const expiryLicensing = createLicensing({
        db: expiryDb,
        publicKey: publicPem,
        now: () => clock,
      });
      expiryLicensing.activate(
        licenseKey(
          claims(expiryLicensing.installationId, {
            licenseId: "expiry-license",
            expiresAt: new Date(clock.getTime() + 1000).toISOString(),
            graceEndsAt: new Date(clock.getTime() + 2000).toISOString(),
          }),
        ),
      );
      clock = new Date(clock.getTime() + 3000);
      assert.equal(expiryLicensing.summary().status, "expired");
      assert.equal(expiryLicensing.summary().maxTenants, 1);
    } finally {
      expiryDb.close();
    }

    console.log(
      "Licensing tests passed: Community tenant and user limits, invitation reservations, signed activation, forged and mismatched rejection, offline grace, downgrade, durable revocation, authoritative reinstatement, and expiry",
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
