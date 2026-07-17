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
    "DEPLOYMENT.md",
    "signature.html",
    "signature.css",
    "signature.js",
    "admin.html",
    "admin.css",
    "admin.js",
    "server",
    "public",
    "scripts/backup.cjs",
    "start-production.cmd",
  ];

for (const entry of entries) {
  if (!fs.existsSync(path.join(root, entry)))
    throw new Error(`Required release file is missing: ${entry}`);
}
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const entry of entries) {
  const source = path.join(root, entry),
    target = path.join(destination, entry);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}
fs.mkdirSync(path.join(destination, "data"), { recursive: true });
console.log(`Production artifact created at ${destination}`);
