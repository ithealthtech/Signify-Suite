"use strict";

window.Signify = (() => {
  const $ = (selector) => document.querySelector(selector),
    $$ = (selector) => [...document.querySelectorAll(selector)];

  function cookieValue(name) {
    return (
      document.cookie
        .split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${name}=`))
        ?.slice(name.length + 1) || ""
    );
  }

  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase(),
      csrf = !["GET", "HEAD", "OPTIONS"].includes(method)
        ? decodeURIComponent(cookieValue("sig_csrf"))
        : "",
      response = await fetch(path, {
        ...options,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          ...(options.headers || {}),
        },
      }),
      data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        data.error?.message || `Request failed (${response.status})`,
      );
      error.status = response.status;
      error.code = data.error?.code || "REQUEST_FAILED";
      throw error;
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value || "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  function initials(value) {
    return String(value || "SC")
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();
  }

  return Object.freeze({ $, $$, api, escapeHtml, initials });
})();
