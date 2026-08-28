"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, ".."),
  source = path.join(root, "docs", "pages"),
  pages = fs
    .readdirSync(source, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(entry.parentPath, entry.name)),
  requiredPages = [
    "Home.md",
    "Installation.md",
    "Configuration.md",
    "Using-Signify-Creator.md",
    "Application-Owner-Guide.md",
    "Troubleshooting.md",
  ];

for (const name of requiredPages)
  assert.ok(
    fs.existsSync(path.join(source, name)),
    `Missing Pages guide: ${name}`,
  );

for (const file of pages) {
  const content = fs.readFileSync(file, "utf8"),
    relative = path.relative(root, file).replaceAll("\\", "/");
  const frontMatterEnd = content.indexOf("\n---\n", 4),
    frontMatter = content.slice(4, frontMatterEnd);
  assert.ok(
    content.startsWith("---\n") && frontMatterEnd > 4,
    `${relative} is missing Pages front matter`,
  );
  assert.match(
    frontMatter,
    /(^|\n)layout: default($|\n)/,
    `${relative} is missing the default Pages layout`,
  );
  for (const match of content.matchAll(/(!?)\[([^\]]*)\]\(([^)]+)\)/g)) {
    const [, image, label, rawTarget] = match,
      target = rawTarget.trim().split(/\s+/)[0].replace(/^<|>$/g, "");
    if (
      !target ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    )
      continue;
    const local = decodeURIComponent(target.split("#")[0].split("?")[0]),
      resolved = path.resolve(path.dirname(file), local);
    assert.ok(
      resolved.startsWith(root + path.sep),
      `${relative} links outside the repository: ${target}`,
    );
    assert.ok(
      fs.existsSync(resolved),
      `${relative} has broken link: ${target}`,
    );
    if (image)
      assert.ok(label.trim(), `${relative} has an image without alt text`);
  }
}

assert.ok(
  fs.existsSync(path.join(source, "_layouts", "default.html")),
  "Pages layout is missing",
);
assert.match(
  fs.readFileSync(path.join(source, "_layouts", "default.html"), "utf8"),
  /style\.css[^"\n]*\?v=/,
  "Pages stylesheet URL must be versioned to prevent stale visual assets",
);
assert.ok(
  fs.existsSync(path.join(source, "assets", "style.css")),
  "Pages stylesheet is missing",
);

console.log(
  `Pages documentation passed: ${pages.length} Markdown files with valid local links and assets`,
);
