"use strict";

const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function normalizeVersion(value) {
  const match = String(value || "")
    .trim()
    .match(SEMVER);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map(Number),
    b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1)
    if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function releaseTag(version) {
  return `v${normalizeVersion(version)}`;
}

function releaseAssets(version) {
  const tag = releaseTag(version),
    archive = `signify-creator-${tag}.tar.gz`;
  return {
    archive,
    checksum: `${archive}.sha256`,
    signature: "release-signature.json",
  };
}

module.exports = {
  compareVersions,
  normalizeVersion,
  releaseAssets,
  releaseTag,
};
