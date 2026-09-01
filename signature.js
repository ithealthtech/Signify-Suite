"use strict";
const {
  $,
  $$,
  api,
  busy: sharedBusy,
  createToast,
  escapeHtml,
  initials,
} = window.Signify;
const els = {
  authView: $("#authView"),
  appView: $("#appView"),
  loginForm: $("#loginForm"),
  mfaForm: $("#mfaForm"),
  registerForm: $("#registerForm"),
  inviteForm: $("#inviteForm"),
  authStatus: $("#authStatus"),
  signatureForm: $("#signatureForm"),
  templateGrid: $("#templateGrid"),
  customTemplateSelect: $("#customTemplateSelect"),
  preview: $("#signaturePreview"),
  employeePicker: $("#employeePicker"),
  employeeSelect: $("#employeeSelect"),
  saveState: $("#saveState"),
  workflowBanner: $("#workflowBanner"),
  workflowText: $("#workflowText"),
  submitApproval: $("#submitApproval"),
  photoPreview: $("#photoPreview"),
  bannerPreview: $("#bannerPreview"),
  toast: $("#toast"),
  subscriptionDialog: $("#subscriptionDialog"),
  subscriptionForm: $("#subscriptionForm"),
};
let state = {
  me: null,
  workspaces: [],
  users: [],
  runtime: null,
  builtins: [],
  templates: [],
  selectedUserId: null,
  signature: null,
  rendered: null,
  dirty: false,
  previewTimer: null,
  previewSequence: 0,
  previewController: null,
  entitlementTimer: null,
};
let animationPreview = {
  image: null,
  source: "",
  frameRequest: null,
  loadSequence: 0,
  startedAt: 0,
};

const toast = createToast(els.toast, 2600);
function activeUser() {
  return (
    state.users.find((user) => user.id === state.selectedUserId) ||
    state.users[0] ||
    state.me
  );
}
function shouldOpenControlPlane(user) {
  return Boolean(user?.applicationOwner && !user.organizationId);
}
function setBusy(button, busy, label = "Working…") {
  sharedBusy(button, busy, label);
}
function markDirty() {
  state.dirty = true;
  els.saveState.textContent = "Unsaved";
  els.saveState.classList.add("dirty");
  schedulePreview();
}
function markSaved() {
  state.dirty = false;
  els.saveState.textContent = "Saved";
  els.saveState.classList.remove("dirty");
}

