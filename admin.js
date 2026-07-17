"use strict";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
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
function escapeHtml(value) {
  return String(value || "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
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
  form.logoUrl.value = brand.logoUrl || "";
  updateBrandPreview();
}
function updateBrandPreview() {
  const form = $("#brandForm").elements,
    preview = $("#brandPreview");
  preview.querySelector("i").style.background = form.accent.value;
  preview.querySelector("i").style.borderColor = `${form.accent.value}33`;
  preview.querySelector("small").textContent =
    `Role · ${form.companyName.value || "Company"}`;
}
function renderCampaigns() {
  const rows = state.campaigns;
  $("#campaignList").innerHTML = rows.length
    ? rows
        .map(
          (item) =>
            `<article class="campaign-card" data-campaign-id="${item.id}">${item.imageUrl ? `<img class="campaign-thumb" src="${escapeHtml(item.imageUrl)}" alt="">` : '<div class="campaign-thumb"></div>'}<div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message || "No message")} · ${escapeHtml(item.startDate)} to ${escapeHtml(item.endDate)}</small><small>${escapeHtml(item.linkUrl || "No destination URL")}</small></div><span>${escapeHtml(item.status)}</span><button data-delete-campaign type="button">Delete</button></article>`,
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
    billing = state.config.billing || {},
    used = state.config.stats.activeUsers,
    seats = subscription?.seats || 1;
  form.name.value = workspace.name;
  form.publicUrl.value = settings.publicUrl || "";
  form.mediaBaseUrl.value = settings.mediaBaseUrl || "";
  form.assetBaseUrl.value = settings.assetBaseUrl || "";
  form.sessionHours.value = settings.sessionHours || 12;
  form.backupPath.value = settings.backupPath || "";
  form.requireApproval.checked = Boolean(settings.requireApproval);
  $("#planName").textContent = (subscription?.plan || "beta").replace(
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
  $("#billingPlan").innerHTML = (billing.plans || [])
    .map((plan) => `<option value="${plan}">${plan}</option>`)
    .join("");
  $("#startCheckout").disabled = !billing.available;
  $("#manageBilling").disabled =
    !billing.available || !subscription?.stripeCustomerId;
  $("#billingNote").textContent = billing.available
    ? "Billing changes are completed securely through Stripe."
    : "Stripe billing is not configured for this environment.";
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
    await api("/api/signature/logout", { method: "POST", body: "{}" });
    location.href = "/signature.html";
  });
  $("#userSearch").addEventListener("input", renderUsers);
  $("#userFilter").addEventListener("change", renderUsers);
  $("#openCreateUser").addEventListener("click", () => {
    $("#createUserForm").reset();
    $("#inviteLinkField").hidden = true;
    $("#inviteLink").value = "";
    $("#createUserDialog").showModal();
  });
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
  $("#openCampaign").addEventListener("click", () => {
    $("#campaignForm").reset();
    $("#campaignDialog").showModal();
  });
  $("#createCampaign").addEventListener("click", createCampaign);
  $("#campaignList").addEventListener("click", deleteCampaign);
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
  $("#startCheckout").addEventListener("click", startCheckout);
  $("#manageBilling").addEventListener("click", manageBilling);
  const billingResult = new URLSearchParams(location.search).get("billing");
  if (billingResult) {
    toast(
      billingResult === "success"
        ? "Checkout completed. Subscription status updates after Stripe confirms payment."
        : "Checkout canceled.",
    );
    history.replaceState(null, "", `${location.pathname}#settings`);
  }
}
async function createUser() {
  const button = $("#createUser"),
    body = Object.fromEntries(new FormData($("#createUserForm")));
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
  busy(event.currentTarget, true, "Syncing…");
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
    busy(event.currentTarget, false);
  }
}
async function runRollout(event) {
  if (!confirm("Apply this template to the selected team members?")) return;
  busy(event.currentTarget, true, "Rolling out…");
  try {
    const result = await api("/api/signature/bulk-rollout", {
      method: "POST",
      body: JSON.stringify({
        templateId: $("#rolloutTemplate").value,
        overwrite: $("#rolloutOverwrite").checked,
      }),
    });
    toast(`Updated ${result.updated} of ${result.total} signatures`);
    const users = await api("/api/signature/users");
    state.users = users.users;
    renderUsers();
  } catch (error) {
    toast(error.message);
  } finally {
    busy(event.currentTarget, false);
  }
}
async function saveBrand(event) {
  busy(event.currentTarget, true, "Saving…");
  const form = $("#brandForm").elements,
    settings = state.config.workspace.settings;
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
          logoUrl: form.logoUrl.value.trim(),
        },
      }),
    });
    state.config.workspace = result.workspace;
    toast("Brand settings saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(event.currentTarget, false);
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
    status.textContent = file.name;
    toast("Image uploaded");
  } catch (error) {
    status.textContent = "Upload failed";
    toast(error.message);
  }
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
    body = Object.fromEntries(new FormData($("#campaignForm")));
  busy(button, true, "Creating…");
  try {
    await api("/api/signature/campaigns", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.campaigns = (await api("/api/signature/campaigns")).campaigns;
    renderCampaigns();
    $("#campaignDialog").close();
    toast("Campaign scheduled");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function deleteCampaign(event) {
  const button = event.target.closest("[data-delete-campaign]"),
    card = event.target.closest("[data-campaign-id]");
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
  const body = Object.fromEntries(new FormData(event.currentTarget)),
    button = event.currentTarget.querySelector("button");
  busy(button, true, "Saving…");
  try {
    await api("/api/signature/departments", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    state.departments = (await api("/api/signature/departments")).departments;
    renderDepartments();
    event.currentTarget.elements.department.value = "";
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
async function startCheckout(event) {
  const button = event.currentTarget;
  busy(button, true, "Opening…");
  try {
    const result = await api("/api/signature/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: $("#billingPlan").value }),
    });
    location.href = result.url;
  } catch (error) {
    toast(error.message);
    busy(button, false);
  }
}
async function manageBilling(event) {
  const button = event.currentTarget;
  busy(button, true, "Opening…");
  try {
    const result = await api("/api/signature/billing/portal", {
      method: "POST",
      body: "{}",
    });
    location.href = result.url;
  } catch (error) {
    toast(error.message);
    busy(button, false);
  }
}
boot().catch((error) => {
  toast(error.message);
  setTimeout(() => (location.href = "/signature.html"), 1200);
});
