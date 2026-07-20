"use strict";

const { redirect, textResponse } = require("../http-responses.cjs");
const { slug, validUrl } = require("../validation.cjs");

function createPublicSignatureRoutes({ db, memberById, normalizeSignature }) {
  function routes({ req, res, url }) {
    const redirectMatch = url.pathname.match(/^\/r\/([^/]+)$/);
    if (redirectMatch && req.method === "GET") {
      const row = db
        .prepare("SELECT * FROM signature_tracking_links WHERE id=?")
        .get(redirectMatch[1]);
      if (!row || !validUrl(row.destination_url)) {
        redirect(res, "/");
        return true;
      }
      db.prepare(
        `UPDATE signature_tracking_links SET clicks=clicks+1,last_clicked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
      ).run(row.id);
      redirect(res, row.destination_url);
      return true;
    }

    const vcardMatch = url.pathname.match(/^\/vcard\/([^/]+)\/([^/]+)\.vcf$/);
    if (!vcardMatch || req.method !== "GET") return false;
    const row = memberById(vcardMatch[1], vcardMatch[2]);
    if (!row) {
      textResponse(res, 404, "Contact not found.");
      return true;
    }
    const fields = normalizeSignature(row).fields,
      escape = (value) =>
        String(value || "")
          .replace(/([,;\\])/g, "\\$1")
          .replace(/\n/g, "\\n"),
      card = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${escape(fields.name)}`,
        `TITLE:${escape(fields.jobTitle)}`,
        `ORG:${escape(fields.company)}`,
        `EMAIL;TYPE=INTERNET:${escape(fields.email)}`,
        fields.phone ? `TEL;TYPE=WORK,VOICE:${escape(fields.phone)}` : "",
        fields.mobile ? `TEL;TYPE=CELL:${escape(fields.mobile)}` : "",
        fields.website ? `URL:${escape(fields.website)}` : "",
        fields.address ? `ADR;TYPE=WORK:;;${escape(fields.address)};;;;` : "",
        "END:VCARD",
      ]
        .filter(Boolean)
        .join("\r\n");
    textResponse(res, 200, card, "text/vcard; charset=utf-8", {
      "Content-Disposition": `attachment; filename="${slug(fields.name)}.vcf"`,
    });
    return true;
  }

  return { routes };
}

module.exports = { createPublicSignatureRoutes };
