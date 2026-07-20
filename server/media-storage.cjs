"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

function tenantComponent(value) {
  const component = String(value || "");
  if (!/^[a-z0-9_-]{1,100}$/i.test(component))
    throw Object.assign(new Error("Invalid tenant storage identifier."), {
      status: 400,
      code: "TENANT_STORAGE_INVALID",
    });
  return component;
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .reduce((total, entry) => {
      const target = path.join(directory, entry.name);
      return (
        total +
        (entry.isDirectory()
          ? directoryBytes(target)
          : fs.statSync(target).size)
      );
    }, 0);
}

function tenantUsage(publicRoot, organizationId) {
  const tenant = tenantComponent(organizationId);
  return ["uploads", "generated-banners"].reduce(
    (total, kind) =>
      total + directoryBytes(path.join(publicRoot, kind, tenant)),
    0,
  );
}

function writeTenantMedia({
  publicRoot,
  organizationId,
  collection,
  name,
  bytes,
  limitBytes,
}) {
  if (!["uploads", "generated-banners"].includes(collection))
    throw new Error("Unsupported media collection.");
  const tenant = tenantComponent(organizationId),
    currentBytes = tenantUsage(publicRoot, tenant);
  if (currentBytes + bytes.length > limitBytes)
    throw Object.assign(new Error("Tenant media storage limit reached."), {
      status: 413,
      code: "MEDIA_STORAGE_LIMIT",
      usageBytes: currentBytes,
      limitBytes,
    });
  const directory = path.join(publicRoot, collection, tenant),
    destination = path.join(directory, name),
    temporary = path.join(directory, `.${randomUUID()}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
  return {
    url: `/${collection}/${tenant}/${name}`,
    storedBytes: bytes.length,
    usageBytes: currentBytes + bytes.length,
    limitBytes,
  };
}

function cleanupOrphanMedia(db, publicRoot, olderThanDays = 7) {
  const references = new Set(),
    addReferences = (value) => {
      for (const match of String(value || "").matchAll(
        /\/(?:uploads|generated-banners)\/[a-z0-9_-]+\/[a-z0-9_.-]+/gi,
      ))
        references.add(match[0]);
    };
  for (const row of db
    .prepare("SELECT signature_json FROM organization_memberships")
    .all())
    addReferences(row.signature_json);
  for (const row of db
    .prepare("SELECT image_url FROM signature_campaigns")
    .all())
    addReferences(row.image_url);
  for (const row of db.prepare("SELECT settings_json FROM organizations").all())
    addReferences(row.settings_json);
  const cutoff = Date.now() - Math.max(1, olderThanDays) * 86400000;
  let removedFiles = 0,
    removedBytes = 0;
  for (const collection of ["uploads", "generated-banners"]) {
    const root = path.join(publicRoot, collection);
    if (!fs.existsSync(root)) continue;
    for (const tenant of fs.readdirSync(root, { withFileTypes: true })) {
      if (!tenant.isDirectory()) continue;
      const directory = path.join(root, tenant.name);
      for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || file.name.startsWith(".")) continue;
        const target = path.join(directory, file.name),
          stat = fs.statSync(target),
          url = `/${collection}/${tenant.name}/${file.name}`;
        if (!references.has(url) && stat.mtimeMs < cutoff) {
          fs.rmSync(target, { force: true });
          removedFiles += 1;
          removedBytes += stat.size;
        }
      }
    }
  }
  return { removedFiles, removedBytes };
}

function mediaKey(collection, organizationId, name) {
  if (!["uploads", "generated-banners"].includes(collection))
    throw new Error("Unsupported media collection.");
  const tenant = tenantComponent(organizationId);
  if (!/^[a-z0-9_.-]{1,180}$/i.test(String(name || "")))
    throw Object.assign(new Error("Invalid media object name."), {
      status: 400,
      code: "MEDIA_NAME_INVALID",
    });
  return `${collection}/${tenant}/${name}`;
}

function contentType(name) {
  const extension = path.extname(name).toLowerCase();
  return (
    {
      ".gif": "image/gif",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extension] || "application/octet-stream"
  );
}

function createLocalMediaStorage({ publicRoot }) {
  return Object.freeze({
    mode: "local",
    async write(input) {
      return writeTenantMedia({ publicRoot, ...input });
    },
    async cleanup(db, olderThanDays = 7) {
      return cleanupOrphanMedia(db, publicRoot, olderThanDays);
    },
    async signedReadUrl({ collection, organizationId, name }) {
      return `/${mediaKey(collection, organizationId, name)}`;
    },
  });
}

function createS3MediaStorage({ s3, client, presign = getSignedUrl }) {
  const s3Client =
    client ||
    new S3Client({
      region: s3.region,
      endpoint: s3.endpoint || undefined,
      forcePathStyle: s3.forcePathStyle,
      credentials:
        s3.accessKeyId && s3.secretAccessKey
          ? {
              accessKeyId: s3.accessKeyId,
              secretAccessKey: s3.secretAccessKey,
            }
          : undefined,
    });
  async function objects(prefix = "") {
    const rows = [];
    let continuationToken;
    do {
      const page = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: s3.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      rows.push(...(page.Contents || []));
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return rows;
  }
  return Object.freeze({
    mode: "s3",
    async write({ organizationId, collection, name, bytes, limitBytes }) {
      const key = mediaKey(collection, organizationId, name),
        tenant = tenantComponent(organizationId),
        existing = await Promise.all([
          objects(`uploads/${tenant}/`),
          objects(`generated-banners/${tenant}/`),
        ]),
        existingObjects = existing.flat(),
        usageBytes = existingObjects.reduce(
          (total, item) => total + Number(item.Size || 0),
          0,
        ),
        replacedBytes = Number(
          existingObjects.find((item) => item.Key === key)?.Size || 0,
        ),
        projectedUsage = usageBytes - replacedBytes + bytes.length;
      if (projectedUsage > limitBytes)
        throw Object.assign(new Error("Tenant media storage limit reached."), {
          status: 413,
          code: "MEDIA_STORAGE_LIMIT",
          usageBytes,
          limitBytes,
        });
      await s3Client.send(
        new PutObjectCommand({
          Bucket: s3.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType(name),
          CacheControl: "public, max-age=31536000, immutable",
          ServerSideEncryption: "AES256",
          Metadata: { tenant },
        }),
      );
      return {
        url: `/${key}`,
        storedBytes: bytes.length,
        usageBytes: projectedUsage,
        limitBytes,
      };
    },
    async read({ collection, organizationId, name }) {
      const result = await s3Client.send(
        new GetObjectCommand({
          Bucket: s3.bucket,
          Key: mediaKey(collection, organizationId, name),
        }),
      );
      return {
        body: result.Body,
        contentLength: result.ContentLength,
        contentType: result.ContentType || contentType(name),
        cacheControl:
          result.CacheControl || "public, max-age=31536000, immutable",
      };
    },
    async signedReadUrl({ collection, organizationId, name, expiresIn = 300 }) {
      return presign(
        s3Client,
        new GetObjectCommand({
          Bucket: s3.bucket,
          Key: mediaKey(collection, organizationId, name),
        }),
        { expiresIn: Math.min(3600, Math.max(60, Number(expiresIn) || 300)) },
      );
    },
    async cleanup(db, olderThanDays = 7) {
      const references = new Set(),
        addReferences = (value) => {
          for (const match of String(value || "").matchAll(
            /\/(uploads|generated-banners)\/([a-z0-9_-]+)\/([a-z0-9_.-]+)/gi,
          ))
            references.add(`${match[1]}/${match[2]}/${match[3]}`);
        };
      for (const row of db
        .prepare("SELECT signature_json FROM organization_memberships")
        .all())
        addReferences(row.signature_json);
      for (const row of db
        .prepare("SELECT image_url FROM signature_campaigns")
        .all())
        addReferences(row.image_url);
      for (const row of db
        .prepare("SELECT settings_json FROM organizations")
        .all())
        addReferences(row.settings_json);
      const cutoff = Date.now() - Math.max(1, olderThanDays) * 86400000,
        candidates = (await objects()).filter(
          (item) =>
            /^(uploads|generated-banners)\//.test(item.Key || "") &&
            !references.has(item.Key) &&
            new Date(item.LastModified || 0).valueOf() < cutoff,
        );
      if (candidates.length)
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: s3.bucket,
            Delete: {
              Objects: candidates.map((item) => ({ Key: item.Key })),
              Quiet: true,
            },
          }),
        );
      return {
        removedFiles: candidates.length,
        removedBytes: candidates.reduce(
          (total, item) => total + Number(item.Size || 0),
          0,
        ),
      };
    },
  });
}

function createMediaStorage(config, options = {}) {
  return config.mediaStorage === "s3"
    ? createS3MediaStorage({ s3: config.s3, client: options.s3Client })
    : createLocalMediaStorage({ publicRoot: config.publicRoot });
}

module.exports = {
  cleanupOrphanMedia,
  createLocalMediaStorage,
  createMediaStorage,
  createS3MediaStorage,
  directoryBytes,
  mediaKey,
  tenantUsage,
  writeTenantMedia,
};
