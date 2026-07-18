"use strict";
const { $, $$, api, escapeHtml, initials } = window.Signify;
let state = {
  me: null,
  config: null,
  users: [],
  builtins: [],
  templates: [],
  campaigns: [],
  departments: [],
  approvals: [],
  analytics: [],
  editingCampaignId: null,
};
const brandFonts = {
  system: '"Segoe UI", Helvetica, Arial, sans-serif',
  arial: "Arial, Helvetica, sans-serif",
  trebuchet: '"Trebuchet MS", Arial, sans-serif',
  verdana: "Verdana, Arial, sans-serif",
  georgia: 'Georgia, "Times New Roman", serif',
};
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2500);
}
function busy(button, on, label = "Working…") {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}
function dateLabel(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function templateOptions() {
  return (
    state.builtins
      .map(
        (template) =>
          `<option value="${template.id}">${escapeHtml(template.name)}</option>`,
      )
      .join("") +
    state.templates
      .map(
        (template) =>
          `<option value="${template.id}">${escapeHtml(template.name)} (saved)</option>`,
      )
      .join("")
  );
}

async function boot() {
  const session = await api("/api/signature/session");
  if (!session.user || session.user.role !== "admin") {
    location.href = "/signature.html";
    return;
  }
  state.me = session.user;
  $("#platformNav").hidden = !state.me.applicationOwner;
  await refreshAll();
  bindEvents();
}
async function refreshAll() {
  const [
    config,
    users,
    templates,
    campaigns,
    departments,
    approvals,
    analytics,
  ] = await Promise.all([
    api("/api/signature/admin-config"),
    api("/api/signature/users"),
    api("/api/signature/templates"),
    api("/api/signature/campaigns"),
    api("/api/signature/departments"),
    api("/api/signature/approvals"),
    api("/api/signature/analytics"),
  ]);
  Object.assign(state, {
    config,
    users: users.users,
    builtins: templates.builtins,
    templates: templates.templates,
    campaigns: campaigns.campaigns,
    departments: departments.departments,
    approvals: approvals.approvals,
    analytics: analytics.analytics,
  });
  renderAll();
}
function renderAll() {
  const { workspace, subscription, stats } = state.config;
  $("#workspaceHeader").textContent = workspace.name;
  $("#statUsers").textContent = stats.activeUsers;
  $("#statTemplates").textContent = stats.templates;
  $("#statCampaigns").textContent = stats.campaigns;
  $("#statClicks").textContent = stats.clicks;
  $("#statSeatUsage").textContent =
    `${stats.activeUsers} of ${subscription?.seats || 0} seats`;
  renderReadiness();
  renderActivity();
  renderUsers();
  renderBrand();
  renderCampaigns();
  renderDepartments();
  renderApprovals();
  renderAnalytics();
  renderSettings();
  const options = templateOptions();
  $("#rolloutTemplate").innerHTML = options;
  $("#departmentTemplate").innerHTML = options;
}
function renderReadiness() {
  const checks = state.config.readiness?.checks || [];
  $("#readinessList").innerHTML = checks.length
    ? checks
        .map(
          (item) =>
            `<div class="readiness-item"><span class="status-dot ${item.ok ? "ok" : "warn"}"></span><div><strong>${escapeHtml(item.label)}</strong><small>${item.ok ? "Ready" : "Action required"}</small></div></div>`,
        )
        .join("")
    : '<div class="empty">No readiness checks available.</div>';
}
function renderActivity() {
  const rows = state.config.audit || [];
  $("#activityList").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<div class="activity-item"><time>${escapeHtml(dateLabel(item.createdAt))}</time><div><strong>${escapeHtml(item.action.replaceAll(".", " "))}</strong><small>${escapeHtml(item.actorName)} · ${escapeHtml(item.targetType)}</small></div></div>`,
        )
        .join("")
    : '<div class="empty">No activity recorded yet.</div>';
}
function filteredUsers() {
  const query = $("#userSearch").value.trim().toLowerCase(),
    filter = $("#userFilter").value;
  return state.users.filter((user) => {
    const haystack =
      `${user.displayName} ${user.email} ${user.signature.fields.department || ""}`.toLowerCase();
    const workflow = user.signature.workflowStatus || "approved";
    return (
      (!query || haystack.includes(query)) &&
      (filter === "all" || user.status === filter || workflow === filter)
    );
  });
}
function renderUsers() {
  const users = filteredUsers();
  $("#userRows").innerHTML = users.length
    ? users
        .map(
          (user) =>
            `<tr data-user-id="${user.id}"><td><div class="person-cell"><span class="person-avatar">${initials(user.displayName)}</span><span><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)}</small></span></div></td><td>${escapeHtml(user.signature.fields.department || "—")}</td><td><select class="role-select" data-field="role" ${user.id === state.me.id ? "disabled" : ""}>${["admin", "editor", "viewer"].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}</select></td><td><select class="status-select" data-field="status" ${user.id === state.me.id ? "disabled" : ""}><option value="active" ${user.status === "active" ? "selected" : ""}>Active</option><option value="disabled" ${user.status === "disabled" ? "selected" : ""}>Disabled</option></select></td><td><span class="status-badge ${escapeHtml(user.signature.workflowStatus || "approved")}">${escapeHtml(user.signature.workflowStatus || "approved")}</span></td><td><div class="row-actions"><button data-action="edit" type="button">Open studio</button>${user.id === state.me.id ? "" : `<button class="danger" data-action="remove" type="button">Remove</button>`}</div></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="6"><div class="empty">No people match this view.</div></td></tr>';
}
function renderBrand() {
  const brand = state.config.workspace.settings.brand || {},
    form = $("#brandForm").elements;
  form.locked.checked = Boolean(brand.locked);
  form.companyName.value = brand.companyName || state.config.workspace.name;
  form.accent.value = brand.accent || "#2563eb";
  form.font.value = brand.font || "system";
  form.logoUrl.value = brand.logoUrl || "";
  updateBrandPreview();
}
function updateBrandPreview() {
  const form = $("#brandForm").elements,
    preview = $("#brandPreview");
  preview.querySelector("i").style.background = form.accent.value;
  preview.querySelector("i").style.borderColor = `${form.accent.value}33`;
  preview.style.fontFamily = brandFonts[form.font.value] || brandFonts.system;
  preview.querySelector("small").textContent =
    `Role · ${form.companyName.value || "Company"}`;
}
function renderCampaigns() {
  const rows = state.campaigns;
  $("#campaignList").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<article class="campaign-card" data-campaign-id="${item.id}">${item.imageUrl ? `<img class="campaign-thumb" src="${escapeHtml(item.imageUrl)}" alt="">` : '<div class="campaign-thumb"></div>'}<div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message || "No message")} · ${escapeHtml(item.startDate)} to ${escapeHtml(item.endDate)}</small><small>${escapeHtml(item.linkUrl || "No destination URL")}</small></div><span>${escapeHtml(item.status)}</span><button data-edit-campaign type="button">Edit</button><button data-delete-campaign type="button">Delete</button></article>`,
        )
        .join("")
    : '<div class="content-panel"><div class="empty">No campaigns yet. Create one to add a scheduled promotion to signatures.</div></div>';
}
function renderDepartments() {
  const rows = state.departments;
  $("#departmentList").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<div class="mapping-row" data-department="${escapeHtml(item.department)}" style="--mapping-color:${escapeHtml(item.accent)}"><i></i><strong>${escapeHtml(item.department)}</strong><span>${escapeHtml(state.builtins.find((t) => t.id === item.templateId)?.name || state.templates.find((t) => t.id === item.templateId)?.name || item.templateId)}</span><small>${escapeHtml(item.accent)}</small><button data-delete-department type="button">Remove</button></div>`,
        )
        .join("")
    : '<div class="content-panel"><div class="empty">No department defaults configured.</div></div>';
}
function renderApprovals() {
  const rows = state.approvals;
  $("#approvalCount").textContent = rows.length;
  $("#approvalList").innerHTML = rows.length
    ? rows
        .map(
          (user) =>
            `<article class="approval-card" data-approval-id="${user.id}"><span class="person-avatar">${initials(user.displayName)}</span><div><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)} · submitted ${escapeHtml(dateLabel(user.signature.submittedAt))}</small></div><div class="approval-actions"><input data-note placeholder="Optional review note"><button class="button secondary" data-reject type="button">Request changes</button><button class="button primary" data-approve type="button">Approve</button></div></article>`,
        )
        .join("")
    : '<div class="content-panel"><div class="empty">No signatures are waiting for approval.</div></div>';
}
function renderAnalytics() {
  const rows = state.analytics;
  $("#analyticsRows").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<tr><td><div class="person-cell"><span class="person-avatar">${initials(item.display_name)}</span><span><strong>${escapeHtml(item.display_name)}</strong><small>${escapeHtml(item.email)}</small></span></div></td><td><strong>${item.clicks}</strong></td><td><div class="analytics-breakdown">${
              (item.breakdown || [])
                .slice(0, 4)
                .map(
                  (part) =>
                    `<span>${escapeHtml(part.kind)} ${part.clicks}</span>`,
                )
                .join("") || "—"
            }</div></td><td>${escapeHtml(dateLabel(item.last_clicked_at))}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="4"><div class="empty">Tracked clicks will appear after recipients use signature links.</div></td></tr>';
}
function renderSettings() {
  const workspace = state.config.workspace,
    settings = workspace.settings,
    form = $("#settingsForm").elements,
    subscription = state.config.subscription,
    microsoft = state.config.integrations?.microsoft,
    used = state.config.stats.activeUsers,
    seats = subscription?.seats || 1;
  form.name.value = workspace.name;
  form.publicUrl.value = settings.publicUrl || "";
  form.mediaBaseUrl.value = settings.mediaBaseUrl || "";
  form.assetBaseUrl.value = settings.assetBaseUrl || "";
  form.sessionHours.value = settings.sessionHours || 12;
  form.backupPath.value = settings.backupPath || "";
  form.requireApproval.checked = Boolean(settings.requireApproval);
  $("#planName").textContent = (subscription?.plan || "starter").replace(
    /^./,
    (char) => char.toUpperCase(),
  );
  $("#planStatus").textContent = subscription?.status || "unknown";
  $("#trialEnd").textContent = subscription?.trialEndsAt
    ? `Trial ends ${new Date(subscription.trialEndsAt).toLocaleDateString()}`
    : "No trial end date";
  $("#seatBar").style.width =
    `${Math.min(100, Math.round((used / seats) * 100))}%`;
  $("#seatLabel").textContent = `${used} active people of ${seats} seats`;
  $("#microsoftTenantName").textContent =
    microsoft?.tenantName || "Not connected";
  $("#microsoftStatus").textContent = microsoft?.status || "disconnected";
  $("#microsoftTenantId").textContent = microsoft?.tenantId || "";
  $("#microsoftSenderEmail").value = microsoft?.senderEmail || "";
  $("#connectMicrosoft").textContent = microsoft
    ? "Grant consent again"
    : "Connect Microsoft 365";
  $("#saveMicrosoftSender").disabled = !microsoft;
  $("#disconnectMicrosoft").disabled = !microsoft;
  $("#microsoftNote").textContent = microsoft
    ? microsoft.lastError ||
      "Directory sync and email delivery use this tenant connection."
    : "A Microsoft 365 Global Administrator must grant tenant-wide consent.";
}

