"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
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
assert.equal(scanText(`re_${"A".repeat(32)}`)[0].type, "Resend API key");

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

const repositoryFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: path.join(__dirname, "..") },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean),
  publisherOnlyFiles = repositoryFiles.filter((file) =>
    /^(?:authority\/|authority-server\.cjs$|authority\.Dockerfile$|\.env\.authority|scripts\/authority-(?:api-)?test\.cjs$|Signify-License-Authority\/)/.test(
      file.replaceAll("\\", "/"),
    ),
  );
assert.deepEqual(
  publisherOnlyFiles,
  [],
  `Publisher-only license authority files must not enter the public repository: ${publisherOnlyFiles.join(", ")}`,
);

const codeqlWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "codeql.yml"),
  "utf8",
);
assert.match(
  codeqlWorkflow,
  /^permissions:\r?\n(?: {2}.+\r?\n)* {2}actions: read$/m,
  "CodeQL requires actions: read to access workflow-run metadata",
);
assert.match(
  codeqlWorkflow,
  /^ {10}upload: never$/m,
  "Private repositories without GitHub Advanced Security must retain SARIF without uploading it",
);
assert.match(
  codeqlWorkflow,
  /^ {8}uses: actions\/upload-artifact@v7$/m,
  "CodeQL SARIF must be retained as a workflow artifact",
);

console.log(
  "Security test passed: high-confidence secret patterns and required governance controls",
);
