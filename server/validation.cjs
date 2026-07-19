"use strict";

const { TEMPLATES } = require("./templates.cjs");

const BRAND_FONT_STACKS = Object.freeze({
  system: "'Segoe UI', Helvetica, Arial, sans-serif",
  arial: "Arial, Helvetica, sans-serif",
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  verdana: "Verdana, Arial, sans-serif",
  georgia: "Georgia, 'Times New Roman', serif",
});

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function validUrl(value) {
  if (!value) return true;
  try {
    return ["http:", "https:"].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}

function validMediaUrl(value) {
  return !value || String(value).startsWith("/") || validUrl(value);
}

function cleanUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function canonicalRole(value) {
  const role = String(value || "editor").toLowerCase();
  return ["admin", "editor", "viewer"].includes(role) ? role : "editor";
}

function canonicalStatus(value) {
  return String(value || "active").toLowerCase() === "disabled"
    ? "disabled"
    : "active";
}

function slug(value) {
  return (
    String(value || "workspace")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "workspace"
  );
}

function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return fallback;
  }
}

function limited(value, max = 240) {
  return String(value || "")
    .trim()
    .slice(0, max);
}

function safeLink(value, max = 1000) {
  const link = limited(value, max);
  return validUrl(link) ? link : "";
}

function safeMedia(value) {
  const link = limited(value, 1000);
  return validMediaUrl(link) ? link : "";
}

function canonicalBrandFont(value) {
  const key = String(value || "system").toLowerCase();
  return BRAND_FONT_STACKS[key] ? key : "system";
}

function normalizedBrand(input = {}, current = {}, companyName = "") {
  const accent = String(input.accent ?? current.accent ?? "#2563eb");
  return {
    locked: Boolean(input.locked ?? current.locked),
    accent: /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#2563eb",
    font: canonicalBrandFont(input.font ?? current.font),
    companyName: limited(
      input.companyName ?? current.companyName ?? companyName,
      120,
    ),
    logoUrl: safeMedia(input.logoUrl ?? current.logoUrl),
  };
}

function validDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

function campaignInput(body = {}, existing = {}) {
  const currentOverlay = safeJson(existing.overlay_json),
    rawOverlay =
      body.overlay &&
      typeof body.overlay === "object" &&
      !Array.isArray(body.overlay)
        ? body.overlay
        : currentOverlay,
    allowedFonts = new Set([
      'Inter, "Segoe UI", Arial, sans-serif',
      "Arial, sans-serif",
      '"Trebuchet MS", Arial, sans-serif',
      "Georgia, serif",
      "Verdana, sans-serif",
    ]),
    overlay = {
      enabled: Boolean(rawOverlay.enabled),
      ctaLabel: limited(rawOverlay.ctaLabel, 24) || "Learn more",
      badgeLabel: limited(rawOverlay.badgeLabel, 28) || "IT Done Right",
      eventLabel: limited(rawOverlay.eventLabel, 32),
      color: /^#[0-9a-f]{6}$/i.test(String(rawOverlay.color || ""))
        ? String(rawOverlay.color)
        : "#2b2d8f",
      font: allowedFonts.has(String(rawOverlay.font || ""))
        ? String(rawOverlay.font)
        : 'Inter, "Segoe UI", Arial, sans-serif',
      fontWeight: [600, 700, 800].includes(Number(rawOverlay.fontWeight))
        ? Number(rawOverlay.fontWeight)
        : 700,
      headlineSize: Math.min(
        26,
        Math.max(16, Number(rawOverlay.headlineSize) || 20),
      ),
      textColor: /^#[0-9a-f]{6}$/i.test(String(rawOverlay.textColor || ""))
        ? String(rawOverlay.textColor)
        : "#ffffff",
    };
  return {
    title: limited(body.title ?? existing.title, 64),
    message: limited(body.message ?? existing.message, 240),
    linkUrl: limited(body.linkUrl ?? existing.link_url, 1000),
    imageUrl: limited(body.imageUrl ?? existing.image_url, 1000),
    startDate: String(body.startDate ?? existing.start_date ?? ""),
    endDate: String(body.endDate ?? existing.end_date ?? ""),
    status:
      String(body.status ?? existing.status) === "paused" ? "paused" : "active",
    overlay,
  };
}

function signatureInputError(input) {
  if (input === undefined) return "";
  if (!input || typeof input !== "object" || Array.isArray(input))
    return "Signature data must be an object.";
  if (input.templateId && !TEMPLATES[input.templateId])
    return "Choose an available signature template.";
  if (
    input.colors?.accent &&
    !/^#[0-9a-f]{6}$/i.test(String(input.colors.accent))
  )
    return "Choose a valid accent color.";
  for (const value of [
    input.fields?.website,
    input.fields?.social?.linkedin,
    input.fields?.social?.twitter,
    input.fields?.social?.instagram,
    input.fields?.social?.facebook,
  ])
    if (value && !validUrl(value)) return "Enter valid contact URLs.";
  for (const value of [input.photoUrl, input.bannerUrl])
    if (value && !validMediaUrl(value)) return "Enter valid image URLs.";
  return "";
}

module.exports = {
  BRAND_FONT_STACKS,
  campaignInput,
  canonicalBrandFont,
  canonicalRole,
  canonicalStatus,
  cleanUrl,
  limited,
  normalizedBrand,
  safeJson,
  safeLink,
  safeMedia,
  signatureInputError,
  slug,
  validDate,
  validEmail,
  validMediaUrl,
  validUrl,
};
