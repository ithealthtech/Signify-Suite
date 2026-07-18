"use strict";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const els = {
  authView: $("#authView"),
  appView: $("#appView"),
  loginForm: $("#loginForm"),
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
};

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
      : "";
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error?.message || `Request failed (${response.status})`,
    );
  return data;
}
function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}
function initials(name) {
  return String(name || "SC")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function activeUser() {
  return (
    state.users.find((user) => user.id === state.selectedUserId) ||
    state.users[0] ||
    state.me
  );
}
function setBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
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
    verification = query.get("verify"),
    reset = query.get("reset"),
    invitation = query.get("invite");
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
    await loadApp();
  } else {
    els.authView.hidden = false;
    els.appView.hidden = true;
  }
}
async function loadApp() {
  els.authView.hidden = true;
  els.appView.hidden = false;
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
function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
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
  updateSelectedTemplate();
  renderAsset(els.photoPreview, sig.photoUrl, "Photo");
  renderAsset(els.bannerPreview, sig.bannerUrl, "Banner");
  updateSelectedBanner();
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
  state.previewTimer = setTimeout(updatePreview, delay);
}
async function updatePreview() {
  const sequence = ++state.previewSequence;
  state.signature = collectForm();
  try {
    const rendered = await api("/api/signature/preview", {
      method: "POST",
      body: JSON.stringify({
        userId: state.selectedUserId,
        signature: state.signature,
      }),
    });
    if (sequence !== state.previewSequence) return;
    state.rendered = rendered;
    els.preview.innerHTML = rendered.html;
    $("#previewMeta").textContent =
      `${state.builtins.find((item) => item.id === state.signature.templateId)?.name || "Custom"} · Outlook-safe HTML`;
    renderWorkflow();
  } catch (error) {
    if (sequence === state.previewSequence)
      els.preview.innerHTML = `<span class="loading">${escapeHtml(error.message)}</span>`;
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
    state.me = result.user;
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
  await api("/api/signature/logout", { method: "POST", body: "{}" });
  location.href = "/signature.html";
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
els.templateGrid.addEventListener("click", (event) => {
  const card = event.target.closest("[data-template-id]");
  if (!card) return;
  state.signature.templateId = card.dataset.templateId;
  updateSelectedTemplate();
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
  fillForm();
  markDirty();
});
$$("[data-banner-url]").forEach((button) =>
  button.addEventListener("click", () => {
    state.signature.bannerUrl = button.dataset.bannerUrl;
    fillForm();
    markDirty();
    toast("Banner added to the signature");
  }),
);
$("#animateBanner").addEventListener("click", async (event) => {
  if (!state.signature.bannerUrl) return toast("Upload a banner first");
  const button = event.currentTarget;
  setBusy(button, true, "Generating…");
  try {
    const frames = await buildAnimationFrames(
      state.signature.bannerUrl,
      $('[name="bannerEffect"]:checked').value,
    );
    const result = await api("/api/signature/generated-banners", {
      method: "POST",
      body: JSON.stringify({ width: 650, height: 100, delay: 80, frames }),
    });
    state.signature.bannerUrl = result.url;
    fillForm();
    markDirty();
    toast("Animated banner ready");
  } catch (error) {
    toast(error.message);
  } finally {
    setBusy(button, false);
  }
});
async function buildAnimationFrames(source, effect) {
  const image = await loadImage(source),
    canvas = document.createElement("canvas"),
    width = 650,
    height = 100;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d"),
    frames = [];
  for (let frame = 0; frame < 12; frame++) {
    ctx.clearRect(0, 0, width, height);
    const scale = Math.max(width / image.width, height / image.height),
      drawWidth = image.width * scale,
      drawHeight = image.height * scale;
    ctx.drawImage(
      image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    const t = frame / 12;
    if (effect === "starfield") {
      ctx.fillStyle = "rgba(255,255,255,.8)";
      for (let i = 0; i < 18; i++) {
        const x = (i * 79 + frame * 31) % width,
          y = (i * 37 + frame * 7) % height;
        ctx.fillRect(x, y, 2, 2);
      }
    } else if (effect === "signal-rings") {
      ctx.strokeStyle = "rgba(255,255,255,.42)";
      ctx.lineWidth = 2;
      for (let r = 0; r < 3; r++) {
        ctx.beginPath();
        ctx.arc(
          width * 0.78,
          height * 0.52,
          10 + ((frame * 8 + r * 26) % 110),
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    } else {
      const gradient = ctx.createLinearGradient(
        -140 + width * t,
        0,
        width * t + 140,
        0,
      );
      gradient.addColorStop(0, "rgba(255,255,255,0)");
      gradient.addColorStop(
        0.5,
        effect === "tech-pulse"
          ? "rgba(95,229,255,.36)"
          : "rgba(255,255,255,.28)",
      );
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
    }
    frames.push(bytesToBase64(ctx.getImageData(0, 0, width, height).data));
  }
  return frames;
}
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
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
  await updatePreview();
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
  await updatePreview();
  await navigator.clipboard.writeText(state.rendered.html);
  toast("HTML copied");
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
  await updatePreview();
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
