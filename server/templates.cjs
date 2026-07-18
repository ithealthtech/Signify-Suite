// All templates are built from <table> layouts with inline CSS only.
// Rules followed throughout (required for Outlook, which renders HTML email
// with the Word engine, not a browser engine):
//   - no <div> flex/grid layout, no CSS background-image on block elements
//   - all styling inline, no external stylesheet or <style> selectors that
//     Outlook strips
//   - explicit width/height on every <img>
//   - web-safe font stacks only (system sans/serif fallbacks — no @font-face,
//     since most email clients strip it)
//   - absolute (fully-qualified) URLs for every image, since email clients
//     don't respect relative paths
//
// A signature's optional HEADER BANNER (the image you upload in the editor)
// is applied UNIVERSALLY by buildSignatureHtml below — every template
// supports it, not just one. See the bottom of this file.

const SANS = "'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// ---------- Shared building blocks ----------

// Circular photo with a soft "halo" ring in the accent color — the two-cell
// trick (colored outer circle, white gap, photo) is what gives it a premium
// avatar look instead of a plain cropped image.
function avatarRing(photoUrl, name, size, accent) {
  if (!photoUrl) return "";
  const outer = size + 8;
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${outer}" height="${outer}" style="background:${accent}22;border-radius:50%;">
      <tr><td align="center" valign="middle" style="border-radius:50%;">
        <img src="${esc(photoUrl)}" width="${size}" height="${size}" alt="${esc(name)}" style="border-radius:50%;display:block;border:3px solid #ffffff;">
      </td></tr>
    </table>`;
}

// A single tidy line of contact details separated by a light dot, instead
// of stacked icon rows — the look used by most modern agency/law-firm
// signatures. Falls back gracefully if some fields are empty.
function contactStrip(parts, color = "#5b5f6b") {
  const items = parts.filter(Boolean);
  if (!items.length) return "";
  return items
    .map((p, i) => {
      const sep =
        i === 0 ? "" : `<span style="color:#c9ccd6;padding:0 7px;">·</span>`;
      const inner = p.href
        ? `<a href="${esc(p.href)}" style="color:${color};text-decoration:none;">${esc(p.text)}</a>`
        : `<span style="color:${color};">${esc(p.text)}</span>`;
      return `${sep}<span style="font-family:${SANS};font-size:12px;">${inner}</span>`;
    })
    .join("");
}

function socialRow(links = {}, hrefs = {}, iconBase, size = 18, gap = 8) {
  const platforms = ["linkedin", "twitter", "instagram", "facebook", "website"];
  const cells = platforms
    .filter((k) => links[k])
    .map((k) => {
      const href = (hrefs && hrefs[k]) || links[k];
      return `<a href="${esc(href)}" style="text-decoration:none;display:inline-block;margin-right:${gap}px;" target="_blank"><img src="${esc(iconBase)}/${k}.png" width="${size}" height="${size}" alt="" style="display:inline-block;border:0;vertical-align:middle;"></a>`;
    })
    .join("");
  return cells
    ? `<tr><td style="padding-top:12px;" colspan="2">${cells}</td></tr>`
    : "";
}

function thinDivider(width = 40, color, height = 2) {
  return `<tr><td style="padding:6px 0 8px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="${width}" height="${height}" style="background:${color};font-size:1px;line-height:1px;">&nbsp;</td></tr></table></td></tr>`;
}

// ---------- Campaign banner block (admin-managed promo, shown after the
// main signature) ----------
function campaignBlock(campaign, trackedLinkUrl) {
  if (!campaign) return "";
  const link = trackedLinkUrl || campaign.linkUrl;
  const content = campaign.imageUrl
    ? `<img src="${esc(campaign.imageUrl)}" alt="${esc(campaign.title || "")}" style="display:block;border:0;width:100%;max-width:440px;border-radius:8px;">`
    : `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="440" style="background:#14161f;border-radius:8px;">
        <tr>
          <td style="padding:16px 18px;">
            <div style="font-family:${SANS};font-size:13px;font-weight:600;color:#ffffff;">${esc(campaign.title || "")}</div>
            ${campaign.message ? `<div style="font-family:${SANS};font-size:12px;color:#b7bac6;padding-top:4px;">${esc(campaign.message)}</div>` : ""}
          </td>
        </tr>
      </table>`;
  const wrapped = link
    ? `<a href="${esc(link)}" target="_blank" style="text-decoration:none;">${content}</a>`
    : content;
  return `<tr><td style="padding-top:16px;">${wrapped}</td></tr>`;
}

