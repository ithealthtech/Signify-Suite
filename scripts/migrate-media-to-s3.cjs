"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { loadConfig } = require("../server/config.cjs");
const { createMediaStorage } = require("../server/media-storage.cjs");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function bodyBytes(body) {
  if (typeof body?.transformToByteArray === "function")
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function localMediaFiles(publicRoot) {
  const files = [];
  for (const collection of ["uploads", "generated-banners"]) {
    const root = path.join(publicRoot, collection);
    if (!fs.existsSync(root)) continue;
    for (const tenant of fs.readdirSync(root, { withFileTypes: true })) {
      if (!tenant.isDirectory() || !/^[a-z0-9_-]{1,100}$/i.test(tenant.name))
        continue;
      const directory = path.join(root, tenant.name);
      for (const item of fs.readdirSync(directory, { withFileTypes: true }))
        if (item.isFile() && !item.name.startsWith("."))
          files.push({
            collection,
            organizationId: tenant.name,
            name: item.name,
            file: path.join(directory, item.name),
          });
    }
  }
  return files;
}

async function migrateMedia({
  publicRoot,
  storage,
  limitBytes,
  deleteSource = false,
}) {
  const files = localMediaFiles(publicRoot),
    result = { discovered: files.length, copied: 0, bytes: 0, deleted: 0 };
  for (const item of files) {
    const bytes = fs.readFileSync(item.file),
      expected = digest(bytes);
    await storage.write({
      organizationId: item.organizationId,
      collection: item.collection,
      name: item.name,
      bytes,
      limitBytes,
    });
    const remote = await storage.read(item),
      actual = digest(await bodyBytes(remote.body));
    if (actual !== expected)
      throw new Error(
        `Object verification failed for ${item.collection}/${item.organizationId}/${item.name}.`,
      );
    result.copied += 1;
    result.bytes += bytes.length;
    if (deleteSource) {
      fs.rmSync(item.file);
      result.deleted += 1;
    }
  }
  return result;
}

async function main() {
  const config = loadConfig();
  if (config.mediaStorage !== "s3")
    throw new Error(
      "Set SIGNIFY_MEDIA_STORAGE=s3 and configure the target bucket before migration.",
    );
  const result = await migrateMedia({
    publicRoot: config.publicRoot,
    storage: createMediaStorage(config),
    limitBytes: config.signature.mediaLimitBytes,
    deleteSource: process.argv.includes("--delete-source"),
  });
  console.log(JSON.stringify({ event: "media.migration_complete", ...result }));
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

module.exports = { bodyBytes, localMediaFiles, migrateMedia };
