"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, ".."),
  destination = path.join(root, "dist"),
  publicFiles = [
    "public/signature-it-banner.png",
    "public/event-banners/backup-disaster-recovery-webinar.png",
    "public/event-banners/cloud-services-modernization.png",
    "public/event-banners/cybersecurity-readiness-event.png",
    "public/event-banners/executive-it-strategy-session.png",
    "public/event-banners/healthcare-professional-services-it.png",
    "public/event-banners/it-health-check-network-assessment.png",
    "public/event-banners/managed-it-services-assessment.png",
    "public/event-banners/proactive-monitoring-support.png",
    "public/icons/address.png",
    "public/icons/email.png",
    "public/icons/facebook.png",
    "public/icons/instagram.png",
    "public/icons/linkedin.png",
    "public/icons/mobile.png",
    "public/icons/phone.png",
    "public/icons/twitter.png",
    "public/icons/web.png",
    "public/icons/website.png",
  ],
  entries = [
    "server.cjs",
    "worker.cjs",
    "package.json",
    "package-lock.json",
    ".env.example",
    "README.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "DEPLOYMENT.md",
    "docs/OPERATIONS.md",
    "docs/OBSERVABILITY.md",
    "docs/ASVS-REVIEW.md",
    "docs/DATA-RETENTION.md",
    "docs/INCIDENT-RESPONSE.md",
    "docs/PRIVACY.md",
    "docs/SUBPROCESSORS.md",
    "docs/TERMS.md",
    "docs/SAAS-READINESS.md",
    "docs/sbom.cdx.json",
    "signature.html",
    "signature.css",
    "signature.js",
    "admin.html",
    "admin.css",
    "admin.js",
    "platform.html",
    "platform.css",
    "platform.js",
    "signify-shared.js",
    "signify-shared.css",
    "server",
    ...publicFiles,
    "scripts/backup.cjs",
    "scripts/access-review.cjs",
    "scripts/deploy-release.cjs",
    "scripts/recovery-drill.cjs",
    "scripts/grant-application-owner.cjs",
    "scripts/migrate-media-to-s3.cjs",
    "scripts/postgres-migrate.cjs",
    "scripts/postgres-import.cjs",
    "scripts/postgres-test.cjs",
    "scripts/migrate.cjs",
    "scripts/doctor.cjs",
    "scripts/worker-health.cjs",
    "scripts/reset-signature-admin.cjs",
    "scripts/rotate-integration-credentials.cjs",
    "scripts/setup.cjs",
    "scripts/verify-provider-integrations.cjs",
    "start-production.cmd",
  ];

for (const entry of entries) {
  if (!fs.existsSync(path.join(root, entry)))
    throw new Error(`Required release file is missing: ${entry}`);
}
fs.rmSync(destination, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 250,
});
fs.mkdirSync(destination, { recursive: true });
for (const entry of entries) {
  const source = path.join(root, entry),
    target = path.join(destination, entry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
for (const directory of [
  "data",
  "backups",
  "public/uploads",
  "public/generated-banners",
])
  fs.mkdirSync(path.join(destination, directory), { recursive: true });
fs.writeFileSync(
  path.join(destination, "public/generated-banners/.gitkeep"),
  "",
);

function releaseFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? releaseFiles(absolute) : [absolute];
    })
    .sort();
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function commitSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ),
  sourceDate = Number(process.env.SOURCE_DATE_EPOCH || 0),
  builtAt = sourceDate
    ? new Date(sourceDate * 1000).toISOString()
    : new Date().toISOString(),
  sqliteMigrations = releaseFiles(
    path.join(destination, "server", "migrations"),
  )
    .filter((file) => file.endsWith(".sql"))
    .map((file) => ({
      version: path.basename(file),
      sha256: sha256(file),
    })),
  manifest = {
    schemaVersion: 1,
    name: packageMetadata.name,
    version: packageMetadata.version,
    commit: commitSha(),
    builtAt,
    node: packageMetadata.engines.node,
    migrations: {
      sqlite: sqliteMigrations,
      postgres: releaseFiles(
        path.join(destination, "server", "postgres", "migrations"),
      )
        .filter((file) => file.endsWith(".sql"))
        .map((file) => ({
          version: path.basename(file),
          sha256: sha256(file),
        })),
    },
  };
fs.writeFileSync(
  path.join(destination, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksums = releaseFiles(destination)
  .filter((file) => path.basename(file) !== "checksums.txt")
  .map(
    (file) =>
      `${sha256(file)}  ${path.relative(destination, file).replaceAll(path.sep, "/")}`,
  );
fs.writeFileSync(
  path.join(destination, "checksums.txt"),
  `${checksums.join("\n")}\n`,
);
console.log(
  `Production artifact ${packageMetadata.version} created at ${destination} with ${checksums.length} verified files`,
);
