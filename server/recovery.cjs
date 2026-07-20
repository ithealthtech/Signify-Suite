"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { validateBackup } = require("./application-operations.cjs");

function checksum(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function bodyBuffer(body) {
  if (typeof body?.transformToByteArray === "function")
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createRecoveryManager(config, options = {}) {
  const recovery = config.recovery,
    migrationsDirectory = path.join(config.sourceRoot, "server", "migrations"),
    client =
      recovery.mode === "s3"
        ? options.s3Client ||
          new S3Client({
            region: recovery.region,
            endpoint: recovery.endpoint || undefined,
            forcePathStyle: recovery.forcePathStyle,
            credentials: recovery.accessKeyId
              ? {
                  accessKeyId: recovery.accessKeyId,
                  secretAccessKey: recovery.secretAccessKey,
                }
              : undefined,
          })
        : null;

  function pruneLocal() {
    const files = fs
        .readdirSync(config.backupPath)
        .filter(
          (name) =>
            /^signify-creator-[\w.-]+\.db$/.test(name) &&
            !name.includes("pre-restore"),
        )
        .map((name) => ({
          name,
          file: path.join(config.backupPath, name),
          modified: fs.statSync(path.join(config.backupPath, name)).mtimeMs,
        }))
        .sort((a, b) => b.modified - a.modified),
      cutoff = Date.now() - recovery.retentionDays * 86400000,
      removed = [];
    for (const [index, item] of files.entries()) {
      if (index < recovery.minimumCopies || item.modified >= cutoff) continue;
      fs.rmSync(item.file);
      removed.push(item.name);
    }
    return removed;
  }

  async function assertVersioning() {
    if (!client) return;
    const versioning = await client.send(
      new GetBucketVersioningCommand({ Bucket: recovery.bucket }),
    );
    if (versioning.Status !== "Enabled")
      throw new Error(
        "Off-site backup bucket versioning must be enabled before backups run.",
      );
  }

  async function listOffsite() {
    if (!client) return [];
    const found = [];
    let token;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: recovery.bucket,
          Prefix: `${recovery.prefix}/database/`,
          ContinuationToken: token,
        }),
      );
      found.push(...(response.Contents || []));
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token);
    return found.sort(
      (a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0),
    );
  }

  async function replicate(file) {
    if (!client) return null;
    const digest = checksum(file),
      key = `${recovery.prefix}/database/${path.basename(file)}`;
    await client.send(
      new PutObjectCommand({
        Bucket: recovery.bucket,
        Key: key,
        Body: fs.createReadStream(file),
        ContentType: "application/vnd.sqlite3",
        ServerSideEncryption: "AES256",
        ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
        Metadata: { sha256: digest, schema: "signify-sqlite-v1" },
      }),
    );
    return { bucket: recovery.bucket, key, sha256: digest };
  }

  async function replicateMedia() {
    if (!client || !recovery.includeLocalMedia) return { files: 0, bytes: 0 };
    let files = 0,
      bytes = 0;
    for (const collection of ["uploads", "generated-banners"]) {
      const root = path.join(config.publicRoot, collection);
      if (!fs.existsSync(root)) continue;
      const visit = async (directory) => {
        for (const entry of fs.readdirSync(directory, {
          withFileTypes: true,
        })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) await visit(absolute);
          else if (entry.isFile()) {
            const relative = path
                .relative(root, absolute)
                .split(path.sep)
                .join("/"),
              digest = checksum(absolute),
              size = fs.statSync(absolute).size;
            await client.send(
              new PutObjectCommand({
                Bucket: recovery.bucket,
                Key: `${recovery.prefix}/media/${collection}/${relative}`,
                Body: fs.createReadStream(absolute),
                ContentType: "application/octet-stream",
                ServerSideEncryption: "AES256",
                ChecksumSHA256: Buffer.from(digest, "hex").toString("base64"),
                Metadata: { sha256: digest, collection },
              }),
            );
            files += 1;
            bytes += size;
          }
        }
      };
      await visit(root);
    }
    return { files, bytes };
  }

  async function pruneOffsite() {
    if (!client) return [];
    const objects = await listOffsite(),
      cutoff = Date.now() - recovery.retentionDays * 86400000,
      expired = objects.filter(
        (item, index) =>
          index >= recovery.minimumCopies &&
          new Date(item.LastModified || 0).getTime() < cutoff,
      );
    for (let offset = 0; offset < expired.length; offset += 1000)
      await client.send(
        new DeleteObjectsCommand({
          Bucket: recovery.bucket,
          Delete: {
            Objects: expired
              .slice(offset, offset + 1000)
              .map((item) => ({ Key: item.Key })),
            Quiet: true,
          },
        }),
      );
    return expired.map((item) => item.Key);
  }

  async function protect(file) {
    validateBackup(file, migrationsDirectory);
    await assertVersioning();
    const offsite = await replicate(file),
      media = await replicateMedia(),
      removedLocal = pruneLocal(),
      removedOffsite = await pruneOffsite();
    return {
      file,
      sha256: checksum(file),
      offsite,
      media,
      removedLocal,
      removedOffsite,
    };
  }

  async function drill() {
    const temporary = fs.mkdtempSync(
      path.join(os.tmpdir(), "signify-recovery-drill-"),
    );
    try {
      let candidate, expected;
      if (client) {
        const latest = (await listOffsite())[0];
        if (!latest)
          throw new Error("No off-site database recovery point exists.");
        const response = await client.send(
          new GetObjectCommand({ Bucket: recovery.bucket, Key: latest.Key }),
        );
        candidate = path.join(temporary, path.basename(latest.Key));
        fs.writeFileSync(candidate, await bodyBuffer(response.Body));
        expected = response.Metadata?.sha256 || "";
      } else {
        const latest = fs
          .readdirSync(config.backupPath)
          .filter((name) => /^signify-creator-[\w.-]+\.db$/.test(name))
          .map((name) => path.join(config.backupPath, name))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        if (!latest)
          throw new Error("No local database recovery point exists.");
        candidate = path.join(temporary, path.basename(latest));
        fs.copyFileSync(latest, candidate);
      }
      validateBackup(candidate, migrationsDirectory);
      const actual = checksum(candidate);
      if (expected && actual !== expected)
        throw new Error(
          "Recovery point checksum does not match its stored metadata.",
        );
      return {
        status: "passed",
        name: path.basename(candidate),
        sha256: actual,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      fs.rmSync(temporary, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }

  return Object.freeze({
    assertVersioning,
    drill,
    listOffsite,
    protect,
    pruneLocal,
    pruneOffsite,
    replicate,
    replicateMedia,
  });
}

module.exports = { checksum, createRecoveryManager };