// ---------- Company logo footer (brand lock) ----------
function companyLogoBlock(logoUrl, companyName) {
  if (!logoUrl) return "";
  return `
    <tr>
      <td style="padding-top:14px;">
        <img src="${esc(logoUrl)}" alt="${esc(companyName || "")}" height="26" style="display:block;border:0;max-height:26px;width:auto;">
      </td>
    </tr>`;
}

// ---------- QR / vCard "save contact" block ----------
function vcardBlock(qrDataUri, vcardTrackedUrl) {
  if (!qrDataUri && !vcardTrackedUrl) return "";
  return `
    <tr>
      <td style="padding-top:16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            ${qrDataUri ? `<td style="padding-right:12px;"><img src="${esc(qrDataUri)}" width="60" height="60" alt="QR code to save contact" style="display:block;border:0;border-radius:4px;"></td>` : ""}
            ${vcardTrackedUrl ? `<td style="vertical-align:middle;"><a href="${esc(vcardTrackedUrl)}" style="font-family:${SANS};font-size:12px;color:#2563eb;text-decoration:none;font-weight:600;">Save contact →</a></td>` : ""}
          </tr>
        </table>
      </td>
    </tr>`;
}

// ---------- Universal header banner (the image a user uploads themselves —
// works with every template, not just one) ----------
function headerBannerRow(bannerUrl, width = 440, height = 100) {
  if (!bannerUrl) return "";
  return `<tr><td style="padding-bottom:14px;"><img src="${esc(bannerUrl)}" width="${width}" height="${height}" alt="" style="display:block;border:0;width:${width}px;height:${height}px;object-fit:cover;border-radius:8px;"></td></tr>`;
}

// ================= TEMPLATES =================

