"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

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

module.exports = {
  cleanupOrphanMedia,
  directoryBytes,
  tenantUsage,
  writeTenantMedia,
};
