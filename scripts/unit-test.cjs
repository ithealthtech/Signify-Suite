"use strict";

const assert = require("node:assert/strict");
const { createAccessControl } = require("../server/access-control.cjs");
const {
  cookie,
  hashPassword,
  jwtPayload,
  sessionCookie,
  tokenHash,
  verifyPassword,
} = require("../server/auth-security.cjs");
const { redirect, textResponse } = require("../server/http-responses.cjs");
const {
  campaignInput,
  canonicalRole,
  canonicalStatus,
  normalizedBrand,
  signatureInputError,
  validDate,
  validEmail,
  validMediaUrl,
  validUrl,
} = require("../server/validation.cjs");

function responseDouble() {
  return {
    headers: null,
    status: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

const passwordHash = hashPassword("Correct Horse Battery Staple");
assert.equal(
  verifyPassword("Correct Horse Battery Staple", passwordHash),
  true,
);
assert.equal(verifyPassword("incorrect", passwordHash), false);
assert.equal(tokenHash("token"), tokenHash("token"));
assert.notEqual(tokenHash("token"), tokenHash("other"));
assert.deepEqual(jwtPayload("invalid"), {});
assert.equal(
  cookie(
    { headers: { cookie: "first=one; sig_session=hello%20world" } },
    "sig_session",
  ),
  "hello world",
);
assert.match(sessionCookie("token", 60, true), /HttpOnly; SameSite=Lax/);
assert.match(sessionCookie("token", 60, true), / Secure;/);

assert.equal(validEmail("person@example.com"), true);
assert.equal(validEmail("person"), false);
assert.equal(validUrl("https://example.com/path"), true);
assert.equal(validUrl("javascript:alert(1)"), false);
assert.equal(validMediaUrl("/uploads/logo.png"), true);
assert.equal(canonicalRole("owner"), "editor");
assert.equal(canonicalStatus("disabled"), "disabled");
assert.equal(validDate("2026-02-29"), false);
assert.equal(validDate("2028-02-29"), true);
assert.equal(
  signatureInputError({ templateId: "not-a-template" }),
  "Choose an available signature template.",
);
assert.deepEqual(campaignInput({ status: "invalid" }).status, "active");
assert.deepEqual(
  normalizedBrand({
    accent: "invalid",
    font: "invalid",
    logoUrl: "javascript:x",
  }),
  {
    locked: false,
    accent: "#2563eb",
    font: "system",
    companyName: "",
    logoUrl: "",
  },
);

const ownerDb = {
    prepare() {
      return {
        get: (userId) => (userId === "owner" ? { value: 1 } : undefined),
      };
    },
  },
  access = createAccessControl(ownerDb);
assert.equal(access.isApplicationOwner("owner"), true);
assert.equal(access.isApplicationOwner("member"), false);
assert.doesNotThrow(() => access.requireAdmin({ role: "admin" }));
assert.throws(
  () => access.requireAdmin({ role: "editor" }),
  (error) => error.status === 403 && error.code === "ADMIN_REQUIRED",
);
assert.doesNotThrow(() => access.requireEditor({ role: "editor" }));
assert.throws(
  () => access.requireApplicationOwner({ id: "member" }),
  (error) =>
    error.status === 403 && error.code === "APPLICATION_OWNER_REQUIRED",
);

const redirectResponse = responseDouble();
assert.equal(redirect(redirectResponse, "/target"), true);
assert.equal(redirectResponse.status, 302);
assert.equal(redirectResponse.headers.Location, "/target");
const text = responseDouble();
assert.equal(textResponse(text, 200, "hello"), true);
assert.equal(text.status, 200);
assert.equal(text.body.toString(), "hello");
assert.equal(text.headers["Content-Length"], 5);

console.log(
  "Unit tests passed: authentication, authorization, validation, and HTTP responses",
);
