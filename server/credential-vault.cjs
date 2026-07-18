"use strict";
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} = require("node:crypto");

function decodeKey(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  let key;
  if (/^[0-9a-f]{64}$/i.test(input)) key = Buffer.from(input, "hex");
  else {
    try {
      key = Buffer.from(input, "base64");
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32)
    throw new Error(
      "SIGNIFY_CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.",
    );
  return key;
}

function createCredentialVault(keyMaterial) {
  const key = decodeKey(keyMaterial),
    keyId = key
      ? createHash("sha256").update(key).digest("hex").slice(0, 16)
      : "";

  function requireKey() {
    if (!key) {
      const error = new Error(
        "Credential encryption is not configured. Set SIGNIFY_CREDENTIAL_ENCRYPTION_KEY before storing provider credentials.",
      );
      error.code = "CREDENTIAL_VAULT_NOT_CONFIGURED";
      error.status = 503;
      throw error;
    }
  }

  function encrypt(provider, credentials) {
    requireKey();
    const iv = randomBytes(12),
      context = `signify:integration:${String(provider)}`,
      cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(credentials), "utf8"),
        cipher.final(),
      ]),
      tag = cipher.getAuthTag();
    return [
      "v1",
      keyId,
      iv.toString("base64url"),
      encrypted.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");
  }

  function decrypt(provider, payload) {
    requireKey();
    const [version, storedKeyId, iv, encrypted, tag, extra] = String(
      payload || "",
    ).split(".");
    if (
      version !== "v1" ||
      storedKeyId !== keyId ||
      !iv ||
      !encrypted ||
      !tag ||
      extra
    ) {
      const error = new Error(
        storedKeyId && storedKeyId !== keyId
          ? "Provider credentials were encrypted with a different key."
          : "Provider credential payload is invalid.",
      );
      error.code = "CREDENTIAL_DECRYPT_FAILED";
      throw error;
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(`signify:integration:${String(provider)}`));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(clear.toString("utf8"));
    } catch (cause) {
      const error = new Error("Provider credentials could not be decrypted.");
      error.code = "CREDENTIAL_DECRYPT_FAILED";
      error.cause = cause;
      throw error;
    }
  }

  return { configured: Boolean(key), keyId, encrypt, decrypt };
}

module.exports = { createCredentialVault, decodeKey };
