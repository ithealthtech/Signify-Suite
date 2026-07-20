"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough, Readable } = require("node:stream");
const { serveObjectMedia } = require("../server.cjs");
const { loadConfig } = require("../server/config.cjs");
const { migrateMedia } = require("./migrate-media-to-s3.cjs");
const {
  cleanupOrphanMedia,
  createS3MediaStorage,
  mediaKey,
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
    "Local media tests passed: tenant isolation, atomic writes, quotas, references, and orphan cleanup",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function testS3() {
  assert.throws(
    () => loadConfig({ SIGNIFY_MEDIA_STORAGE: "s3" }),
    /S3_BUCKET and S3_REGION are required/,
  );
  assert.equal(
    loadConfig({ SIGNIFY_MEDIA_STORAGE: "s3", S3_BUCKET: "signify-test" })
      .mediaStorage,
    "s3",
  );
  const calls = [],
    old = new Date(Date.now() - 10 * 86400000),
    client = {
      async send(command) {
        calls.push(command);
        if (command.constructor.name === "ListObjectsV2Command") {
          if (command.input.Prefix === "uploads/tenant-one/")
            return { Contents: [{ Key: "existing", Size: 4 }] };
          if (command.input.Prefix === "generated-banners/tenant-one/")
            return { Contents: [{ Key: "existing", Size: 3 }] };
          return {
            Contents: [
              {
                Key: "uploads/tenant-one/logo.png",
                Size: 5,
                LastModified: old,
              },
              {
                Key: "uploads/tenant-one/orphan.png",
                Size: 2,
                LastModified: old,
              },
            ],
          };
        }
        if (command.constructor.name === "GetObjectCommand")
          return {
            Body: Readable.from(Buffer.from("image")),
            ContentLength: 5,
            ContentType: "image/png",
            CacheControl: "public, max-age=60",
          };
        return {};
      },
    },
    storage = createS3MediaStorage({
      s3: {
        bucket: "signify-test",
        region: "us-east-1",
        forcePathStyle: false,
      },
      client,
      presign: async (_client, command, options) =>
        `https://storage.example.test/${command.input.Key}?expires=${options.expiresIn}`,
    }),
    stored = await storage.write({
      organizationId: "tenant-one",
      collection: "uploads",
      name: "logo.png",
      bytes: Buffer.from("image"),
      limitBytes: 20,
    });
  assert.equal(stored.url, "/uploads/tenant-one/logo.png");
  assert.equal(stored.usageBytes, 12);
  const put = calls.find(
    (command) => command.constructor.name === "PutObjectCommand",
  );
  assert.equal(put.input.Key, "uploads/tenant-one/logo.png");
  assert.equal(put.input.ServerSideEncryption, "AES256");
  assert.equal(put.input.Metadata.tenant, "tenant-one");
  const object = await storage.read({
    organizationId: "tenant-one",
    collection: "uploads",
    name: "logo.png",
  });
  assert.equal(object.contentLength, 5);
  const response = new PassThrough();
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers;
  };
  assert.ok(
    await serveObjectMedia(
      storage,
      { method: "HEAD" },
      response,
      "/uploads/tenant-one/logo.png",
      "media-request",
    ),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "image/png");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(
    await storage.signedReadUrl({
      organizationId: "tenant-one",
      collection: "uploads",
      name: "logo.png",
      expiresIn: 120,
    }),
    "https://storage.example.test/uploads/tenant-one/logo.png?expires=120",
  );
  const rows = {
      "SELECT signature_json FROM organization_memberships": [
        {
          signature_json: JSON.stringify({
            photoUrl: "/uploads/tenant-one/logo.png",
          }),
        },
      ],
      "SELECT image_url FROM signature_campaigns": [],
      "SELECT settings_json FROM organizations": [],
    },
    db = { prepare: (sql) => ({ all: () => rows[sql] }) },
    cleanup = await storage.cleanup(db, 7),
    deletion = calls.find(
      (command) => command.constructor.name === "DeleteObjectsCommand",
    );
  assert.deepEqual(cleanup, { removedFiles: 1, removedBytes: 2 });
  assert.deepEqual(deletion.input.Delete.Objects, [
    { Key: "uploads/tenant-one/orphan.png" },
  ]);
  assert.equal(
    mediaKey("generated-banners", "tenant-one", "campaign.gif"),
    "generated-banners/tenant-one/campaign.gif",
  );
  assert.throws(
    () => mediaKey("uploads", "../escape", "logo.png"),
    (error) => error.code === "TENANT_STORAGE_INVALID",
  );
  const migrationRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-media-migration-"),
    ),
    migrationDirectory = path.join(
      migrationRoot,
      "uploads",
      "tenant-migration",
    ),
    migrated = new Map(),
    migrationStorage = {
      async write(input) {
        migrated.set(
          `${input.collection}/${input.organizationId}/${input.name}`,
          Buffer.from(input.bytes),
        );
      },
      async read(input) {
        return {
          body: Readable.from(
            migrated.get(
              `${input.collection}/${input.organizationId}/${input.name}`,
            ),
          ),
        };
      },
    };
  fs.mkdirSync(migrationDirectory, { recursive: true });
  fs.writeFileSync(path.join(migrationDirectory, "existing.png"), "existing");
  try {
    const migration = await migrateMedia({
      publicRoot: migrationRoot,
      storage: migrationStorage,
      limitBytes: 100,
    });
    assert.deepEqual(migration, {
      discovered: 1,
      copied: 1,
      bytes: 8,
      deleted: 0,
    });
    assert.equal(
      fs.existsSync(path.join(migrationDirectory, "existing.png")),
      true,
    );
    const destructive = await migrateMedia({
      publicRoot: migrationRoot,
      storage: migrationStorage,
      limitBytes: 100,
      deleteSource: true,
    });
    assert.equal(destructive.deleted, 1);
    assert.equal(
      fs.existsSync(path.join(migrationDirectory, "existing.png")),
      false,
    );
  } finally {
    fs.rmSync(migrationRoot, { recursive: true, force: true });
  }
  console.log(
    "S3 media tests passed: private writes, tenant quotas, reads, signed URLs, references, migration verification, and orphan cleanup",
  );
}

testS3().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
