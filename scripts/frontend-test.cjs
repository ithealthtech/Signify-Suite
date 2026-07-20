"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function main() {
  let requests = 0,
    mode = "success";
  const context = {
    AbortController,
    clearTimeout,
    document: {
      cookie: "sig_csrf=csrf-token",
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    fetch: (_path, options) => {
      requests += 1;
      if (mode === "timeout")
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      const ok = mode !== "error";
      return Promise.resolve({
        ok,
        status: ok ? 200 : 409,
        json: async () =>
          ok
            ? { value: 42 }
            : { error: { code: "CONFLICT", message: "Conflict" } },
      });
    },
    setTimeout,
    window: {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "signify-shared.js"), "utf8"),
    context,
  );
  const { api } = context.window.Signify,
    [first, second] = await Promise.all([api("/same"), api("/same")]);
  assert.equal(first.value, 42);
  assert.equal(second.value, 42);
  assert.equal(requests, 1);
  await api("/same");
  assert.equal(requests, 2);
  await api("/write", { method: "POST", body: "{}" });
  assert.equal(requests, 3);

  mode = "error";
  await assert.rejects(
    api("/error"),
    (error) =>
      error.message === "Conflict" &&
      error.status === 409 &&
      error.code === "CONFLICT",
  );
  mode = "timeout";
  await assert.rejects(
    api("/slow", { timeoutMs: 10 }),
    (error) => error.code === "REQUEST_TIMEOUT",
  );
  const { busy, createToast, dateLabel } = context.window.Signify,
    button = {
      dataset: {},
      disabled: false,
      textContent: "Save",
    };
  busy(button, true, "Saving...");
  assert.deepEqual(
    { disabled: button.disabled, label: button.textContent },
    { disabled: true, label: "Saving..." },
  );
  busy(button, false);
  assert.deepEqual(
    { disabled: button.disabled, label: button.textContent },
    { disabled: false, label: "Save" },
  );
  const classes = new Set(),
    toastElement = {
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
      },
      textContent: "",
    },
    showToast = createToast(toastElement, 10);
  showToast("Saved");
  assert.equal(toastElement.textContent, "Saved");
  assert.equal(classes.has("show"), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(classes.has("show"), false);
  assert.equal(dateLabel(""), "Never");
  assert.equal(dateLabel("invalid"), "Unknown");
  assert.equal(dateLabel("invalid", { year: "numeric" }), "invalid");
  const platformSource = fs.readFileSync(
    path.join(__dirname, "..", "platform.js"),
    "utf8",
  );
  for (const unsafeAccess of [
    "busy(event.currentTarget, false)",
    "event.currentTarget.reset()",
    "event.currentTarget.elements",
  ])
    assert.ok(
      !platformSource.includes(unsafeAccess),
      `Platform async handlers must capture currentTarget: ${unsafeAccess}`,
    );
  console.log(
    "Frontend tests passed: GET deduplication, write isolation, structured errors, and timeouts",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
