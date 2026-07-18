"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  cleanupOrphanMedia,
  tenantUsage,
  writeTenantMedia,
} = require("../server/media-storage.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-media-test-"));
try {
  const stored = writeTenantMedia({
    publicRoot: root,
    organizationId: "tenant-one",
    collection: "uploads",
    name: "logo-id.png",
    bytes: Buffer.from("referenced"),
    limitBytes: 20,
  });
  assert.equal(stored.url, "/uploads/tenant-one/logo-id.png");
  assert.equal(tenantUsage(root, "tenant-one"), 10);
  assert.throws(
    () =>
      writeTenantMedia({
        publicRoot: root,
        organizationId: "tenant-one",
        collection: "generated-banners",
        name: "too-large.gif",
        bytes: Buffer.alloc(11),
        limitBytes: 20,
      }),
    (error) => error.status === 413 && error.code === "MEDIA_STORAGE_LIMIT",
  );
  assert.throws(
    () => tenantUsage(root, "../escape"),
    (error) => error.code === "TENANT_STORAGE_INVALID",
  );

  const orphan = path.join(root, "uploads", "tenant-one", "orphan.png");
  fs.writeFileSync(orphan, "orphan");
  const old = new Date(Date.now() - 10 * 86400000);
  fs.utimesSync(orphan, old, old);
  const rows = {
      "SELECT signature_json FROM organization_memberships": [
        { signature_json: JSON.stringify({ photoUrl: stored.url }) },
      ],
      "SELECT image_url FROM signature_campaigns": [],
      "SELECT settings_json FROM organizations": [],
    },
    db = { prepare: (sql) => ({ all: () => rows[sql] }) },
    result = cleanupOrphanMedia(db, root, 7);
  assert.deepEqual(result, { removedFiles: 1, removedBytes: 6 });
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(
    fs.existsSync(path.join(root, "uploads", "tenant-one", "logo-id.png")),
    true,
  );
  console.log(
    "Media tests passed: tenant isolation, atomic writes, quotas, references, and orphan cleanup",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