// ---------- 1. Executive — ring avatar, small-caps title, single-line
// contact strip, thin accent underline. The flagship "premium" look. ----------
function executive({ f, colors, photoUrl, iconBase, hrefs = {} }) {
  const accent = colors.accent || "#1a1a2e";
  const ring = avatarRing(photoUrl, f.name, 72, accent);
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    ${ring ? `<td style="padding-right:20px;vertical-align:top;">${ring}</td>` : ""}
    <td style="vertical-align:top;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:${SANS};font-size:19px;font-weight:600;color:#111318;letter-spacing:-.2px;">${esc(f.name)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:11px;font-weight:600;color:${accent};text-transform:uppercase;letter-spacing:1.2px;padding-top:3px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
        ${thinDivider(34, accent, 2)}
        <tr><td style="padding-top:2px;">${contactStrip([
          f.phone && { text: f.phone, href: `tel:${f.phone}` },
          f.email && { text: f.email, href: `mailto:${f.email}` },
          f.website && {
            text: f.website.replace(/^https?:\/\//, ""),
            href: hrefs.website || f.website,
          },
        ])}</td></tr>
        ${socialRow(f.social, hrefs, iconBase, 17, 10)}
      </table>
    </td>
  </tr>
</table>`;
}

// ---------- 2. Minimal Line — no photo, one immaculate line. The
// ultra-restrained "quiet luxury" option. ----------
function minimalLine({ f, colors, iconBase, hrefs = {} }) {
  const accent = colors.accent || "#111318";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr><td style="border-top:2px solid ${accent};padding-top:10px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="font-family:${SANS};font-size:14px;font-weight:600;color:#111318;">${esc(f.name)}</td>
        <td style="font-family:${SANS};font-size:12px;color:#8a8d99;padding-left:8px;">${esc(f.jobTitle)}${f.company ? ", " + esc(f.company) : ""}</td>
      </tr>
      <tr><td colspan="2" style="padding-top:5px;">${contactStrip([
        f.phone && { text: f.phone, href: `tel:${f.phone}` },
        f.email && { text: f.email, href: `mailto:${f.email}` },
        f.website && {
          text: f.website.replace(/^https?:\/\//, ""),
          href: hrefs.website || f.website,
        },
      ])}</td></tr>
      ${socialRow(f.social, hrefs, iconBase, 15, 8)}
    </table>
  </td></tr>
</table>`;
}

// ---------- 3. Modern Minimal — photo, left accent rule, contact strip ----------
function modernMinimal({ f, colors, photoUrl, iconBase, hrefs = {} }) {
  const accent = colors.accent || "#2563eb";
  const photo = photoUrl
    ? `<img src="${esc(photoUrl)}" width="80" height="80" alt="${esc(f.name)}" style="border-radius:50%;display:block;border:0;">`
    : "";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    ${photo ? `<td style="padding-right:18px;vertical-align:top;">${photo}</td>` : ""}
    <td style="border-left:3px solid ${accent};padding-left:16px;vertical-align:top;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:${SANS};font-size:16px;font-weight:600;color:#111318;padding-bottom:2px;">${esc(f.name)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:12.5px;color:${accent};font-weight:600;padding-bottom:8px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
        <tr><td>${contactStrip([
          f.phone && { text: f.phone, href: `tel:${f.phone}` },
          f.email && { text: f.email, href: `mailto:${f.email}` },
          f.website && {
            text: f.website.replace(/^https?:\/\//, ""),
            href: hrefs.website || f.website,
          },
        ])}</td></tr>
        ${socialRow(f.social, hrefs, iconBase, 17, 10)}
      </table>
    </td>
  </tr>
</table>`;
}

// ---------- 4. Corporate Serif — serif name for a law-firm / private-bank
// feel, contrasted with sans-serif detail lines ----------
function corporateSerif({ f, colors, photoUrl, iconBase, hrefs = {} }) {
  const accent = colors.accent || "#7c3a1d";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    <td style="vertical-align:top;padding-right:16px;">
      ${photoUrl ? `<img src="${esc(photoUrl)}" width="70" height="70" alt="${esc(f.name)}" style="display:block;border:0;border-radius:4px;">` : `<div style="width:3px;height:70px;background:${accent};"></div>`}
    </td>
    <td style="vertical-align:top;border-left:1px solid #e4e2dc;padding-left:16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:${SERIF};font-size:18px;color:#1c1c1c;">${esc(f.name)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:11px;color:${accent};font-weight:600;text-transform:uppercase;letter-spacing:.8px;padding:3px 0 8px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
        <tr><td>${contactStrip([
          f.phone && { text: f.phone, href: `tel:${f.phone}` },
          f.email && { text: f.email, href: `mailto:${f.email}` },
        ])}</td></tr>
        ${f.website ? `<tr><td style="padding-top:3px;"><a href="${esc(hrefs.website || f.website)}" style="font-family:${SANS};font-size:12px;color:${accent};text-decoration:none;">${esc(f.website.replace(/^https?:\/\//, ""))}</a></td></tr>` : ""}
        ${f.address ? `<tr><td style="padding-top:3px;font-family:${SANS};font-size:11px;color:#9a9ca5;">${esc(f.address)}</td></tr>` : ""}
        ${socialRow(f.social, hrefs, iconBase, 17, 10)}
      </table>
    </td>
  </tr>
</table>`;
}

// ---------- 5. Compact — single dense line, refined spacing ----------
function compact({ f, colors, photoUrl }) {
  const accent = colors.accent || "#059669";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    ${photoUrl ? `<td style="padding-right:10px;"><img src="${esc(photoUrl)}" width="38" height="38" alt="${esc(f.name)}" style="border-radius:50%;display:block;border:0;"></td>` : ""}
    <td>
      <span style="font-family:${SANS};font-size:13px;font-weight:600;color:#111318;">${esc(f.name)}</span>
      <span style="font-family:${SANS};font-size:12px;color:#8a8d99;"> — ${esc(f.jobTitle)}, ${esc(f.company)}</span><br>
      ${contactStrip(
        [
          f.phone && { text: f.phone, href: `tel:${f.phone}` },
          f.email && { text: f.email, href: `mailto:${f.email}` },
        ],
        accent,
        accent,
      )}
    </td>
  </tr>
</table>`;
}

// ---------- 6. Gradient Edge — refined 3-tone bar instead of a harsh
// 5-band strip, rounded outer corners ----------
function gradientEdge({ f, colors, photoUrl, iconBase, hrefs = {} }) {
  const accent = colors.accent || "#7c3aed";
  const hex = accent.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16),
    g = parseInt(hex.substring(2, 4), 16),
    b = parseInt(hex.substring(4, 6), 16);
  const mix = (alpha) => {
    const m = (c) => Math.round(c + (255 - c) * (1 - alpha));
    return `rgb(${m(r)},${m(g)},${m(b)})`;
  };
  const bands = [1, 0.55, 0.25]
    .map(
      (a, i) =>
        `<td width="6" style="background:${mix(a)};font-size:1px;line-height:1px;${i === 0 ? "border-radius:4px 0 0 4px;" : ""}${i === 2 ? "border-radius:0 4px 4px 0;" : ""}">&nbsp;</td>`,
    )
    .join("");
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    <td><table role="presentation" cellpadding="0" cellspacing="0" border="0" height="72"><tr>${bands}</tr></table></td>
    ${photoUrl ? `<td style="padding:0 16px;vertical-align:top;"><img src="${esc(photoUrl)}" width="68" height="68" alt="${esc(f.name)}" style="border-radius:50%;display:block;border:0;"></td>` : `<td width="16"></td>`}
    <td style="vertical-align:top;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="font-family:${SANS};font-size:16px;font-weight:600;color:#111318;">${esc(f.name)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:12.5px;color:${accent};font-weight:600;padding-bottom:8px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
        <tr><td>${contactStrip([
          f.phone && { text: f.phone, href: `tel:${f.phone}` },
          f.email && { text: f.email, href: `mailto:${f.email}` },
          f.website && {
            text: f.website.replace(/^https?:\/\//, ""),
            href: hrefs.website || f.website,
          },
        ])}</td></tr>
        ${socialRow(f.social, hrefs, iconBase, 17, 10)}
      </table>
    </td>
  </tr>
</table>`;
}

// ---------- 7. Dark Mode Card — refined with ring avatar + accent divider ----------
function darkModeCard({ f, colors, photoUrl, hrefs = {} }) {
  const accent = colors.accent || "#22d3ee";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#14161f" style="font-family:${SANS};background:#14161f;border-radius:12px;">
  <tr>
    <td style="padding:20px 22px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${photoUrl ? `<td style="padding-right:16px;vertical-align:top;"><img src="${esc(photoUrl)}" width="60" height="60" alt="${esc(f.name)}" style="border-radius:50%;display:block;border:2px solid ${accent};"></td>` : ""}
          <td style="vertical-align:top;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="font-family:${SANS};font-size:16px;font-weight:600;color:#ffffff;">${esc(f.name)}</td></tr>
              <tr><td style="font-family:${SANS};font-size:11px;font-weight:600;color:${accent};text-transform:uppercase;letter-spacing:1px;padding:2px 0 8px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
              <tr><td>${contactStrip(
                [
                  f.phone && { text: f.phone, href: `tel:${f.phone}` },
                  f.email && { text: f.email, href: `mailto:${f.email}` },
                  f.website && {
                    text: f.website.replace(/^https?:\/\//, ""),
                    href: hrefs.website || f.website,
                  },
                ],
                "#c6c9d4",
                accent,
              )}</td></tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

// ---------- 8. Seasonal Accent — corner tag for promos/holidays, refined ----------
function seasonalRibbon({
  f,
  colors,
  photoUrl,
  iconBase,
  hrefs = {},
  ribbonText = "❄️ Happy Holidays from our team",
}) {
  const accent = colors.accent || "#dc2626";
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  <tr>
    <td style="background:${accent};padding:6px 14px;border-radius:8px 8px 0 0;">
      <span style="font-family:${SANS};font-size:11px;color:#ffffff;font-weight:600;">${esc(ribbonText)}</span>
    </td>
  </tr>
  <tr>
    <td style="border:1px solid #e4e2dc;border-top:none;border-radius:0 0 8px 8px;padding:16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          ${photoUrl ? `<td style="padding-right:16px;vertical-align:top;"><img src="${esc(photoUrl)}" width="60" height="60" alt="${esc(f.name)}" style="border-radius:50%;display:block;border:0;"></td>` : ""}
          <td style="vertical-align:top;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="font-family:${SANS};font-size:15px;font-weight:600;color:#111318;">${esc(f.name)}</td></tr>
              <tr><td style="font-family:${SANS};font-size:12px;color:${accent};font-weight:600;padding-bottom:8px;">${esc(f.jobTitle)}${f.company ? " · " + esc(f.company) : ""}</td></tr>
              <tr><td>${contactStrip([
                f.phone && { text: f.phone, href: `tel:${f.phone}` },
                f.email && { text: f.email, href: `mailto:${f.email}` },
              ])}</td></tr>
              ${socialRow(f.social, hrefs, iconBase, 17, 10)}
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

const TEMPLATES = {
  executive: {
    name: "Executive",
    build: executive,
    blurb: "Ring avatar, small-caps title, clean contact line",
  },
  minimalLine: {
    name: "Minimal Line",
    build: minimalLine,
    blurb: "No photo — one immaculate line",
  },
  modernMinimal: {
    name: "Modern Minimal",
    build: modernMinimal,
    blurb: "Photo + accent rule, most versatile",
  },
  corporateSerif: {
    name: "Corporate Serif",
    build: corporateSerif,
    blurb: "Serif name, private-bank feel",
  },
  compact: { name: "Compact", build: compact, blurb: "Smallest footprint" },
  gradientEdge: {
    name: "Gradient Edge",
    build: gradientEdge,
    blurb: "Tri-tone accent bar",
  },
  darkModeCard: {
    name: "Dark Card",
    build: darkModeCard,
    blurb: "Dark background, bold contrast",
  },
  seasonalRibbon: {
    name: "Seasonal Accent",
    build: seasonalRibbon,
    blurb: "Corner tag for promos/holidays",
  },
};

// `data` may additionally include:
//   bannerUrl: the user's own header image — rendered above EVERY template
//     uniformly (this is what "attaching a banner" means; it is not tied
//     to any specific template)
//   hrefs: { website, linkedin, twitter, instagram, facebook } — tracked
//     redirect URLs to use instead of the raw destination
//   campaign: { title, message, linkUrl, imageUrl } | null — active campaign
//   campaignLinkUrl: tracked URL for the campaign click-through
//   qrDataUri, vcardLinkUrl: for the "save my contact" block
//   ribbonText: override text for the seasonalRibbon template
//   companyLogoUrl, companyName: brand-lock footer logo
function buildSignatureHtml(templateId, data) {
  const tpl = TEMPLATES[templateId] || TEMPLATES.executive;
  const main = tpl.build(data);
  const rows = [
    headerBannerRow(data.bannerUrl),
    `<tr><td>${main}</td></tr>`,
    campaignBlock(data.campaign, data.campaignLinkUrl),
    vcardBlock(data.qrDataUri, data.vcardLinkUrl),
    companyLogoBlock(data.companyLogoUrl, data.companyName),
  ].join("");

  const html = `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-family:${SANS};">
  ${rows}
</table>`;
  return data.fontFamily
    ? html.replaceAll(SANS, data.fontFamily).replaceAll(SERIF, data.fontFamily)
    : html;
}

// ---------- Plain-text fallback (for clients that strip HTML, or as a
// sanity-check of what the signature "says" independent of styling) ----------
function buildPlainTextSignature(fields = {}) {
  const lines = [];
  if (fields.name) lines.push(fields.name);
  const roleLine = [fields.jobTitle, fields.company].filter(Boolean).join(", ");
  if (roleLine) lines.push(roleLine);
  const contact = [
    fields.phone,
    fields.mobile,
    fields.email,
    fields.website,
  ].filter(Boolean);
  if (contact.length) lines.push(contact.join("  |  "));
  if (fields.address) lines.push(fields.address);
  const social = Object.entries(fields.social || {})
    .filter(([, v]) => v)
    .map(([, v]) => v);
  if (social.length) lines.push(social.join("  |  "));
  return lines.join("\n");
}

module.exports = { TEMPLATES, buildSignatureHtml, buildPlainTextSignature };
