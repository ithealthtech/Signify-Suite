"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

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
  "worker.cjs",
  "package.json",
  ".env.example",
  "scripts/setup.cjs",
  "docs/OPERATIONS.md",
  "docs/SAAS-READINESS.md",
  "docs/sbom.cdx.json",
  "manifest.json",
  "checksums.txt",
  "public/signature-it-banner.png",
])
  if (!relativeFiles.includes(required))
    throw new Error(`Production artifact is missing ${required}.`);

const manifest = JSON.parse(
    fs.readFileSync(path.join(artifact, "manifest.json"), "utf8"),
  ),
  packageMetadata = JSON.parse(
    fs.readFileSync(path.join(artifact, "package.json"), "utf8"),
  ),
  migrationFiles = relativeFiles
    .filter((file) => /^server\/migrations\/\d+.*\.sql$/.test(file))
    .sort();
if (
  manifest.schemaVersion !== 1 ||
  manifest.name !== packageMetadata.name ||
  manifest.version !== packageMetadata.version ||
  manifest.node !== packageMetadata.engines.node ||
  !/^\d{4}-\d{2}-\d{2}T/.test(manifest.builtAt) ||
  !(manifest.commit === "unknown" || /^[0-9a-f]{40}$/i.test(manifest.commit))
)
  throw new Error("Production manifest metadata is invalid.");
if (
  JSON.stringify(manifest.migrations.map((item) => item.version)) !==
  JSON.stringify(migrationFiles.map((file) => path.basename(file)))
)
  throw new Error("Production manifest migration history is incomplete.");
for (const migration of manifest.migrations) {
  const file = path.join(artifact, "server", "migrations", migration.version),
    digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (digest !== migration.sha256)
    throw new Error(`Migration checksum mismatch: ${migration.version}`);
}

const checksumLines = fs
    .readFileSync(path.join(artifact, "checksums.txt"), "utf8")
    .trim()
    .split("\n"),
  checksumEntries = new Map(
    checksumLines.map((line) => {
      const match = line.match(/^([0-9a-f]{64})  (.+)$/);
      if (!match) throw new Error(`Invalid checksum entry: ${line}`);
      return [match[2], match[1]];
    }),
  ),
  expectedChecksums = relativeFiles
    .filter((file) => file !== "checksums.txt")
    .sort();
if (
  JSON.stringify([...checksumEntries.keys()].sort()) !==
  JSON.stringify(expectedChecksums)
)
  throw new Error("Artifact checksum inventory is incomplete.");
for (const [file, expected] of checksumEntries) {
  const actual = createHash("sha256")
    .update(fs.readFileSync(path.join(artifact, file)))
    .digest("hex");
  if (actual !== expected)
    throw new Error(`Artifact checksum mismatch: ${file}`);
}

const example = fs.readFileSync(path.join(artifact, ".env.example"), "utf8"),
  populatedSecret = example.match(
    /^(?:MICROSOFT_CLIENT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SIGNIFY_CREDENTIAL_ENCRYPTION_KEY)=(?!\s*$).+/m,
  );
if (populatedSecret)
  throw new Error(
    `Production environment example contains a populated secret: ${populatedSecret[0].split("=")[0]}`,
  );

console.log(
  `Artifact test passed: ${relativeFiles.length} allowlisted files, ${checksumEntries.size} checksums, ${manifest.migrations.length} migrations, empty runtime directories, and no populated provider secrets`,
);
