"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openDatabase } = require("../server/database.cjs");
const {
  createApplicationOperations,
} = require("../server/application-operations.cjs");
const { checksum, createRecoveryManager } = require("../server/recovery.cjs");

async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signify-recovery-")),
    config = {
      sourceRoot: path.join(__dirname, ".."),
      databasePath: path.join(root, "data", "signify.db"),
      backupPath: path.join(root, "backups"),
      publicRoot: path.join(root, "public"),
      updateRepository: "owner/repository",
      recovery: {
        mode: "local",
        retentionDays: 1,
        minimumCopies: 2,
        prefix: "signify-recovery",
        includeLocalMedia: true,
      },
    };
  let db = openDatabase(config.databasePath);
  const operations = createApplicationOperations({
      config,
      db,
      version: "test",
    }),
    backups = [];
  for (let index = 0; index < 4; index += 1) {
    const backup = operations.createBackup(),
      file = operations.managedFile(backup.name);
    backups.push(file);
    const old = new Date(Date.now() - (10 + index) * 86400000);
    fs.utimesSync(file, old, old);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const local = createRecoveryManager(config),
    removed = local.pruneLocal();
  assert.equal(removed.length, 2);
  assert.equal(operations.listBackups().length, 2);
  const localDrill = await local.drill();
  assert.equal(localDrill.status, "passed");
  assert.equal(localDrill.sha256.length, 64);

  const mediaDirectory = path.join(config.publicRoot, "uploads", "tenant-1");
  fs.mkdirSync(mediaDirectory, { recursive: true });
  fs.writeFileSync(path.join(mediaDirectory, "logo.png"), "sandbox-media");
  const source = operations.managedFile(operations.listBackups()[0].name),
    objects = new Map(),
    deleted = [],
    s3Client = {
      async send(command) {
        const input = command.input;
        if (command.constructor.name === "GetBucketVersioningCommand")
          return { Status: "Enabled" };
        if (command.constructor.name === "PutObjectCommand") {
          objects.set(input.Key, {
            body: await streamBuffer(input.Body),
            metadata: input.Metadata,
            modified: new Date(),
          });
          assert.equal(input.ServerSideEncryption, "AES256");
          assert(input.ChecksumSHA256);
          return {};
        }
        if (command.constructor.name === "ListObjectsV2Command")
          return {
            Contents: [...objects]
              .filter(([Key]) => Key.startsWith(input.Prefix || ""))
              .map(([Key, value]) => ({
                Key,
                Size: value.body.length,
                LastModified: value.modified,
              })),
            IsTruncated: false,
          };
        if (command.constructor.name === "GetObjectCommand") {
          const value = objects.get(input.Key);
          return {
            Body: {
              async transformToByteArray() {
                return value.body;
              },
            },
            Metadata: value.metadata,
          };
        }
        if (command.constructor.name === "DeleteObjectsCommand") {
          deleted.push(...input.Delete.Objects.map((item) => item.Key));
          return {};
        }
        throw new Error(`Unexpected command ${command.constructor.name}`);
      },
    },
    s3Config = {
      ...config,
      recovery: {
        mode: "s3",
        retentionDays: 30,
        minimumCopies: 1,
        bucket: "private-backups",
        region: "us-east-1",
        endpoint: "",
        prefix: "signify-recovery",
        forcePathStyle: false,
        accessKeyId: "",
        secretAccessKey: "",
        includeLocalMedia: true,
      },
    },
    offsite = createRecoveryManager(s3Config, { s3Client }),
    protectedBackup = await offsite.protect(source);
  assert.equal(protectedBackup.sha256, checksum(source));
  assert.equal(protectedBackup.offsite.bucket, "private-backups");
  assert.equal(protectedBackup.media.files, 1);
  assert(
    [...objects.keys()].some((key) =>
      key.endsWith("/media/uploads/tenant-1/logo.png"),
    ),
  );
  assert.equal((await offsite.listOffsite()).length, 1);
  assert.equal((await offsite.drill()).status, "passed");
  assert.equal(deleted.length, 0);

  db.close();
  db = null;
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  console.log(
    "Recovery test passed: retention, encrypted off-site replication, checksum verification, and restore drill",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
