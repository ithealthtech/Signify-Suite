"use strict";

const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(String(password), salt, 64).toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(String(password), salt, 64),
    expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function cookie(req, name) {
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    try {
      if (decodeURIComponent(item.slice(0, index).trim()) === name)
        return decodeURIComponent(item.slice(index + 1).trim());
    } catch {
      continue;
    }
  }
  return "";
}

function sessionCookie(token, maxAge, secure) {
  return `sig_session=${encodeURIComponent(token || "")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}

function csrfCookie(token, maxAge, secure) {
  return `sig_csrf=${encodeURIComponent(token || "")}; Path=/; SameSite=Strict; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}

function oauthStateCookie(token, maxAge, secure) {
  return `sig_oauth_state=${encodeURIComponent(token || "")}; Path=/auth/microsoft/; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${secure ? " Secure;" : ""}`;
}

function jwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    return parts.length === 3
      ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
      : {};
  } catch {
    return {};
  }
}

module.exports = {
  cookie,
  csrfCookie,
  hashPassword,
  jwtPayload,
  oauthStateCookie,
  sessionCookie,
  tokenHash,
  verifyPassword,
};