function showSection(name) {
  $$("[data-section]").forEach((button) =>
    button.classList.toggle("active", button.dataset.section === name),
  );
  $$("[data-admin-section]").forEach((section) =>
    section.classList.toggle("active", section.dataset.adminSection === name),
  );
  history.replaceState(null, "", `#${name}`);
}
function bindEvents() {
  $$("[data-section]").forEach((button) =>
    button.addEventListener("click", () => showSection(button.dataset.section)),
  );
  const initial = location.hash.slice(1);
  if (initial && $(`[data-section="${initial}"]`)) showSection(initial);
  $("#logout").addEventListener("click", async () => {
    try {
      await api("/api/signature/logout", { method: "POST", body: "{}" });
      location.href = "/signature.html";
    } catch (error) {
      toast(error.message);
    }
  });
  $("#userSearch").addEventListener("input", renderUsers);
  $("#userFilter").addEventListener("change", renderUsers);
  $("#openCreateUser").addEventListener("click", () => {
    $("#createUserForm").reset();
    $("#inviteLinkField").hidden = true;
    $("#inviteLink").value = "";
    $("#createUserDialog").showModal();
  });
  $$("[data-close-user]").forEach((button) =>
    button.addEventListener("click", () => $("#createUserDialog").close()),
  );
  $("#createUser").addEventListener("click", createUser);
  $("#userRows").addEventListener("change", updateMembership);
  $("#userRows").addEventListener("click", handleUserAction);
  $("#syncDirectory").addEventListener("click", syncDirectory);
  if (!state.config.workspace || !state.config.lastDirectorySync)
    $("#syncStatus").textContent = "";
  else
    $("#syncStatus").textContent =
      `Last sync ${dateLabel(state.config.lastDirectorySync.completed_at)}`;
  $("#runRollout").addEventListener("click", runRollout);
  $("#brandForm").addEventListener("input", updateBrandPreview);
  $("#saveBrand").addEventListener("click", saveBrand);
  $("#uploadBrandLogo").addEventListener("click", () =>
    $("#brandLogoInput").click(),
  );
  $("#brandLogoInput").addEventListener("change", (event) =>
    uploadAsset(
      event.target.files[0],
      "logo",
      $("#brandForm").elements.logoUrl,
      $("#brandLogoName"),
    ),
  );
  $("#openCampaign").addEventListener("click", () => openCampaignDialog());
  $$("[data-close-campaign]").forEach((button) =>
    button.addEventListener("click", () => $("#campaignDialog").close()),
  );
  $$("[data-campaign-banner]").forEach((button) =>
    button.addEventListener("click", () => {
      $("#campaignForm").elements.imageUrl.value =
        button.dataset.campaignBanner;
      $("#campaignImageName").textContent = "Repository banner selected";
      updateCampaignBannerSelection();
      updateCampaignComposer();
    }),
  );
  $("#campaignForm").addEventListener("input", updateCampaignComposer);
  $("#campaignForm").elements.imageUrl.addEventListener("input", (event) => {
    updateCampaignBannerSelection();
    $("#campaignImageName").textContent = event.currentTarget.value.trim()
      ? "Custom URL"
      : "Optional";
  });
  $("#createCampaign").addEventListener("click", createCampaign);
  $("#campaignList").addEventListener("click", handleCampaignAction);
  $("#uploadCampaignImage").addEventListener("click", () =>
    $("#campaignImageInput").click(),
  );
  $("#campaignImageInput").addEventListener("change", (event) =>
    uploadAsset(
      event.target.files[0],
      "campaign",
      $("#campaignForm").elements.imageUrl,
      $("#campaignImageName"),
    ),
  );
  $("#departmentForm").addEventListener("submit", saveDepartment);
  $("#departmentList").addEventListener("click", deleteDepartment);
  $("#approvalList").addEventListener("click", reviewApproval);
  $("#saveSettings").addEventListener("click", saveSettings);
  $("#saveMicrosoftSender").addEventListener("click", saveMicrosoftSender);
  $("#disconnectMicrosoft").addEventListener("click", disconnectMicrosoft);
  const microsoftResult = new URLSearchParams(location.search).get("microsoft");
  if (microsoftResult) {
    toast(
      microsoftResult === "connected"
        ? "Microsoft 365 tenant connected"
        : microsoftResult === "canceled"
          ? "Microsoft 365 consent canceled"
          : "Microsoft 365 application credentials are not configured",
    );
    history.replaceState(null, "", `${location.pathname}#settings`);
  }
}
async function createUser() {
  const form = $("#createUserForm");
  if (!form.reportValidity()) return;
  const button = $("#createUser"),
    body = Object.fromEntries(new FormData(form));
  busy(button, true, "Adding…");
  try {
    const result = await api("/api/signature/invitations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (result.developmentToken) {
      const link = `${location.origin}/signature.html?invite=${encodeURIComponent(result.developmentToken)}`;
      $("#inviteLink").value = link;
      $("#inviteLinkField").hidden = false;
      $("#inviteLink").select();
      await navigator.clipboard?.writeText(link).catch(() => {});
      toast("Development invitation link ready");
    } else {
      $("#createUserDialog").close();
      toast("Invitation sent");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function updateMembership(event) {
  const row = event.target.closest("[data-user-id]"),
    user = state.users.find((item) => item.id === row?.dataset.userId);
  if (!user) return;
  const role = row.querySelector("[data-field=role]").value,
    status = row.querySelector("[data-field=status]").value;
  try {
    const result = await api(`/api/signature/users/${user.id}`, {
      method: "PUT",
      body: JSON.stringify({ role, status }),
    });
    Object.assign(user, result.user);
    toast("Access updated");
  } catch (error) {
    renderUsers();
    toast(error.message);
  }
}
async function handleUserAction(event) {
  const button = event.target.closest("[data-action]"),
    row = event.target.closest("[data-user-id]");
  if (!button || !row) return;
  const id = row.dataset.userId;
  if (button.dataset.action === "edit") {
    location.href = `/signature.html?user=${encodeURIComponent(id)}`;
    return;
  }
  if (!confirm("Remove this person from the workspace?")) return;
  busy(button, true, "Removing…");
  try {
    await api(`/api/signature/users/${id}`, { method: "DELETE" });
    state.users = state.users.filter((user) => user.id !== id);
    renderUsers();
    toast("Person removed");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function syncDirectory(event) {
  const button = event.currentTarget;
  busy(button, true, "Syncing…");
  $("#syncStatus").textContent = "Connecting to Microsoft 365…";
  try {
    const result = await api("/api/signature/directory-sync", {
      method: "POST",
      body: "{}",
    });
    $("#syncStatus").textContent =
      `${result.seen} licensed users found · ${result.added} added`;
    const users = await api("/api/signature/users");
    state.users = users.users;
    renderUsers();
    toast("Directory sync complete");
  } catch (error) {
    $("#syncStatus").textContent = error.message;
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function runRollout(event) {
  if (!confirm("Apply this template to the selected team members?")) return;
  const button = event.currentTarget;
  busy(button, true, "Rolling out…");
  try {
    const result = await api("/api/signature/bulk-rollout", {
      method: "POST",
      body: JSON.stringify({
        templateId: $("#rolloutTemplate").value,
        overwrite: $("#rolloutOverwrite").checked,
        sendEmail: $("#rolloutEmail").checked,
      }),
    });
    const details = [
      `Updated ${result.updated} of ${result.total} signatures`,
      result.emailed ? `${result.emailed} emailed` : "",
      result.skipped ? `${result.skipped} skipped` : "",
      result.errors?.length ? `${result.errors.length} email errors` : "",
    ].filter(Boolean);
    toast(details.join(" · "));
    const users = await api("/api/signature/users");
    state.users = users.users;
    renderUsers();
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function saveBrand(event) {
  const button = event.currentTarget,
    form = $("#brandForm").elements,
    settings = state.config.workspace.settings;
  busy(button, true, "Saving…");
  try {
    const result = await api("/api/signature/admin-config", {
      method: "PUT",
      body: JSON.stringify({
        name: state.config.workspace.name,
        publicUrl: settings.publicUrl,
        assetBaseUrl: settings.assetBaseUrl,
        mediaBaseUrl: settings.mediaBaseUrl,
        sessionHours: settings.sessionHours,
        backupPath: settings.backupPath,
        requireApproval: settings.requireApproval,
        brand: {
          locked: form.locked.checked,
          companyName: form.companyName.value.trim(),
          accent: form.accent.value,
          font: form.font.value,
          logoUrl: form.logoUrl.value.trim(),
        },
      }),
    });
    state.config.workspace = result.workspace;
    toast("Brand settings saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function uploadAsset(file, kind, input, status) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024)
    return toast("Image must be 4 MB or smaller");
  status.textContent = "Uploading…";
  try {
    const dataUrl = await fileDataUrl(file),
      result = await api("/api/signature/upload", {
        method: "POST",
        body: JSON.stringify({ kind, dataUrl }),
      });
    input.value = result.url;
    if (input.name === "imageUrl") {
      updateCampaignBannerSelection();
      updateCampaignComposer();
    }
    if (input.name === "logoUrl") updateBrandPreview();
    status.textContent = file.name;
    toast("Image uploaded");
  } catch (error) {
    status.textContent = "Upload failed";
    toast(error.message);
  }
}
function updateCampaignBannerSelection() {
  const selectedUrl = $("#campaignForm").elements.imageUrl.value.trim();
  $$("[data-campaign-banner]").forEach((button) => {
    const selected = selectedUrl.endsWith(button.dataset.campaignBanner);
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function campaignEventLabel(form) {
  if (form.elements.eventLabel.value.trim())
    return form.elements.eventLabel.value.trim();
  const date = form.elements.startDate.value;
  if (!date) return "Event details";
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
function updateCampaignComposer() {
  const form = $("#campaignForm"),
    imageUrl = form.elements.imageUrl.value.trim(),
    image = $("#campaignComposerImage"),
    preview = $("#campaignComposerPreview");
  $("#campaignPreviewTitle").textContent =
    form.elements.title.value.trim() || "Campaign headline";
  $("#campaignPreviewCta").textContent =
    form.elements.ctaLabel.value.trim() || "Learn more";
  $("#campaignPreviewBadge").textContent = (
    form.elements.badgeLabel.value.trim() || "IT Done Right"
  )
    .split(/\s+/)
    .slice(0, 3)
    .join("\n");
  $("#campaignPreviewEvent").textContent = campaignEventLabel(form)
    .split(/\s*[·|]\s*/)
    .slice(0, 2)
    .join("\n");
  preview.style.setProperty(
    "--campaign-overlay-color",
    form.elements.overlayColor.value,
  );
  preview.style.setProperty(
    "--campaign-overlay-font",
    form.elements.overlayFont.value,
  );
  preview.style.setProperty(
    "--campaign-font-weight",
    form.elements.overlayFontWeight.value,
  );
  preview.style.setProperty(
    "--campaign-title-size",
    form.elements.headlineSize.value,
  );
  preview.style.setProperty(
    "--campaign-text-color",
    form.elements.overlayTextColor.value,
  );
  $("#headlineSizeValue").textContent =
    `${form.elements.headlineSize.value} px`;
  preview.classList.toggle(
    "overlay-disabled",
    !form.elements.overlayEnabled.checked,
  );
  if (!imageUrl) {
    image.hidden = true;
    image.removeAttribute("src");
    return;
  }
  image.onload = () => (image.hidden = false);
  image.onerror = () => (image.hidden = true);
  image.src = imageUrl;
}
function loadCampaignImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image(),
      url = new URL(source, location.origin);
    if (url.origin !== location.origin) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        new Error(
          "That background cannot be rendered. Upload it first or disable the overlay.",
        ),
      );
    image.src = url.href;
  });
}
function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function campaignCanvasFont(weight, size, family) {
  return `${weight} ${size}px ${family}`;
}
function fitCampaignText(
  ctx,
  text,
  maxWidth,
  startSize,
  minSize = 20,
  weight = 700,
  family = "Arial, sans-serif",
) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = campaignCanvasFont(weight, size, family);
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}
async function renderCampaignOverlay(form) {
  const width = 880,
    height = 200,
    canvas = document.createElement("canvas"),
    ctx = canvas.getContext("2d"),
    backgroundUrl = form.elements.imageUrl.value.trim();
  canvas.width = width;
  canvas.height = height;
  ctx.fillStyle = "#11141c";
  ctx.fillRect(0, 0, width, height);
  if (backgroundUrl) {
    const image = await loadCampaignImage(backgroundUrl),
      scale = Math.max(width / image.width, height / image.height),
      drawWidth = image.width * scale,
      drawHeight = image.height * scale;
    ctx.drawImage(
      image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
  }
  const shade = ctx.createLinearGradient(0, 0, width, 0);
  shade.addColorStop(0, "rgba(8,11,19,.82)");
  shade.addColorStop(0.48, "rgba(8,11,19,.18)");
  shade.addColorStop(1, "rgba(8,11,19,.72)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, width, height);

  const title = form.elements.title.value.trim(),
    cta = form.elements.ctaLabel.value.trim() || "Learn more",
    badge = form.elements.badgeLabel.value.trim() || "IT Done Right",
    eventLabel = campaignEventLabel(form),
    accent = form.elements.overlayColor.value || "#2b2d8f",
    textColor = form.elements.overlayTextColor.value || "#ffffff",
    fontFamily = form.elements.overlayFont.value || "Arial, sans-serif",
    fontWeight = Number(form.elements.overlayFontWeight.value) || 700,
    headlineSize = (Number(form.elements.headlineSize.value) || 20) * 2;
  ctx.fillStyle = textColor;
  ctx.textBaseline = "middle";
  const titleSize = fitCampaignText(
    ctx,
    title,
    300,
    headlineSize,
    26,
    fontWeight,
    fontFamily,
  );
  ctx.font = campaignCanvasFont(fontWeight, titleSize, fontFamily);
  ctx.fillText(title, 34, 64, 300);

  ctx.font = campaignCanvasFont(fontWeight, 19, fontFamily);
  const ctaWidth = Math.min(
    210,
    Math.max(104, ctx.measureText(cta).width + 34),
  );
  roundedRect(ctx, 34, 112, ctaWidth, 48, 24);
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.fillText(cta, 34 + ctaWidth / 2, 136, ctaWidth - 28);

  const badgeX = 365,
    badgeY = 22,
    badgeSize = 156;
  ctx.fillStyle = accent;
  ctx.fillRect(badgeX, badgeY, badgeSize, badgeSize);
  ctx.strokeStyle = "rgba(255,255,255,.88)";
  ctx.lineWidth = 3;
  ctx.strokeRect(badgeX, badgeY, badgeSize, badgeSize);
  ctx.fillStyle = textColor;
  const badgeLines = badge.split(/\s+/).slice(0, 3),
    longestBadgeLine = badgeLines.reduce(
      (longest, line) => (line.length > longest.length ? line : longest),
      "",
    ),
    badgeSizePx = fitCampaignText(
      ctx,
      longestBadgeLine,
      badgeSize - 24,
      27,
      15,
      fontWeight,
      fontFamily,
    ),
    badgeLineHeight = badgeSizePx * 1.08,
    badgeStartY =
      badgeY + badgeSize / 2 - ((badgeLines.length - 1) * badgeLineHeight) / 2;
  ctx.font = campaignCanvasFont(fontWeight, badgeSizePx, fontFamily);
  badgeLines.forEach((line, index) =>
    ctx.fillText(
      line,
      badgeX + badgeSize / 2,
      badgeStartY + index * badgeLineHeight,
      badgeSize - 24,
    ),
  );

  ctx.textAlign = "right";
  const eventLines = eventLabel.split(/\s*[·|]\s*/).slice(0, 2),
    longestEventLine = eventLines.reduce(
      (longest, line) => (line.length > longest.length ? line : longest),
      "",
    ),
    eventSize = fitCampaignText(
      ctx,
      longestEventLine,
      220,
      28,
      17,
      fontWeight,
      fontFamily,
    ),
    eventLineHeight = eventSize * 1.12,
    eventStartY = 100 - ((eventLines.length - 1) * eventLineHeight) / 2;
  ctx.font = campaignCanvasFont(fontWeight, eventSize, fontFamily);
  eventLines.forEach((line, index) =>
    ctx.fillText(line, 846, eventStartY + index * eventLineHeight, 220),
  );
  return canvas.toDataURL("image/png");
}
function fileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function createCampaign() {
  const button = $("#createCampaign"),
    form = $("#campaignForm");
  if (!form.reportValidity()) return;
  const body = Object.fromEntries(new FormData(form));
  busy(button, true, "Rendering…");
  try {
    if (form.elements.overlayEnabled.checked) {
      const dataUrl = await renderCampaignOverlay(form),
        image = await api("/api/signature/upload", {
          method: "POST",
          body: JSON.stringify({ kind: "campaign-overlay", dataUrl }),
        });
      body.imageUrl = image.url;
    }
    delete body.overlayEnabled;
    delete body.ctaLabel;
    delete body.badgeLabel;
    delete body.eventLabel;
    delete body.overlayColor;
    delete body.overlayFont;
    delete body.overlayFontWeight;
    delete body.headlineSize;
    delete body.overlayTextColor;
    const editing = state.editingCampaignId;
    button.textContent = editing ? "Saving…" : "Scheduling…";
    await api(
      editing
        ? `/api/signature/campaigns/${encodeURIComponent(editing)}`
        : "/api/signature/campaigns",
      {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(body),
      },
    );
    state.campaigns = (await api("/api/signature/campaigns")).campaigns;
    renderCampaigns();
    $("#campaignDialog").close();
    toast(editing ? "Campaign updated" : "Campaign scheduled");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
function openCampaignDialog(campaign = null) {
  const form = $("#campaignForm");
  form.reset();
  state.editingCampaignId = campaign?.id || null;
  $("#campaignDialogEyebrow").textContent = campaign
    ? "Edit campaign"
    : "New campaign";
  $("#campaignDialogTitle").textContent = campaign
    ? "Update signature promotion"
    : "Schedule signature promotion";
  $("#createCampaign").textContent = campaign
    ? "Save campaign"
    : "Schedule campaign";
  if (campaign) {
    for (const name of [
      "title",
      "message",
      "linkUrl",
      "imageUrl",
      "startDate",
      "endDate",
      "status",
    ])
      form.elements[name].value = campaign[name] || "";
    form.elements.overlayEnabled.checked = false;
  }
  $("#campaignImageName").textContent = campaign?.imageUrl
    ? "Current campaign banner"
    : "Optional";
  updateCampaignBannerSelection();
  updateCampaignComposer();
  $("#campaignDialog").showModal();
}
async function handleCampaignAction(event) {
  const card = event.target.closest("[data-campaign-id]");
  if (!card) return;
  if (event.target.closest("[data-edit-campaign]")) {
    const campaign = state.campaigns.find(
      (item) => item.id === card.dataset.campaignId,
    );
    if (campaign) openCampaignDialog(campaign);
    return;
  }
  const button = event.target.closest("[data-delete-campaign]");
  if (!button || !card || !confirm("Delete this campaign?")) return;
  try {
    await api(`/api/signature/campaigns/${card.dataset.campaignId}`, {
      method: "DELETE",
    });
    state.campaigns = state.campaigns.filter(
      (item) => item.id !== card.dataset.campaignId,
    );
    renderCampaigns();
    toast("Campaign deleted");
  } catch (error) {
    toast(error.message);
  }
}
async function saveDepartment(event) {
  event.preventDefault();
  const form = event.currentTarget,
    body = Object.fromEntries(new FormData(form)),
    button = form.querySelector("button");
  busy(button, true, "Saving…");
  try {
    await api("/api/signature/departments", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    state.departments = (await api("/api/signature/departments")).departments;
    renderDepartments();
    form.elements.department.value = "";
    toast("Department default saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function deleteDepartment(event) {
  const button = event.target.closest("[data-delete-department]"),
    row = event.target.closest("[data-department]");
  if (!button || !row) return;
  try {
    await api(
      `/api/signature/departments/${encodeURIComponent(row.dataset.department)}`,
      { method: "DELETE" },
    );
    state.departments = state.departments.filter(
      (item) => item.department !== row.dataset.department,
    );
    renderDepartments();
    toast("Department default removed");
  } catch (error) {
    toast(error.message);
  }
}
async function reviewApproval(event) {
  const button = event.target.closest("[data-approve],[data-reject]"),
    card = event.target.closest("[data-approval-id]");
  if (!button || !card) return;
  const action = button.hasAttribute("data-approve") ? "approve" : "reject",
    note = card.querySelector("[data-note]").value;
  busy(button, true, action === "approve" ? "Approving…" : "Sending…");
  try {
    await api(`/api/signature/approvals/${card.dataset.approvalId}/${action}`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    state.approvals = state.approvals.filter(
      (item) => item.id !== card.dataset.approvalId,
    );
    renderApprovals();
    toast(action === "approve" ? "Signature approved" : "Changes requested");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function saveSettings(event) {
  const form = $("#settingsForm").elements,
    button = event.currentTarget;
  busy(button, true, "Saving…");
  try {
    const body = {
      name: form.name.value.trim(),
      publicUrl: form.publicUrl.value.trim(),
      mediaBaseUrl: form.mediaBaseUrl.value.trim(),
      assetBaseUrl: form.assetBaseUrl.value.trim(),
      sessionHours: Number(form.sessionHours.value),
      backupPath: form.backupPath.value.trim(),
      requireApproval: form.requireApproval.checked,
      brand: state.config.workspace.settings.brand,
    };
    const result = await api("/api/signature/admin-config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    state.config.workspace = result.workspace;
    $("#workspaceHeader").textContent = result.workspace.name;
    toast("Workspace settings saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function saveMicrosoftSender(event) {
  const button = event.currentTarget;
  busy(button, true, "Saving...");
  try {
    const result = await api("/api/signature/microsoft-connection", {
      method: "PUT",
      body: JSON.stringify({
        senderEmail: $("#microsoftSenderEmail").value.trim(),
      }),
    });
    state.config.integrations.microsoft = result.microsoft;
    renderSettings();
    toast("Microsoft sender mailbox saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function disconnectMicrosoft(event) {
  if (!confirm("Disconnect Microsoft 365 from this tenant?")) return;
  const reason = prompt("Reason for disconnecting Microsoft 365:");
  if (!reason) return;
  const button = event.currentTarget;
  busy(button, true, "Disconnecting...");
  try {
    await api("/api/signature/microsoft-connection", {
      method: "DELETE",
      body: JSON.stringify({ reason }),
    });
    state.config.integrations.microsoft = null;
    renderSettings();
    toast("Microsoft 365 disconnected");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
boot().catch((error) => {
  toast(error.message);
  setTimeout(() => (location.href = "/signature.html"), 1200);
});
