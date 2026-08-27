"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync } = require("node:crypto");
const {
  signRelease,
  verifyReleaseSignature,
} = require("../server/release-signature.cjs");

const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "signify-release-signature-"),
  ),
  { privateKey, publicKey } = generateKeyPairSync("ed25519"),
  privatePem = privateKey.export({ type: "pkcs8", format: "pem" }),
  publicPem = publicKey.export({ type: "spki", format: "pem" });
try {
  fs.writeFileSync(path.join(directory, "checksums.txt"), "abc  server.cjs\n");
  signRelease(directory, privatePem, "test-2026");
  assert.equal(verifyReleaseSignature(directory, publicPem).keyId, "test-2026");
  fs.appendFileSync(path.join(directory, "checksums.txt"), "tampered\n");
  assert.throws(
    () => verifyReleaseSignature(directory, publicPem),
    /verification failed/,
  );
  fs.rmSync(path.join(directory, "release-signature.json"));
  assert.throws(
    () => verifyReleaseSignature(directory, publicPem),
    /signature is missing/,
  );
  console.log(
    "Release signature tests passed: signing, verification, tamper rejection, and required signature",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
