"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} = require("node:crypto");

const SIGNATURE_FILE = "release-signature.json";

function normalizedKey(value) {
  return String(value || "")
    .replaceAll("\\n", "\n")
    .trim();
}

function signRelease(artifact, privateKey, keyId) {
  const root = path.resolve(artifact),
    checksums = fs.readFileSync(path.join(root, "checksums.txt")),
    signingKey = createPrivateKey(normalizedKey(privateKey));
  if (signingKey.asymmetricKeyType !== "ed25519")
    throw new Error("Release signing requires an Ed25519 private key.");
  const id = String(keyId || "").trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(id))
    throw new Error("SIGNIFY_RELEASE_SIGNING_KEY_ID is invalid.");
  const payload = {
    schemaVersion: 1,
    algorithm: "Ed25519",
    keyId: id,
    signedFile: "checksums.txt",
    signature: sign(null, checksums, signingKey).toString("base64url"),
  };
  fs.writeFileSync(
    path.join(root, SIGNATURE_FILE),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  return payload;
}

function verifyReleaseSignature(artifact, publicKey, { required = true } = {}) {
  const root = path.resolve(artifact),
    file = path.join(root, SIGNATURE_FILE);
  if (!fs.existsSync(file)) {
    if (required) throw new Error("Release signature is missing.");
    return null;
  }
  const keyValue = normalizedKey(publicKey);
  if (!keyValue)
    throw new Error("Release signature verification key is missing.");
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    payload.schemaVersion !== 1 ||
    payload.algorithm !== "Ed25519" ||
    payload.signedFile !== "checksums.txt" ||
    !/^[a-zA-Z0-9._-]{3,80}$/.test(String(payload.keyId || ""))
  )
    throw new Error("Release signature metadata is invalid.");
  const verificationKey = createPublicKey(keyValue);
  if (verificationKey.asymmetricKeyType !== "ed25519")
    throw new Error(
      "Release signature verification requires an Ed25519 public key.",
    );
  if (
    !verify(
      null,
      fs.readFileSync(path.join(root, payload.signedFile)),
      verificationKey,
      Buffer.from(String(payload.signature || ""), "base64url"),
    )
  )
    throw new Error("Release signature verification failed.");
  return payload;
}

module.exports = { SIGNATURE_FILE, signRelease, verifyReleaseSignature };
