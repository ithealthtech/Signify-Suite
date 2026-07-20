"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { scanText } = require("../server/secret-scanner.cjs");

const root = path.join(__dirname, ".."),
  files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean),
  forbiddenNames = files.filter(
    (file) => /(^|\/)\.env(?:\..+)?$/.test(file) && file !== ".env.example",
  ),
  findings = [];

for (const relative of files) {
  const file = path.join(root, relative);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 5 * 1024 * 1024)
    continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  for (const finding of scanText(content.toString("utf8"))) {
    const line = content
      .subarray(0, finding.index)
      .toString("utf8")
      .split("\n").length;
    findings.push({ file: relative, line, type: finding.type });
  }
}

if (forbiddenNames.length || findings.length) {
  for (const file of forbiddenNames)
    console.error(`${file}: tracked environment file is forbidden`);
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}: suspected ${finding.type}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${files.length} source files inspected`);
}
