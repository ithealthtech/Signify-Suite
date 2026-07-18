"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "docs", "sbom.cdx.json"),
  sbom = JSON.parse(fs.readFileSync(file, "utf8")),
  components = new Map(
    (sbom.components || []).map((component) => [component.name, component]),
  );

assert.equal(sbom.bomFormat, "CycloneDX");
assert.equal(sbom.specVersion, "1.5");
assert.equal(sbom.metadata.component.name, "signify-creator");
assert.equal(sbom.metadata.component.type, "application");
assert.equal(sbom.metadata.component.version, "0.4.0");
for (const dependency of ["gifenc", "qrcode", "sharp", "stripe"])
  assert.ok(components.has(dependency), `SBOM is missing ${dependency}.`);
for (const component of components.values()) {
  assert.ok(
    component.version,
    `SBOM component ${component.name} has no version.`,
  );
  assert.ok(component.purl, `SBOM component ${component.name} has no purl.`);
}

console.log(
  `SBOM test passed: CycloneDX 1.5 with ${components.size} production components`,
);
