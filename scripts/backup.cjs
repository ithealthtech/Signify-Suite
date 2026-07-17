"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig } = require("../server/config.cjs");

const config = loadConfig(),
  source = path.resolve(config.databasePath);
if (!fs.existsSync(source))
  throw new Error(`Database does not exist: ${source}`);
const backupRoot = path.resolve(
    process.env.BACKUP_DIR || path.join(config.sourceRoot, "backups"),
  ),
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
  target = path.join(backupRoot, `signify-creator-${stamp}.db`);
fs.mkdirSync(backupRoot, { recursive: true });
const db = new DatabaseSync(source);
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}
console.log(`Backup created: ${target}`);
