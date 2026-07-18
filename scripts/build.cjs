"use strict";
const fs = require("node:fs");
const path = require("node:path");

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
    "package.json",
    "package-lock.json",
    ".env.example",
    "README.md",
    "CHANGELOG.md",
    "DEPLOYMENT.md",
    "signature.html",
    "signature.css",
    "signature.js",
    "admin.html",
    "admin.css",
    "admin.js",
    "platform.html",
    "platform.css",
    "platform.js",
    "server",
    ...publicFiles,
    "scripts/backup.cjs",
    "scripts/grant-application-owner.cjs",
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
console.log(`Production artifact created at ${destination}`);
