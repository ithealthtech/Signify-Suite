"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, ".."),
  artifact = path.join(root, "dist");

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? files(absolute) : [absolute];
  });
}

if (!fs.existsSync(artifact))
  throw new Error(
    "Production artifact does not exist. Run npm run build first.",
  );

const artifactFiles = files(artifact),
  relativeFiles = artifactFiles.map((file) =>
    path.relative(artifact, file).replaceAll(path.sep, "/"),
  ),
  forbidden = relativeFiles.filter(
    (file) =>
      file.startsWith("public/uploads/") ||
      (file.startsWith("public/generated-banners/") &&
        file !== "public/generated-banners/.gitkeep") ||
      file.startsWith("data/") ||
      file.startsWith("backups/") ||
      /(^|\/)(node_modules|tmp)(\/|$)/.test(file) ||
      /(^|\/)(\.env|\.env\.local)$/.test(file) ||
      /\.(db|sqlite|sqlite3|log|zip)$/i.test(file),
  );
if (forbidden.length)
  throw new Error(
    `Production artifact contains runtime or private files: ${forbidden.join(", ")}`,
  );

for (const required of [
  "server.cjs",
  "package.json",
  ".env.example",
  "scripts/setup.cjs",
  "public/signature-it-banner.png",
])
  if (!relativeFiles.includes(required))
    throw new Error(`Production artifact is missing ${required}.`);

const example = fs.readFileSync(path.join(artifact, ".env.example"), "utf8"),
  populatedSecret = example.match(
    /^(?:MICROSOFT_CLIENT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SIGNIFY_CREDENTIAL_ENCRYPTION_KEY)=(?!\s*$).+/m,
  );
if (populatedSecret)
  throw new Error(
    `Production environment example contains a populated secret: ${populatedSecret[0].split("=")[0]}`,
  );

console.log(
  `Artifact test passed: ${relativeFiles.length} allowlisted files, empty runtime directories, and no populated provider secrets`,
);
