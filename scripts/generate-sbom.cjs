"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

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
sbom.metadata.component.name = packageMetadata.name;
sbom.metadata.component.version = packageMetadata.version;
sbom.metadata.component.type = "application";
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Production SBOM written to ${output}`);
