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
    ),
    signatureSource = fs.readFileSync(
      path.join(__dirname, "..", "signature.js"),
      "utf8",
    ),
    platformHtml = fs.readFileSync(
      path.join(__dirname, "..", "platform.html"),
      "utf8",
    ),
    adminSource = fs.readFileSync(
      path.join(__dirname, "..", "admin.js"),
      "utf8",
    ),
    adminHtml = fs.readFileSync(
      path.join(__dirname, "..", "admin.html"),
      "utf8",
    ),
    setupSource = fs.readFileSync(
      path.join(__dirname, "..", "setup.js"),
      "utf8",
    ),
    setupHtml = fs.readFileSync(
      path.join(__dirname, "..", "setup.html"),
      "utf8",
    ),
    adminStyles = fs.readFileSync(
      path.join(__dirname, "..", "admin.css"),
      "utf8",
    ),
    platformStyles = fs.readFileSync(
      path.join(__dirname, "..", "platform.css"),
      "utf8",
    ),
    appStyles = fs.readFileSync(
      path.join(__dirname, "..", "signify-app.css"),
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
  assert.match(
    signatureSource,
    /function shouldOpenControlPlane\(user\) \{\s+return Boolean\(user\?\.applicationOwner && !user\.organizationId\);\s+\}/,
    "Only Application Owners without a workspace should be routed to the control plane",
  );
  assert.equal(
    (signatureSource.match(/shouldOpenControlPlane\(state\.me\)/g) || [])
      .length,
    3,
    "Existing sessions, password logins, and MFA logins must share the workspace-aware route guard",
  );
  assert.ok(
    !signatureSource.includes("state.me.onboardingRequired ||"),
    "Pending control-plane MFA must not block a workspace-bound owner from Studio",
  );
  assert.match(
    signatureSource,
    /ANIMATED_BANNER_WIDTH = 440,\s*ANIMATED_BANNER_HEIGHT = 100/,
    "Animated banners must use the same 440 by 100 dimensions as email templates",
  );
  const signatureHtml = fs.readFileSync(
      path.join(__dirname, "..", "signature.html"),
      "utf8",
    ),
    animationEffects = [
      "tech-pulse",
      "signal-rings",
      "starfield",
      "clean",
      "scan-line",
      "digital-grid",
      "spotlight",
      "soft-pulse",
    ];
  for (const effect of animationEffects)
    assert.match(
      signatureHtml,
      new RegExp(`value="${effect}"`),
      `Animation selector is missing ${effect}`,
    );
  for (const effect of animationEffects
    .slice(1)
    .filter((item) => item !== "clean"))
    assert.match(
      signatureSource,
      new RegExp(`effect === "${effect}"`),
      `Animation renderer is missing ${effect}`,
    );
  assert.match(
    signatureHtml,
    /signature\.js\?v=\d+/,
    "Studio script must be cache-versioned",
  );
  assert.doesNotMatch(
    platformHtml,
    /data-admin-section="setup"/,
    "First-time setup must not be embedded in the owner console",
  );
  assert.match(
    platformHtml,
    /data-admin-section="licensing"/,
    "Application Owner console is missing installation licensing",
  );
  assert.match(
    platformHtml,
    /id="licenseForm"/,
    "Commercial license activation is not available in the UI",
  );
  assert.match(
    platformHtml,
    /id="licenseActivationPanel"/,
    "License activation panel cannot be conditionally displayed",
  );
  assert.match(
    setupHtml,
    /name="licenseKey"/,
    "First-time setup is missing optional license activation",
  );
  assert.match(
    platformSource,
    /function renderLicense\(\)/,
    "Application Owner UI does not render authoritative entitlement state",
  );
  assert.match(
    platformSource,
    /\["revoked", "expired", "suspended"\]\.includes\(license\.status\)/,
    "License activation must return for revoked, expired, or suspended licenses",
  );
  assert.match(
    platformSource,
    /\$\("#licenseActivationPanel"\)\.hidden = !activationRequired/,
    "Active commercial licenses must hide the activation panel",
  );
  assert.match(
    platformSource,
    /function renderTenantMode\(\)/,
    "Community installations must render a single-workspace Application view",
  );
  assert.match(
    platformHtml,
    /id="communityWorkspace" hidden/,
    "Application Owner UI is missing the Community workspace settings view",
  );
  assert.match(
    platformSource,
    /#openCreateTenant"\)\.hidden = community/,
    "Community installations must hide tenant creation",
  );
  assert.match(
    platformHtml,
    /id="tenantBillingControls"/,
    "Tenant billing controls must have an edition-aware container",
  );
  assert.match(
    platformSource,
    /#tenantBillingControls"\)\.hidden = community/,
    "Community workspace settings must hide tenant subscription and Stripe controls",
  );
  for (const control of ["tenantStatusForm", "supportAccessForm"])
    assert.match(
      platformSource,
      new RegExp(`#${control}\\"\\)\\.hidden = community`),
      `Community workspace settings must hide ${control}`,
    );
  assert.match(
    platformSource,
    /#scheduleTenantDeletion"\)\.hidden = community \|\| pending/,
    "Community workspace settings must hide tenant deletion",
  );
  for (const label of [
    "#fleetNavLabel",
    "#licenseUsageLabel",
    "#ownersDescription",
    "#auditDescription",
  ])
    assert.match(
      platformSource,
      new RegExp(`${label}\\"\\)\\.textContent = community`),
      `Community Application copy must be edition-aware for ${label}`,
    );
  assert.match(
    platformSource,
    /#exportTenant"\)\.textContent = community/,
    "Community workspace export must not use tenant wording",
  );
  for (const label of ["Setup", "Configure", "Sign in"])
    assert.match(
      setupHtml,
      new RegExp(`<strong>${label}</strong>`),
      `Standalone installer is missing the ${label} stage`,
    );
  for (const provider of ["microsoft", "stripe", "github"])
    assert.match(
      platformHtml,
      new RegExp(`data-open-integration="${provider}"`),
      `Integration catalog is missing ${provider}`,
    );
  assert.match(
    platformHtml,
    /<dialog class="integration-dialog" id="integrationDialog">/,
    "Integration details must open in a focused dialog",
  );
  assert.match(
    platformSource,
    /function openIntegration\(provider\)/,
    "Integration tiles must open their provider settings",
  );
  for (const formId of [
    "microsoftIntegrationActions",
    "stripeConnectForm",
    "githubConnectForm",
  ])
    assert.match(
      platformHtml,
      new RegExp(
        `<form[^>]+id="${formId}"[^>]+autocomplete="off"[^>]+data-form-type="other"`,
      ),
      `${formId} must opt out of login autofill`,
    );
  assert.match(
    platformHtml,
    /<form[^>]+id="githubConnectForm"[^>]+method="post"/,
    "GitHub credentials must never fall back to query-string submission",
  );
  assert.equal(
    (platformHtml.match(/autocomplete="new-password"/g) || []).length,
    3,
    "Provider secrets must be marked as new credentials",
  );
  assert.equal(
    (platformHtml.match(/data-1p-ignore/g) || []).length,
    5,
    "Provider identifiers and secrets must opt out of password-manager autofill",
  );
  assert.match(
    adminHtml,
    /<option value="direct">Create directly<\/option>/,
    "Tenant Admin user dialog must expose direct account creation",
  );
  assert.match(
    adminSource,
    /direct \? "\/api\/signature\/users" : "\/api\/signature\/invitations"/,
    "User creation mode must select the correct backend endpoint",
  );
  assert.match(
    adminSource,
    /result\.temporaryPassword/,
    "Generated temporary credentials must be handed to the administrator",
  );
  assert.match(
    adminHtml,
    /id="teamLicenseNote"/,
    "Workspace Team UI must display licensed user capacity",
  );
  assert.match(
    adminSource,
    /#openCreateUser"\)\.disabled = atLicenseLimit/,
    "Workspace Team UI must disable user creation at licensed capacity",
  );
  assert.match(
    adminHtml,
    /<section id="subscriptionSummary">/,
    "Workspace subscription details must have an edition-aware container",
  );
  assert.match(
    adminSource,
    /#subscriptionSummary"\)\.hidden = community/,
    "Community settings must hide SaaS tenant subscription details",
  );
  assert.match(
    adminHtml,
    /<label class="integration-field"[\s\S]*?<span>Sender mailbox<\/span[\s\S]*?<input/,
    "Microsoft 365 sender configuration must use the responsive field layout",
  );
  assert.match(
    adminStyles,
    /\.integration-field \{[\s\S]*display: grid;[\s\S]*gap: 7px;/,
    "Integration fields must stack their labels and controls without overlap",
  );
  assert.match(
    platformSource,
    /<article class="stat-card"><span>/,
    "Usage metrics must render as styled metric cards",
  );
  assert.match(
    platformStyles,
    /\.platform-stats \{[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    "Application metrics must use a stable responsive grid",
  );
  assert.ok(
    !setupSource.includes("localStorage") &&
      !setupSource.includes("sessionStorage"),
    "Installer secrets must not be persisted in browser storage",
  );
  assert.match(
    adminStyles,
    /dialog \{[\s\S]*max-height: calc\(100dvh - 30px\);[\s\S]*overflow: hidden;/,
    "Dialogs must remain bounded by the visible viewport",
  );
  assert.match(
    adminStyles,
    /\.dialog-form \{[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior: contain;/,
    "Long dialog content must scroll inside the modal",
  );
  assert.match(
    platformStyles,
    /#tenantDialog \{\s*width: min\(920px, calc\(100vw - 30px\)\);/,
    "Tenant detail width must be applied to the dialog container",
  );
  assert.match(
    adminHtml,
    /admin\.css\?v=\d+/,
    "Workspace stylesheet must be cache-versioned",
  );
  assert.match(
    platformHtml,
    /platform\.css\?v=\d+/,
    "Application stylesheet must be cache-versioned",
  );
  for (const [page, html] of [
    ["Studio", signatureHtml],
    ["Workspace", adminHtml],
    ["Application", platformHtml],
  ])
    assert.match(
      html,
      /signify-app\.css\?v=\d+/,
      `${page} must load the shared authenticated product theme`,
    );
  assert.match(
    appStyles,
    /@media \(max-width: 760px\)[\s\S]*grid-template-areas:/,
    "Authenticated navigation must have a mobile layout",
  );
  assert.match(
    appStyles,
    /\.app-shell \.preview-workspace \{[\s\S]*background-color: var\(--nav\);/,
    "Studio preview must use the login-inspired product canvas",
  );
  assert.match(
    platformHtml,
    /platform\.js\?v=\d+/,
    "Application script must be cache-versioned",
  );
  assert.match(
    platformHtml,
    /Lease renews by/,
    "Licensing must distinguish the signed lease deadline from subscription expiration",
  );
  console.log(
    "Frontend tests passed: GET deduplication, write isolation, structured errors, timeouts, and provider credential autofill isolation",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
