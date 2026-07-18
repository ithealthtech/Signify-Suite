"use strict";
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, ".."),
  destination = path.join(root, "dist"),
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
    "public",
    "scripts/backup.cjs",
    "scripts/grant-application-owner.cjs",
    "scripts/reset-signature-admin.cjs",
    "scripts/rotate-integration-credentials.cjs",
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
fs.mkdirSync(path.join(destination, "data"), { recursive: true });
console.log(`Production artifact created at ${destination}`);
