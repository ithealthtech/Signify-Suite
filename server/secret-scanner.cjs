"use strict";

const PATTERNS = Object.freeze([
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{20,}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
]);

function scanText(text) {
  const findings = [];
  for (const [type, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(text).matchAll(pattern))
      findings.push({ type, index: match.index });
  }
  return findings;
}

module.exports = { PATTERNS, scanText };
