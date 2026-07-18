"use strict";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { page: 1, pagination: null, organizations: [], detail: null };

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
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(options.headers || {}),
      },
      ...options,
    }),
    data = await response.json().catch(() => ({}));
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
function dateLabel(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3000);
}
function busy(button, active, label = "Working...") {
  if (active) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}
function showSection(name) {
  $$("[data-section]").forEach((button) =>
    button.classList.toggle("active", button.dataset.section === name),
  );
  $$("[data-admin-section]").forEach((section) =>
    section.classList.toggle("active", section.dataset.adminSection === name),
  );
}
async function loadSession() {
  const result = await api("/api/platform/session");
  $("#statOrganizations").textContent = result.stats.organizations;
  $("#statActive").textContent = result.stats.active;
  $("#statSuspended").textContent = result.stats.suspended;
  $("#statMicrosoft").textContent = result.stats.microsoftConnected;
  $("#stripeStatus").textContent = result.stripe.configured
    ? "Stripe is configured for Application Owner checkout."
    : "Stripe is not configured in this environment.";
  $("#createCheckout").disabled = !result.stripe.configured;
}
async function loadTenants() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: "25",
  });
  const search = $("#tenantSearch").value.trim(),
    status = $("#tenantStatus").value;
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  const result = await api(`/api/platform/organizations?${params}`);
  state.organizations = result.organizations;
  state.pagination = result.pagination;
  $("#tenantRows").innerHTML = result.organizations.length
    ? result.organizations
        .map(
          (tenant) =>
            `<tr><td><span class="tenant-name"><strong>${escapeHtml(tenant.name)}</strong><small>${escapeHtml(tenant.slug)}</small></span></td><td><span class="status-dot ${tenant.status}">${escapeHtml(tenant.status)}</span></td><td>${tenant.memberCount}</td><td>${escapeHtml(tenant.subscription.plan || "-")}<br><small class="muted">${tenant.subscription.seats || 0} seats</small></td><td><span class="status-dot ${tenant.microsoft?.status || "disconnected"}">${escapeHtml(tenant.microsoft?.tenantName || "Not connected")}</span></td><td><button class="button" data-tenant-id="${tenant.id}" type="button">Manage</button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="6"><div class="empty">No tenants match this view.</div></td></tr>';
  $("#pageLabel").textContent =
    `Page ${result.pagination.page} of ${result.pagination.pages}`;
  $("#previousPage").disabled = result.pagination.page <= 1;
  $("#nextPage").disabled = result.pagination.page >= result.pagination.pages;
}
async function loadOwners() {
  const result = await api("/api/platform/owners");
  $("#ownerRows").innerHTML = result.owners
    .map(
      (owner) =>
        `<tr><td><strong>${escapeHtml(owner.displayName)}</strong><br><small>${escapeHtml(owner.email)}</small></td><td>${escapeHtml(owner.status)}</td><td>${escapeHtml(dateLabel(owner.createdAt))}</td><td><button class="button danger" data-owner-id="${owner.id}" type="button" ${owner.status !== "active" ? "disabled" : ""}>Revoke</button></td></tr>`,
    )
    .join("");
}
async function loadAudit() {
  const result = await api("/api/platform/audit");
  $("#auditRows").innerHTML = result.audit.length
    ? result.audit
        .map(
          (item) =>
            `<tr><td>${escapeHtml(dateLabel(item.createdAt))}</td><td>${escapeHtml(item.actorName)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.organizationId || item.targetId || "-")}</td><td>${escapeHtml(item.reason || "-")}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5"><div class="empty">No application activity recorded.</div></td></tr>';
}
async function openTenant(id) {
  const result = await api(
    `/api/platform/organizations/${encodeURIComponent(id)}`,
  );
  state.detail = result;
  $("#detailName").textContent = result.organization.name;
  $("#detailSlug").textContent = result.organization.slug;
  $("#detailSummary").innerHTML =
    `<div><span>Status</span><strong>${escapeHtml(result.organization.status)}</strong></div><div><span>Microsoft 365</span><strong>${escapeHtml(result.microsoft?.tenantName || "Not connected")}</strong></div><div><span>People</span><strong>${result.members.length} of ${result.subscription?.seats || 0}</strong></div>`;
  const statusForm = $("#tenantStatusForm").elements,
    subscriptionForm = $("#subscriptionForm").elements,
    checkoutForm = $("#checkoutForm").elements;
  statusForm.status.value = result.organization.status;
  statusForm.reason.value = "";
  subscriptionForm.plan.value = result.subscription.plan;
  subscriptionForm.status.value = result.subscription.status;
  subscriptionForm.seats.value = result.subscription.seats;
  subscriptionForm.stripeCustomerId.value =
    result.subscription.stripeCustomerId || "";
  subscriptionForm.stripeSubscriptionId.value =
    result.subscription.stripeSubscriptionId || "";
  subscriptionForm.reason.value = "";
  checkoutForm.plan.value = result.subscription.plan;
  checkoutForm.customerEmail.value =
    result.members.find((member) => member.role === "admin")?.email || "";
  $("#detailMembers").innerHTML = result.members.length
    ? result.members
        .map(
          (member) =>
            `<div><span><strong>${escapeHtml(member.displayName)}</strong><br><small>${escapeHtml(member.email)}</small></span><span>${escapeHtml(member.role)}</span><span>${escapeHtml(member.status)}</span></div>`,
        )
        .join("")
    : "<div><span>No accepted tenant members yet.</span></div>";
  if (!$("#tenantDialog").open) $("#tenantDialog").showModal();
}
async function createTenant(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = $("#createTenant"),
    body = Object.fromEntries(new FormData(form));
  body.seats = Number(body.seats);
  busy(button, true, "Creating...");
  try {
    const result = await api("/api/platform/organizations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    $("#invitationUrl").value = result.invitationUrl;
    $("#invitationResult").hidden = false;
    $("#invitationUrl").select();
    await navigator.clipboard?.writeText(result.invitationUrl).catch(() => {});
    toast("Tenant created and invitation URL copied");
    await Promise.all([loadSession(), loadTenants()]);
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function updateTenantStatus(event) {
  event.preventDefault();
  const button = event.submitter,
    body = Object.fromEntries(new FormData(event.currentTarget));
  busy(button, true, "Saving...");
  try {
    await api(
      `/api/platform/organizations/${state.detail.organization.id}/status`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    toast("Tenant lifecycle updated");
    await Promise.all([
      loadSession(),
      loadTenants(),
      openTenant(state.detail.organization.id),
    ]);
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function updateSubscription(event) {
  event.preventDefault();
  const button = event.submitter,
    body = Object.fromEntries(new FormData(event.currentTarget));
  body.seats = Number(body.seats);
  busy(button, true, "Saving...");
  try {
    await api(
      `/api/platform/organizations/${state.detail.organization.id}/subscription`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    toast("Subscription updated");
    await Promise.all([
      loadTenants(),
      openTenant(state.detail.organization.id),
    ]);
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function createCheckout(event) {
  event.preventDefault();
  const button = event.submitter,
    body = Object.fromEntries(new FormData(event.currentTarget));
  busy(button, true, "Creating...");
  try {
    const result = await api(
      `/api/platform/organizations/${state.detail.organization.id}/billing/checkout`,
      { method: "POST", body: JSON.stringify(body) },
    );
    window.open(result.url, "_blank", "noopener");
    toast("Stripe checkout created");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
function bindEvents() {
  $$("[data-section]").forEach((button) =>
    button.addEventListener("click", async () => {
      showSection(button.dataset.section);
      if (button.dataset.section === "owners") await loadOwners();
      if (button.dataset.section === "audit") await loadAudit();
    }),
  );
  $("#openCreateTenant").addEventListener("click", () => {
    $("#createTenantForm").reset();
    $("#invitationResult").hidden = true;
    $("#createTenantDialog").showModal();
  });
  $$("[data-close-create]").forEach((button) =>
    button.addEventListener("click", () => $("#createTenantDialog").close()),
  );
  $$("[data-close-detail]").forEach((button) =>
    button.addEventListener("click", () => $("#tenantDialog").close()),
  );
  $("#createTenantForm").addEventListener("submit", createTenant);
  $("#tenantStatusForm").addEventListener("submit", updateTenantStatus);
  $("#subscriptionForm").addEventListener("submit", updateSubscription);
  $("#checkoutForm").addEventListener("submit", createCheckout);
  $("#tenantRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tenant-id]");
    if (button)
      openTenant(button.dataset.tenantId).catch((error) =>
        toast(error.message),
      );
  });
  let searchTimer;
  $("#tenantSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.page = 1;
      loadTenants().catch((error) => toast(error.message));
    }, 250);
  });
  $("#tenantStatus").addEventListener("change", () => {
    state.page = 1;
    loadTenants().catch((error) => toast(error.message));
  });
  $("#refreshTenants").addEventListener("click", () =>
    loadTenants().catch((error) => toast(error.message)),
  );
  $("#previousPage").addEventListener("click", () => {
    state.page -= 1;
    loadTenants().catch((error) => toast(error.message));
  });
  $("#nextPage").addEventListener("click", () => {
    state.page += 1;
    loadTenants().catch((error) => toast(error.message));
  });
  $("#ownerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    busy(button, true, "Granting...");
    try {
      await api("/api/platform/owners", {
        method: "POST",
        body: JSON.stringify(
          Object.fromEntries(new FormData(event.currentTarget)),
        ),
      });
      event.currentTarget.reset();
      await loadOwners();
      toast("Application Owner access granted");
    } catch (error) {
      toast(error.message);
    } finally {
      busy(button, false);
    }
  });
  $("#ownerRows").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-owner-id]");
    if (!button) return;
    const reason = prompt("Reason for revoking Application Owner access:");
    if (!reason) return;
    try {
      await api(`/api/platform/owners/${button.dataset.ownerId}`, {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      });
      await loadOwners();
      toast("Application Owner access revoked");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#refreshAudit").addEventListener("click", () =>
    loadAudit().catch((error) => toast(error.message)),
  );
  $("#logout").addEventListener("click", async () => {
    await api("/api/signature/logout", { method: "POST", body: "{}" });
    location.href = "/signature.html";
  });
}

async function boot() {
  await loadSession();
  bindEvents();
  await loadTenants();
  const billing = new URLSearchParams(location.search).get("billing");
  if (billing)
    toast(
      billing === "success"
        ? "Stripe checkout completed"
        : "Stripe checkout canceled",
    );
}
boot().catch(() => (location.href = "/signature.html"));
