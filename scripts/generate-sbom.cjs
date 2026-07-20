"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const npmCli =
    process.env.npm_execpath ||
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
  result = spawnSync(
    process.execPath,
    [npmCli, "sbom", "--sbom-format", "cyclonedx", "--omit=dev"],
    { cwd: path.join(__dirname, ".."), encoding: "utf8" },
  );

if (result.status !== 0) throw new Error(result.stderr || result.stdout);
const root = path.join(__dirname, ".."),
  packageMetadata = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ),
  sbom = JSON.parse(result.stdout),
  output = path.join(root, "docs", "sbom.cdx.json");
const lockDigest = createHash("sha256")
    .update(fs.readFileSync(path.join(root, "package-lock.json")))
    .digest("hex"),
  uuidHex = `${lockDigest.slice(0, 12)}5${lockDigest.slice(13, 16)}a${lockDigest.slice(17, 32)}`;
sbom.serialNumber = `urn:uuid:${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
sbom.metadata.timestamp = new Date(
  Math.max(0, Number(process.env.SOURCE_DATE_EPOCH || 0)) * 1000,
).toISOString();
sbom.metadata.component.name = packageMetadata.name;
sbom.metadata.component.version = packageMetadata.version;
sbom.metadata.component.type = "application";
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Production SBOM written to ${output}`);
