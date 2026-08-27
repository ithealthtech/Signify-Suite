"use strict";

const path = require("node:path");
const { signRelease } = require("../server/release-signature.cjs");

const artifact = path.resolve(process.argv[2] || "dist"),
  result = signRelease(
    artifact,
    process.env.SIGNIFY_RELEASE_SIGNING_PRIVATE_KEY,
    process.env.SIGNIFY_RELEASE_SIGNING_KEY_ID,
  );
process.stdout.write(
  `${JSON.stringify({ event: "release.signed", keyId: result.keyId, artifact })}\n`,
);
