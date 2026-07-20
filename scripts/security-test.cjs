"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { scanText } = require("../server/secret-scanner.cjs");

assert.equal(scanText("ordinary source text").length, 0);
assert.equal(
  scanText(
    `-----BEGIN ${"PRIVATE"} KEY-----\nnot-real\n-----END PRIVATE KEY-----`,
  )[0].type,
  "private key",
);
assert.equal(
  scanText(`sk_live_${"A".repeat(24)}`)[0].type,
  "Stripe live secret",
);
assert.equal(scanText(`AKIA${"A".repeat(16)}`)[0].type, "AWS access key");

for (const required of [
  "SECURITY.md",
  "docs/ASVS-REVIEW.md",
  "docs/DATA-RETENTION.md",
  "docs/INCIDENT-RESPONSE.md",
  "docs/PRIVACY.md",
  "docs/SUBPROCESSORS.md",
  "docs/TERMS.md",
])
  assert(
    fs.existsSync(path.join(__dirname, "..", required)),
    `${required} is missing`,
  );

console.log(
  "Security test passed: high-confidence secret patterns and required governance controls",
);