async function boot() {
  const query = new URLSearchParams(location.search),
    fragment = new URLSearchParams(location.hash.slice(1)),
    verification = query.get("verify"),
    reset = query.get("reset"),
    invitation = query.get("invite"),
    mfaChallenge = fragment.get("mfa");
  if (mfaChallenge) {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    els.mfaForm.elements.challenge.value = mfaChallenge;
    showAuthForm(els.mfaForm);
    els.mfaForm.elements.code.focus();
  }
  if (verification) {
    try {
      await api("/api/signature/email/verify", {
        method: "POST",
        body: JSON.stringify({ token: verification }),
      });
      history.replaceState(null, "", "/signature.html");
      els.authStatus.textContent = "Email verified. You can sign in now.";
    } catch (error) {
      els.authStatus.textContent = error.message;
    }
  }
  if (reset) {
    showAuthForm($("#resetForm"));
    $("#resetForm").elements.token.value = reset;
    history.replaceState(null, "", "/signature.html");
    return;
  }
  if (invitation) {
    showAuthForm(els.inviteForm);
    els.inviteForm.elements.token.value = invitation;
    history.replaceState(null, "", "/signature.html");
    return;
  }
  const [session, capabilities] = await Promise.all([
    api("/api/signature/session"),
    api("/api/signature/capabilities"),
  ]);
  $("#microsoftLogin").hidden = !capabilities.microsoft;
  $("#registerPrompt").hidden = !capabilities.registration;
  const authResult = new URLSearchParams(location.search).get("auth");
  if (authResult)
    els.authStatus.textContent =
      authResult === "account-required"
        ? "Create or accept a workspace account before using Microsoft 365 sign-in."
        : "Microsoft 365 sign-in is not available for this workspace.";
  if (session.user) {
    state.me = session.user;
    state.workspaces = session.workspaces || [];
    if (shouldOpenControlPlane(state.me)) {
      location.href = "/platform.html";
      return;
    }
    await loadApp();
  } else {
    els.authView.hidden = false;
    els.appView.hidden = true;
  }
}
async function loadApp() {
  els.authView.hidden = true;
  els.appView.hidden = false;
  const entitlement = await api("/api/signature/subscription");
  if (!entitlement.access) {
    showSubscriptionRequired(entitlement);
    return;
  }
  if (!state.entitlementTimer)
    state.entitlementTimer = window.setInterval(checkEntitlement, 60_000);
  const [users, templates, runtime] = await Promise.all([
    api("/api/signature/users"),
    api("/api/signature/templates"),
    api("/api/signature/runtime-config"),
  ]);
  state.users = users.users;
  state.builtins = templates.builtins;
  state.templates = templates.templates;
  state.runtime = runtime;
  const requested = new URLSearchParams(location.search).get("user");
  state.selectedUserId =
    state.me.role === "admin" &&
    (requested && state.users.some((user) => user.id === requested)
      ? requested
      : state.users.find((user) => user.id === state.me.id)?.id ||
        state.users[0]?.id);
  if (state.me.role !== "admin") state.selectedUserId = state.me.id;
  $("#workspaceName").textContent = runtime.organization.name;
  $("#profileName").textContent = state.me.displayName;
  $("#profileRole").textContent = state.me.role;
  $("#profileInitials").textContent = initials(state.me.displayName);
  $("#adminNav").hidden = state.me.role !== "admin";
  $("#platformNav").hidden = !state.me.applicationOwner;
  const switcher = $("#workspaceSwitcher");
  switcher.innerHTML = state.workspaces
    .map(
      (workspace) =>
        `<option value="${escapeHtml(workspace.id)}" ${workspace.id === state.me.organizationId ? "selected" : ""}>${escapeHtml(workspace.name)}</option>`,
    )
    .join("");
  $("#workspaceSwitcherField").hidden = state.workspaces.length < 2;
  els.employeePicker.hidden = state.me.role !== "admin";
  $("#emailSignature").hidden =
    state.me.role !== "admin" || !runtime.capabilities.mail;
  renderEmployeePicker();
  renderTemplateGrid();
  renderCustomTemplates();
  selectUser(state.selectedUserId);
}
async function checkEntitlement() {
  try {
    const entitlement = await api("/api/signature/subscription");
    if (!entitlement.access) {
      window.clearInterval(state.entitlementTimer);
      state.entitlementTimer = null;
      showSubscriptionRequired(entitlement);
    }
  } catch (error) {
    toast(error.message);
  }
}
function showSubscriptionRequired(entitlement) {
  const admin = entitlement.canManageBilling;
  els.appView.setAttribute("inert", "");
  els.appView.classList.add("subscription-locked");
  els.subscriptionForm.hidden = !admin || !entitlement.checkoutAvailable;
  $("#subscriptionMessage").textContent = admin
    ? "Choose a plan to continue creating and managing email signatures."
    : "Your workspace trial has ended. Contact a workspace administrator to restore access.";
  $("#subscriptionNote").textContent = admin
    ? entitlement.checkoutAvailable
      ? "Payment is completed securely through Stripe. Access resumes after payment is confirmed."
      : "Checkout is not configured. Contact the Signify application owner."
    : "The editor will remain locked until the workspace subscription is active.";
  els.subscriptionDialog.showModal();
}
function renderEmployeePicker() {
  els.employeeSelect.innerHTML = state.users
    .map(
      (user) =>
        `<option value="${user.id}">${escapeHtml(user.displayName)} · ${escapeHtml(user.role)}</option>`,
    )
    .join("");
  els.employeeSelect.value = state.selectedUserId;
}
function renderTemplateGrid() {
  els.templateGrid.innerHTML = state.builtins
    .map(
      (template) =>
        `<button class="template-card" type="button" data-template-id="${template.id}"><span class="template-swatch"></span><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.blurb)}</small></button>`,
    )
    .join("");
}
function renderCustomTemplates() {
  els.customTemplateSelect.innerHTML =
    '<option value="">Saved templates</option>' +
    state.templates
      .map(
        (template) =>
          `<option value="${template.id}">${escapeHtml(template.name)}</option>`,
      )
      .join("");
}
function selectUser(id) {
  const user = state.users.find((item) => item.id === id);
  if (!user) return;
  state.selectedUserId = id;
  state.signature = structuredClone(user.signature);
  els.employeeSelect.value = id;
  $("#emailSelf").hidden =
    !state.runtime.capabilities.mail ||
    id !== state.me.id ||
    state.me.role === "viewer";
  fillForm();
  markSaved();
  schedulePreview(0);
}
function fillForm() {
  const sig = state.signature,
    f = sig.fields || {},
    social = f.social || {},
    form = els.signatureForm.elements;
  for (const name of [
    "name",
    "jobTitle",
    "department",
    "company",
    "email",
    "website",
    "phone",
    "mobile",
    "address",
  ])
    form[name].value = f[name] || "";
  for (const name of ["linkedin", "twitter", "instagram", "facebook"])
    form[name].value = social[name] || "";
  form.vcardEnabled.checked = Boolean(sig.vcardEnabled);
  form.accent.value = sig.colors?.accent || "#2563eb";
  form.ribbonText.value = sig.ribbonText || "";
  const animation = normalizeAnimationSettings(sig.bannerAnimation);
  form.bannerEffect.value = animation.effect;
  form.bannerSpeed.value = animation.speed;
  form.bannerQuality.value = animation.quality;
  form.bannerIntensity.value = String(animation.intensity);
  updateSelectedTemplate();
  renderAsset(els.photoPreview, sig.photoUrl, "Photo");
  renderAsset(els.bannerPreview, sig.bannerUrl, "Banner");
  updateSelectedBanner();
  updateAnimationControls();
  void refreshAnimationPreview();
  renderWorkflow();
}
function collectForm() {
  const form = els.signatureForm.elements,
    existing = state.signature || {};
  return {
    ...existing,
    fields: {
      name: form.name.value.trim(),
      jobTitle: form.jobTitle.value.trim(),
      department: form.department.value.trim(),
      company: form.company.value.trim(),
      email: form.email.value.trim(),
      website: form.website.value.trim(),
      phone: form.phone.value.trim(),
      mobile: form.mobile.value.trim(),
      address: form.address.value.trim(),
      social: {
        linkedin: form.linkedin.value.trim(),
        twitter: form.twitter.value.trim(),
        instagram: form.instagram.value.trim(),
        facebook: form.facebook.value.trim(),
      },
    },
    colors: { accent: form.accent.value },
    vcardEnabled: form.vcardEnabled.checked,
    ribbonText: form.ribbonText.value.trim(),
    bannerSourceUrl:
      existing.bannerSourceUrl ||
      (/\/generated-banners\//i.test(existing.bannerUrl || "")
        ? ""
        : existing.bannerUrl || ""),
    bannerAnimation: animationSettingsFromForm(),
  };
}
function updateSelectedTemplate() {
  $$(".template-card").forEach((card) =>
    card.classList.toggle(
      "active",
      card.dataset.templateId === state.signature.templateId,
    ),
  );
  $("#ribbonLabel").hidden = state.signature.templateId !== "seasonalRibbon";
}
function renderAsset(container, url, label) {
  container.innerHTML = url
    ? `<img src="${escapeHtml(url)}" alt="${label}">`
    : `<span>${label}</span>`;
}
function updateSelectedBanner() {
  const currentUrl = state.signature?.bannerUrl || "";
  $$("[data-banner-url]").forEach((button) => {
    const selected = currentUrl.endsWith(button.dataset.bannerUrl);
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function renderWorkflow() {
  const status = state.signature.workflowStatus || "approved",
    requires = Boolean(state.runtime?.organization?.settings?.requireApproval),
    self = activeUser()?.id === state.me.id;
  els.workflowBanner.hidden =
    !requires && !["pending", "rejected"].includes(status);
  els.submitApproval.hidden = !requires || !self || status === "pending";
  els.workflowText.textContent =
    status === "pending"
      ? "This signature is waiting for administrator approval."
      : status === "rejected"
        ? `Changes requested${state.signature.reviewNote ? `: ${state.signature.reviewNote}` : ""}`
        : requires
          ? "Changes remain a draft until submitted and approved."
          : "";
}
function schedulePreview(delay = 220) {
  clearTimeout(state.previewTimer);
  state.previewController?.abort();
  state.previewTimer = setTimeout(updatePreview, delay);
}
async function updatePreview() {
  const sequence = ++state.previewSequence,
    controller = new AbortController();
  state.previewController?.abort();
  state.previewController = controller;
  state.signature = collectForm();
  try {
    const rendered = await api("/api/signature/preview", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        userId: state.selectedUserId,
        signature: state.signature,
      }),
    });
    if (sequence !== state.previewSequence) return false;
    state.rendered = rendered;
    els.preview.innerHTML = rendered.html;
    $("#previewMeta").textContent =
      `${state.builtins.find((item) => item.id === state.signature.templateId)?.name || "Custom"} · Outlook-safe HTML`;
    renderWorkflow();
    return true;
  } catch (error) {
    if (error.name === "AbortError") return false;
    if (sequence === state.previewSequence)
      els.preview.innerHTML = `<span class="loading">${escapeHtml(error.message)}</span>`;
    return false;
  } finally {
    if (state.previewController === controller) state.previewController = null;
  }
}

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Signing in…");
  els.authStatus.textContent = "";
  try {
    const result = await api("/api/signature/login", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    if (result.mfaRequired) {
      els.mfaForm.elements.challenge.value = result.challenge;
      showAuthForm(els.mfaForm);
      els.mfaForm.elements.code.focus();
      return;
    }
    state.me = result.user;
    if (shouldOpenControlPlane(state.me)) {
      location.href = "/platform.html";
      return;
    }
    await loadApp();
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
els.mfaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Verifying...");
  els.authStatus.textContent = "";
  try {
    const result = await api("/api/signature/login/mfa", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    state.me = result.user;
    if (shouldOpenControlPlane(state.me)) {
      location.href = "/platform.html";
      return;
    }
    await loadApp();
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
els.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Creating workspace…");
  els.authStatus.textContent = "";
  try {
    const result = await api("/api/signature/register", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    if (result.developmentToken)
      await api("/api/signature/email/verify", {
        method: "POST",
        body: JSON.stringify({ token: result.developmentToken }),
      });
    showAuthForm(els.loginForm);
    els.authStatus.textContent = result.developmentToken
      ? "Workspace created and verified. Sign in to continue."
      : "Workspace created. Check your email to verify your account.";
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
function showAuthForm(form) {
  [
    els.loginForm,
    els.mfaForm,
    els.registerForm,
    $("#forgotForm"),
    $("#resetForm"),
    els.inviteForm,
  ].forEach((item) => (item.hidden = item !== form));
  els.authStatus.textContent = "";
}
$("#showRegister").addEventListener("click", () =>
  showAuthForm(els.registerForm),
);
$("#showLogin").addEventListener("click", () => showAuthForm(els.loginForm));
$$("[data-show-login]").forEach((button) =>
  button.addEventListener("click", () => showAuthForm(els.loginForm)),
);
$("#showForgot").addEventListener("click", () =>
  showAuthForm($("#forgotForm")),
);
$("#microsoftLogin").addEventListener(
  "click",
  () => (location.href = "/auth/microsoft"),
);
$("#forgotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Sending…");
  try {
    const result = await api("/api/signature/password/forgot", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    if (result.developmentToken) {
      showAuthForm($("#resetForm"));
      $("#resetForm").elements.token.value = result.developmentToken;
    } else {
      showAuthForm(els.loginForm);
      els.authStatus.textContent =
        "If that account exists, a reset link has been sent.";
    }
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
$("#resetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Updating…");
  try {
    await api("/api/signature/password/reset", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    showAuthForm(els.loginForm);
    els.authStatus.textContent =
      "Password updated. Sign in with your new password.";
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
els.inviteForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("[type=submit]");
  setBusy(button, true, "Joining...");
  try {
    const result = await api("/api/signature/invitations/accept", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    state.me = result.user;
    await loadApp();
  } catch (error) {
    els.authStatus.textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});
$("#profileButton").addEventListener("click", () => {
  const menu = $("#profileMenu");
  menu.hidden = !menu.hidden;
  $("#profileButton").setAttribute("aria-expanded", String(!menu.hidden));
});
document.addEventListener("click", (event) => {
  if (
    !event.target.closest("#profileButton") &&
    !event.target.closest("#profileMenu")
  )
    $("#profileMenu").hidden = true;
});
$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/signature/logout", { method: "POST", body: "{}" });
    location.href = "/signature.html";
  } catch (error) {
    toast(error.message);
  }
});
els.subscriptionDialog.addEventListener("cancel", (event) =>
  event.preventDefault(),
);
els.subscriptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  setBusy(button, true, "Opening checkoutâ€¦");
  try {
    const result = await api("/api/signature/billing/checkout", {
      method: "POST",
      body: JSON.stringify({
        plan: new FormData(event.currentTarget).get("plan"),
      }),
    });
    location.href = result.url;
  } catch (error) {
    toast(error.message);
    setBusy(button, false);
  }
});
$("#subscriptionLogout").addEventListener("click", async () => {
  try {
    await api("/api/signature/logout", { method: "POST", body: "{}" });
  } finally {
    location.href = "/signature.html";
  }
});
$("#workspaceSwitcher").addEventListener("change", async (event) => {
  try {
    await api("/api/signature/session/switch", {
      method: "POST",
      body: JSON.stringify({ organizationId: event.target.value }),
    });
    location.href = "/signature.html";
  } catch (error) {
    toast(error.message);
    event.target.value = state.me.organizationId;
  }
});
$$("[data-control-tab]").forEach((button) =>
  button.addEventListener("click", () => {
    $$("[data-control-tab]").forEach((item) =>
      item.classList.toggle("active", item === button),
    );
    $$("[data-control-pane]").forEach((pane) =>
      pane.classList.toggle(
        "active",
        pane.dataset.controlPane === button.dataset.controlTab,
      ),
    );
  }),
);
els.employeeSelect.addEventListener("change", () => {
  if (state.dirty && !confirm("Discard unsaved changes?")) {
    els.employeeSelect.value = state.selectedUserId;
    return;
  }
  selectUser(els.employeeSelect.value);
});
els.signatureForm.addEventListener("input", markDirty);
els.signatureForm.addEventListener("change", markDirty);
$(".animation-tools").addEventListener("input", updateAnimationControls);
$(".animation-tools").addEventListener("change", updateAnimationControls);
els.templateGrid.addEventListener("click", (event) => {
  const card = event.target.closest("[data-template-id]");
  if (!card) return;
  state.signature.templateId = card.dataset.templateId;
  if (card.dataset.templateId === "bannerCard" && !state.signature.bannerUrl) {
    state.signature.bannerUrl =
      "/event-banners/cloud-services-modernization.png";
    state.signature.bannerSourceUrl = state.signature.bannerUrl;
  }
  updateSelectedTemplate();
  updateSelectedBanner();
  renderAsset(els.bannerPreview, state.signature.bannerUrl, "Banner preview");
  markDirty();
});
els.customTemplateSelect.addEventListener("change", () => {
  const template = state.templates.find(
    (item) => item.id === els.customTemplateSelect.value,
  );
  if (!template) return;
  state.signature = {
    ...state.signature,
    ...structuredClone(template.patch),
    fields: { ...state.signature.fields, ...(template.patch.fields || {}) },
    colors: { ...state.signature.colors, ...(template.patch.colors || {}) },
  };
  fillForm();
  markDirty();
});
$("#saveTemplate").addEventListener("click", async (event) => {
  const button = event.currentTarget,
    name = prompt("Name this reusable template");
  if (!name) return;
  setBusy(button, true, "Saving…");
  try {
    const result = await api("/api/signature/templates", {
      method: "POST",
      body: JSON.stringify({ name, signature: collectForm() }),
    });
    state.templates.push(result.template);
    renderCustomTemplates();
    toast("Template saved to the workspace");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
});

$$("[data-upload]").forEach((button) =>
  button.addEventListener("click", () =>
    document.getElementById(`${button.dataset.upload}Input`).click(),
  ),
);
$("#photoInput").addEventListener("change", (event) =>
  uploadImage(event.target.files[0], "photo"),
);
$("#bannerInput").addEventListener("change", (event) =>
  uploadImage(event.target.files[0], "banner"),
);
async function uploadImage(file, kind) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024)
    return toast("Image must be 4 MB or smaller");
  const dataUrl = await fileToDataUrl(file);
  try {
    const result = await api("/api/signature/upload", {
      method: "POST",
      body: JSON.stringify({ kind, dataUrl }),
    });
    state.signature[kind === "photo" ? "photoUrl" : "bannerUrl"] = result.url;
    if (kind === "banner") state.signature.bannerSourceUrl = result.url;
    fillForm();
    markDirty();
    toast(`${kind === "photo" ? "Photo" : "Banner"} uploaded`);
  } catch (error) {
    toast(error.message);
  }
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
$("#removeBanner").addEventListener("click", () => {
  state.signature.bannerUrl = "";
  state.signature.bannerSourceUrl = "";
  fillForm();
  markDirty();
});
$$("[data-banner-url]").forEach((button) =>
  button.addEventListener("click", () => {
    state.signature.bannerUrl = button.dataset.bannerUrl;
    state.signature.bannerSourceUrl = button.dataset.bannerUrl;
    fillForm();
    markDirty();
    toast("Banner added to the signature");
  }),
);
$("#animateBanner").addEventListener("click", generateAnimatedBanner);
const ANIMATED_BANNER_MAX_WIDTH = 440,
  ANIMATED_BANNER_MAX_HEIGHT = 220,
  ANIMATION_QUALITY = Object.freeze({
    standard: Object.freeze({
      baseFrames: 20,
      frameDelay: 80,
      label: "Standard",
      renderScale: 1,
    }),
    high: Object.freeze({
      baseFrames: 36,
      frameDelay: 50,
      label: "High",
      renderScale: 1.5,
    }),
    ultra: Object.freeze({
      baseFrames: 48,
      frameDelay: 40,
      label: "Ultra",
      renderScale: 2,
    }),
  }),
  ANIMATION_SPEED_FACTORS = Object.freeze({
    slow: 1.25,
    normal: 1,
    fast: 0.75,
  });

function normalizeAnimationSettings(input = {}) {
  return {
    effect: [
      "tech-pulse",
      "signal-rings",
      "starfield",
      "clean",
      "scan-line",
      "digital-grid",
      "spotlight",
      "soft-pulse",
      "aurora-flow",
      "prism-sweep",
      "particle-trail",
      "cinematic-glow",
    ].includes(input.effect)
      ? input.effect
      : "tech-pulse",
    speed: ["slow", "normal", "fast"].includes(input.speed)
      ? input.speed
      : "normal",
    quality: Object.hasOwn(ANIMATION_QUALITY, input.quality)
      ? input.quality
      : "ultra",
    intensity: Math.max(20, Math.min(100, Number(input.intensity) || 70)),
  };
}
function animationSettingsFromForm() {
  const form = els.signatureForm.elements;
  return normalizeAnimationSettings({
    effect: form.bannerEffect.value,
    speed: form.bannerSpeed.value,
    quality: form.bannerQuality.value,
    intensity: form.bannerIntensity.value,
  });
}
function animationProfile(settings) {
  const quality = ANIMATION_QUALITY[settings.quality],
    frames = Math.max(
      2,
      Math.min(
        60,
        Math.round(
          quality.baseFrames * ANIMATION_SPEED_FACTORS[settings.speed],
        ),
      ),
    );
  return {
    ...quality,
    frames,
    fps: Number((1000 / quality.frameDelay).toFixed(1)),
  };
}
function animationDimensions(image) {
  const sourceWidth = Number(image.naturalWidth || image.width),
    sourceHeight = Number(image.naturalHeight || image.height);
  if (!(sourceWidth > 0 && sourceHeight > 0))
    throw new Error("The selected banner has invalid dimensions.");
  const scale = Math.min(
    1,
    ANIMATED_BANNER_MAX_WIDTH / sourceWidth,
    ANIMATED_BANNER_MAX_HEIGHT / sourceHeight,
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
function updateAnimationControls() {
  const settings = animationSettingsFromForm(),
    profile = animationProfile(settings);
  $("#animationIntensityValue").value = `${settings.intensity}%`;
  $("#animationSummary").textContent =
    `${profile.label} quality · ${profile.frames} frames · ${profile.fps} FPS`;
}
async function refreshAnimationPreview() {
  const source =
      state.signature?.bannerSourceUrl || state.signature?.bannerUrl || "",
    sequence = ++animationPreview.loadSequence,
    shell = $("#animationPreviewShell"),
    canvas = $("#animationPreviewCanvas"),
    ctx = canvas.getContext("2d", { alpha: false });
  window.cancelAnimationFrame(animationPreview.frameRequest);
  animationPreview.frameRequest = null;
  if (!source) {
    animationPreview.image = null;
    animationPreview.source = "";
    shell.classList.remove("has-banner");
    shell.style.removeProperty("aspect-ratio");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $("#animationStatus").textContent = "Ready";
    return;
  }
  try {
    const image = await loadImage(source);
    if (sequence !== animationPreview.loadSequence) return;
    const dimensions = animationDimensions(image);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    shell.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;
    animationPreview.image = image;
    animationPreview.source = source;
    animationPreview.startedAt = window.performance.now();
    shell.classList.add("has-banner");
    $("#animationStatus").textContent = "Live preview";
    const draw = (time) => {
      const settings = animationSettingsFromForm(),
        profile = animationProfile(settings),
        cycle = profile.frames * profile.frameDelay,
        progress = ((time - animationPreview.startedAt) % cycle) / cycle;
      drawAnimationFrame(ctx, image, progress, settings);
      animationPreview.frameRequest = window.requestAnimationFrame(draw);
    };
    animationPreview.frameRequest = window.requestAnimationFrame(draw);
  } catch (error) {
    shell.classList.remove("has-banner");
    $("#animationPreviewEmpty").textContent = "Preview unavailable";
    $("#animationStatus").textContent = error.message;
  }
}
function drawingDimensions(ctx) {
  return {
    width: ctx.animationWidth || ctx.canvas.width,
    height: ctx.animationHeight || ctx.canvas.height,
  };
}
function drawBannerBase(ctx, image) {
  const { width, height } = drawingDimensions(ctx);
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
}
function glow(ctx, x, y, radius, color, alpha) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color.replace("ALPHA", String(alpha)));
  gradient.addColorStop(1, color.replace("ALPHA", "0"));
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}
function drawSweep(ctx, progress, intensity, color) {
  const { width, height } = drawingDimensions(ctx),
    x = -100 + (width + 200) * progress,
    gradient = ctx.createLinearGradient(x - 90, 0, x + 90, 0);
  gradient.addColorStop(0, color.replace("ALPHA", "0"));
  gradient.addColorStop(0.42, color.replace("ALPHA", String(intensity * 0.22)));
  gradient.addColorStop(0.5, color.replace("ALPHA", String(intensity * 0.64)));
  gradient.addColorStop(0.58, color.replace("ALPHA", String(intensity * 0.22)));
  gradient.addColorStop(1, color.replace("ALPHA", "0"));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}
function drawAnimationFrame(ctx, image, progress, input) {
  const settings = normalizeAnimationSettings(input),
    intensity = settings.intensity / 100,
    { width, height } = drawingDimensions(ctx),
    tau = Math.PI * 2,
    effect = settings.effect;
  drawBannerBase(ctx, image);
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  if (effect === "tech-pulse" || effect === "clean") {
    drawSweep(
      ctx,
      progress,
      intensity,
      effect === "tech-pulse"
        ? "rgba(95,229,255,ALPHA)"
        : "rgba(255,255,255,ALPHA)",
    );
    if (effect === "tech-pulse") {
      ctx.fillStyle = `rgba(95,229,255,${intensity * 0.22})`;
      const line = ((progress * (width + 40)) % (width + 40)) - 20;
      ctx.fillRect(line, 0, 2, height);
    }
  } else if (effect === "signal-rings") {
    for (let index = 0; index < 4; index++) {
      const phase = (progress + index / 4) % 1,
        alpha = (1 - phase) * intensity * 0.52;
      ctx.strokeStyle = `rgba(200,225,255,${alpha})`;
      ctx.lineWidth = 1.5 + (1 - phase);
      ctx.beginPath();
      ctx.arc(width * 0.78, height * 0.52, 8 + phase * 125, 0, tau);
      ctx.stroke();
    }
  } else if (effect === "starfield") {
    for (let index = 0; index < 30; index++) {
      const x =
          (index * 83 +
            Math.sin(progress * tau) * (38 + (index % 5) * 7) +
            width) %
          width,
        y = (index * 37 + Math.sin(index * 2.1) * 18 + height) % height,
        twinkle =
          0.35 + 0.65 * ((Math.sin(progress * tau * 2 + index) + 1) / 2),
        size = index % 7 === 0 ? 2 : 1;
      ctx.fillStyle = `rgba(225,240,255,${intensity * twinkle})`;
      ctx.fillRect(x, y, size, size);
    }
  } else if (effect === "scan-line") {
    const scan = ((progress * (width + 90)) % (width + 90)) - 45;
    drawSweep(ctx, progress, intensity * 0.9, "rgba(95,229,255,ALPHA)");
    ctx.fillStyle = `rgba(190,250,255,${intensity * 0.48})`;
    ctx.fillRect(scan, 0, 1.5, height);
  } else if (effect === "digital-grid") {
    const offsetX = progress * 24,
      offsetY = progress * 16;
    ctx.strokeStyle = `rgba(165,190,255,${intensity * 0.28})`;
    ctx.lineWidth = 1;
    for (let x = offsetX - 24; x < width; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = offsetY - 16; y < height; y += 16) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  } else if (effect === "spotlight") {
    const x = width * (0.5 - 0.4 * Math.cos(progress * tau));
    glow(ctx, x, height / 2, 120, "rgba(235,241,255,ALPHA)", intensity * 0.42);
  } else if (effect === "soft-pulse") {
    const strength = Math.sin(progress * Math.PI) ** 2 * intensity * 0.28;
    ctx.fillStyle = `rgba(205,218,255,${strength})`;
    ctx.fillRect(0, 0, width, height);
  } else if (effect === "aurora-flow") {
    const drift = Math.sin(progress * tau),
      drift2 = Math.cos(progress * tau);
    glow(
      ctx,
      width * (0.25 + drift * 0.12),
      height * 0.74,
      170,
      "rgba(63,255,205,ALPHA)",
      intensity * 0.42,
    );
    glow(
      ctx,
      width * (0.7 + drift2 * 0.1),
      height * 0.25,
      180,
      "rgba(112,91,255,ALPHA)",
      intensity * 0.44,
    );
    glow(
      ctx,
      width * (0.5 - drift * 0.08),
      height * 0.5,
      110,
      "rgba(74,181,255,ALPHA)",
      intensity * 0.28,
    );
  } else if (effect === "prism-sweep") {
    const x = -120 + (width + 240) * progress,
      gradient = ctx.createLinearGradient(x - 100, 0, x + 100, 0);
    gradient.addColorStop(0, "rgba(255,70,140,0)");
    gradient.addColorStop(0.28, `rgba(255,70,140,${intensity * 0.24})`);
    gradient.addColorStop(0.46, `rgba(255,218,100,${intensity * 0.32})`);
    gradient.addColorStop(0.62, `rgba(80,225,255,${intensity * 0.34})`);
    gradient.addColorStop(1, "rgba(105,90,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else if (effect === "particle-trail") {
    for (let index = 0; index < 20; index++) {
      const phase = (progress + index / 20) % 1,
        x = phase * width,
        y = height * (0.5 + Math.sin(phase * tau * 1.5 + index) * 0.32),
        alpha = Math.sin(phase * Math.PI) * intensity * 0.68,
        radius = index % 4 === 0 ? 8 : 5;
      glow(ctx, x, y, radius, "rgba(140,235,255,ALPHA)", alpha);
    }
  } else if (effect === "cinematic-glow") {
    const wave = Math.sin(progress * tau),
      pulse = 0.74 + wave * 0.18;
    glow(
      ctx,
      width * (0.28 + wave * 0.08),
      height * 0.58,
      150,
      "rgba(255,179,108,ALPHA)",
      intensity * 0.34 * pulse,
    );
    glow(
      ctx,
      width * (0.75 - wave * 0.07),
      height * 0.42,
      170,
      "rgba(85,118,255,ALPHA)",
      intensity * 0.4 * pulse,
    );
    const vignette = ctx.createRadialGradient(
      width / 2,
      height / 2,
      15,
      width / 2,
      height / 2,
      width * 0.58,
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, `rgba(0,0,0,${intensity * 0.28})`);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}
async function buildAnimationFrames(source, settings, progress) {
  const image = await loadImage(source),
    dimensions = animationDimensions(image),
    profile = animationProfile(settings),
    renderCanvas = document.createElement("canvas"),
    outputCanvas = document.createElement("canvas"),
    frames = [];
  renderCanvas.width = Math.round(dimensions.width * profile.renderScale);
  renderCanvas.height = Math.round(dimensions.height * profile.renderScale);
  outputCanvas.width = dimensions.width;
  outputCanvas.height = dimensions.height;
  const renderContext = renderCanvas.getContext("2d", { alpha: false }),
    outputContext = outputCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
  renderContext.animationWidth = dimensions.width;
  renderContext.animationHeight = dimensions.height;
  renderContext.setTransform(
    profile.renderScale,
    0,
    0,
    profile.renderScale,
    0,
    0,
  );
  outputContext.imageSmoothingEnabled = true;
  outputContext.imageSmoothingQuality = "high";
  for (let frame = 0; frame < profile.frames; frame++) {
    drawAnimationFrame(renderContext, image, frame / profile.frames, settings);
    outputContext.clearRect(0, 0, dimensions.width, dimensions.height);
    outputContext.drawImage(
      renderCanvas,
      0,
      0,
      dimensions.width,
      dimensions.height,
    );
    frames.push(
      bytesToBase64(
        outputContext.getImageData(0, 0, dimensions.width, dimensions.height)
          .data,
      ),
    );
    progress?.(((frame + 1) / profile.frames) * 72);
    if (frame % 4 === 3) await new Promise(window.requestAnimationFrame);
  }
  return { ...dimensions, frames, profile };
}
async function generateAnimatedBanner(event) {
  const source =
    state.signature.bannerSourceUrl || state.signature.bannerUrl || "";
  if (!source) return toast("Choose a banner first");
  const button = event.currentTarget,
    settings = animationSettingsFromForm(),
    profile = animationProfile(settings),
    progress = $("#animationProgress"),
    status = $("#animationStatus");
  setBusy(button, true, "Creating…");
  progress.hidden = false;
  progress.value = 0;
  status.textContent = "Rendering supersampled motion frames";
  try {
    const animation = await buildAnimationFrames(source, settings, (value) => {
      progress.value = value;
    });
    progress.value = 78;
    status.textContent = "Encoding high-detail GIF";
    const result = await api("/api/signature/generated-banners", {
      method: "POST",
      body: JSON.stringify({
        width: animation.width,
        height: animation.height,
        delay: animation.profile.frameDelay,
        quality: settings.quality,
        frames: animation.frames,
      }),
    });
    progress.value = 100;
    state.signature.bannerSourceUrl = source;
    state.signature.bannerAnimation = settings;
    state.signature.bannerUrl = result.url;
    renderAsset(els.bannerPreview, result.url, "Animated banner");
    updateSelectedBanner();
    markDirty();
    const size = Number(result.storedBytes || 0),
      sizeLabel = size
        ? `${size < 1024 * 1024 ? `${Math.round(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}`
        : `${profile.frames} frames`;
    status.textContent = `Animation ready · ${sizeLabel}`;
    toast("Animation created");
  } catch (error) {
    const message =
      error.name === "SecurityError"
        ? "Upload this banner to Signify before animating it."
        : error.message;
    status.textContent = message;
    toast(message);
  } finally {
    setBusy(button, false);
    window.setTimeout(() => {
      progress.hidden = true;
      progress.value = 0;
    }, 700);
  }
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    try {
      if (new URL(src, location.href).origin !== location.origin)
        image.crossOrigin = "anonymous";
    } catch {}
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load the banner image."));
    image.src = src;
  });
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 16384;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

$("#saveSignature").addEventListener("click", saveSignature);
async function saveSignature() {
  if (!els.signatureForm.reportValidity()) return;
  const button = $("#saveSignature");
  setBusy(button, true, "Saving…");
  try {
    let signature = collectForm(),
      requires = Boolean(state.runtime.organization.settings.requireApproval),
      self = state.selectedUserId === state.me.id;
    if (requires && self && state.me.role !== "admin")
      signature.workflowStatus = "draft";
    else if (state.me.role === "admin") signature.workflowStatus = "approved";
    const user = activeUser(),
      result = await api(
        `/api/signature/users/${encodeURIComponent(user.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            displayName: signature.fields.name,
            email: signature.fields.email,
            role: user.role,
            status: user.status,
            signature,
          }),
        },
      );
    Object.assign(user, result.user);
    state.signature = structuredClone(result.user.signature);
    markSaved();
    renderWorkflow();
    toast("Signature saved");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
}
els.submitApproval.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Submitting…");
  try {
    await api("/api/signature/workflow/submit", { method: "POST", body: "{}" });
    state.signature.workflowStatus = "pending";
    renderWorkflow();
    toast("Submitted for approval");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
});
$("#copySignature").addEventListener("click", async () => {
  if (!(await updatePreview()) || !state.rendered) {
    toast("Preview is unavailable");
    return;
  }
  try {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([state.rendered.html], { type: "text/html" }),
          "text/plain": new Blob([state.rendered.plainText], {
            type: "text/plain",
          }),
        }),
      ]);
    } else await navigator.clipboard.writeText(state.rendered.plainText);
    toast("Formatted signature copied");
  } catch {
    toast("Clipboard access was blocked");
  }
});
$("#copyHtml").addEventListener("click", async () => {
  if (!(await updatePreview()) || !state.rendered) {
    toast("Preview is unavailable");
    return;
  }
  try {
    await navigator.clipboard.writeText(state.rendered.html);
    toast("HTML copied");
  } catch {
    toast("Clipboard access was blocked");
  }
});
$("#emailSelf").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Sending…");
  try {
    await api("/api/signature/send-to-self", {
      method: "POST",
      body: JSON.stringify({ signature: collectForm() }),
    });
    toast("Signature emailed to you");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
});
$("#downloadHtml").addEventListener("click", async () => {
  if (!(await updatePreview()) || !state.rendered) {
    toast("Preview is unavailable");
    return;
  }
  const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(activeUser().displayName)} signature</title></head><body>${state.rendered.html}</body></html>`,
    blob = new Blob([documentHtml], { type: "text/html" }),
    link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${activeUser()
    .displayName.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")}-signature.htm`;
  link.click();
  URL.revokeObjectURL(link.href);
});
$("#emailSignature").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, "Sending…");
  try {
    await api("/api/signature/send", {
      method: "POST",
      body: JSON.stringify({ userId: state.selectedUserId }),
    });
    toast("Signature emailed to employee");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty) {
    event.preventDefault();
    event.returnValue = "";
  }
});
boot().catch((error) => {
  els.authStatus.textContent = error.message;
});
