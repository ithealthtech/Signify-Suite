"use strict";

const path = require("node:path");
const { verifyReleaseSignature } = require("../server/release-signature.cjs");

const artifact = path.resolve(process.argv[2] || "dist"),
  result = verifyReleaseSignature(
    artifact,
    process.env.SIGNIFY_RELEASE_SIGNING_PUBLIC_KEY,
  );
process.stdout.write(
  `${JSON.stringify({ event: "release.signature_verified", keyId: result.keyId, artifact })}\n`,
);
