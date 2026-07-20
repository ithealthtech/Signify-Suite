"use strict";

window.Signify = (() => {
  const $ = (selector) => document.querySelector(selector),
    $$ = (selector) => [...document.querySelectorAll(selector)],
    inflightGets = new Map();

  function cookieValue(name) {
    return (
      document.cookie
        .split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${name}=`))
        ?.slice(name.length + 1) || ""
    );
  }

  async function request(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase(),
      timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000)),
      controller = options.signal ? null : new AbortController(),
      timer = controller
        ? setTimeout(() => controller.abort("timeout"), timeoutMs)
        : null,
      csrf = !["GET", "HEAD", "OPTIONS"].includes(method)
        ? decodeURIComponent(cookieValue("sig_csrf"))
        : "";
    try {
      const { timeoutMs: ignoredTimeout, ...fetchOptions } = options;
      void ignoredTimeout;
      const response = await fetch(path, {
          ...fetchOptions,
          signal: options.signal || controller.signal,
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
    } catch (error) {
      if (controller?.signal.aborted) {
        const timeout = new Error("Request timed out. Try again.");
        timeout.code = "REQUEST_TIMEOUT";
        throw timeout;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" || options.signal) return request(path, options);
    const key = String(path);
    if (!inflightGets.has(key)) {
      const pending = request(path, options).finally(() =>
        inflightGets.delete(key),
      );
      inflightGets.set(key, pending);
    }
    return inflightGets.get(key);
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

  function createToast(element, duration = 3000) {
    let timer;
    return (message) => {
      if (!element) return;
      element.textContent = message;
      element.classList.add("show");
      clearTimeout(timer);
      timer = setTimeout(() => element.classList.remove("show"), duration);
    };
  }

  function busy(button, active, label = "Working...") {
    if (!button) return;
    if (active) {
      button.dataset.label = button.textContent;
      button.textContent = label;
      button.disabled = true;
      return;
    }
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }

  function dateLabel(value, options) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf()))
      return options ? String(value) : "Unknown";
    return date.toLocaleString(undefined, options);
  }

  return Object.freeze({
    $,
    $$,
    api,
    busy,
    createToast,
    dateLabel,
    escapeHtml,
    initials,
  });
})();
