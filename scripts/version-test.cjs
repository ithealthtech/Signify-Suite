"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageMetadata = require("../package.json");
const {
  compareVersions,
  normalizeVersion,
  releaseAssets,
  releaseTag,
} = require("../server/version.cjs");

const root = path.join(__dirname, ".."),
  compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8"),
  containerEnv = fs.readFileSync(
    path.join(root, ".env.container.example"),
    "utf8",
  ),
  workflow = fs.readFileSync(
    path.join(root, ".github/workflows/npm-publish-github-packages.yml"),
    "utf8",
  ),
  version = normalizeVersion(packageMetadata.version),
  assets = releaseAssets(version);

assert.equal(releaseTag(version), `v${version}`);
assert.equal(compareVersions("v1.2.0", "1.1.9"), 1);
assert.equal(compareVersions("1.0.0", "v1.0.0"), 0);
assert.throws(() => normalizeVersion("1.0"), /Invalid semantic version/);
assert.match(
  compose,
  new RegExp(`SIGNIFY_VERSION:-${version.replaceAll(".", "\\.")}`),
);
assert.match(containerEnv, new RegExp(`^SIGNIFY_VERSION=${version}$`, "m"));
assert.match(workflow, /Release tag must match package\.json/);
assert.match(
  workflow,
  /signify-creator-\$\{\{ github\.event\.release\.tag_name \}\}\.tar\.gz/,
);
assert.equal(assets.archive, `signify-creator-v${version}.tar.gz`);

console.log(`Version contract passed for ${version} (${assets.archive}).`);
