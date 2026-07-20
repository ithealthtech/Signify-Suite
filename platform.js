"use strict";
const { $, $$, api, escapeHtml } = window.Signify;
const state = {
  page: 1,
  pagination: null,
  organizations: [],
  detail: null,
  stripePrices: [],
};

function dateLabel(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}
function fileSize(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"],
    exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** exponent).toFixed(exponent > 1 ? 1 : 0)} ${units[exponent - 1]}`;
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
function stripePriceLabel(price) {
  const amount = Number.isInteger(price.unitAmount)
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(price.currency || "usd").toUpperCase(),
      }).format(price.unitAmount / 100)
    : "Custom";
  return `${price.productName} - ${amount}/${price.interval || "period"}`;
}
function renderStripePrices(selected = {}) {
  for (const plan of ["starter", "team", "business"]) {
    const select = $(`#stripePlanForm [name="${plan}"]`);
    select.innerHTML =
      '<option value="">Not offered</option>' +
      state.stripePrices
        .map(
          (price) =>
            `<option value="${escapeHtml(price.id)}">${escapeHtml(stripePriceLabel(price))}</option>`,
        )
        .join("");
    select.value = selected[plan] || "";
  }
}
async function loadIntegrations() {
  const result = await api("/api/platform/integrations"),
    stripe = result.stripe,
    microsoft = result.microsoft;
  state.stripePrices = stripe.catalog || state.stripePrices;
  $("#microsoftIntegrationStatus").innerHTML =
    `<div><span>Status</span><strong>${escapeHtml(microsoft.status)}</strong></div>` +
    `<div><span>Organization</span><strong>${escapeHtml(microsoft.accountName || "Not connected")}</strong></div>` +
    `<div><span>Tenant</span><strong>${escapeHtml(microsoft.homeTenantId || "-")}</strong></div>` +
    `<div><span>Verified</span><strong>${escapeHtml(dateLabel(microsoft.lastVerifiedAt))}</strong></div>`;
  $("#microsoftPermissions").textContent = microsoft.permissions?.length
    ? `Granted application permissions: ${microsoft.permissions.join(", ")}`
    : "Connect and verify the Microsoft application from First-time setup.";
  $("#disconnectMicrosoft").disabled = microsoft.source !== "vault";
  $("#stripeIntegrationStatus").innerHTML =
    `<div><span>Status</span><strong>${escapeHtml(stripe.status)}</strong></div>` +
    `<div><span>Account</span><strong>${escapeHtml(stripe.accountName || "Not connected")}</strong></div>` +
    `<div><span>Mode</span><strong>${escapeHtml(stripe.mode || "-")}</strong></div>` +
    `<div><span>Verified</span><strong>${escapeHtml(dateLabel(stripe.lastVerifiedAt))}</strong></div>`;
  $("#stripeConnectForm").hidden = stripe.source === "vault";
  $("#stripePlanForm").hidden = stripe.source !== "vault";
  $("#stripeTestForm").hidden = !stripe.configured || stripe.mode !== "test";
  renderStripePrices(stripe.prices || {});
}
async function loadSetup({ navigate = false } = {}) {
  const result = await api("/api/platform/setup"),
    steps = [
      ["Identity", result.company.ready],
      ["Credential vault", result.vault.configured],
      ["Microsoft 365", result.microsoft.configured],
      ["Stripe", result.stripe.configured || result.stripe.skipped],
    ];
  $("#setupProgress").innerHTML = steps
    .map(
      ([label, ready], index) =>
        `<div><strong>${index + 1}. ${escapeHtml(label)}</strong><span>${ready ? "Ready" : "Action required"}</span></div>`,
    )
    .join("");
  $("#setupCompletion").textContent = result.complete ? "Ready" : "Not ready";
  $("#setupReadinessMessage").textContent = result.complete
    ? "Application services are ready for tenant onboarding."
    : "Complete identity, credential vault, Microsoft 365, and Stripe setup or deferral.";
  $("#finishSetup").disabled = !result.complete;
  const identity = $("#applicationSetupForm").elements;
  identity.companyName.value = result.company.name || "";
  identity.publicUrl.value = result.company.publicUrl || "";
  $("#skipStripeSetup").textContent = result.stripe.skipped
    ? "Require Stripe"
    : "Skip for now";
  $("#skipStripeSetup").dataset.skipped = result.stripe.skipped
    ? "true"
    : "false";
  if (navigate && !result.complete) showSection("setup");
  return result;
}
async function loadOperations() {
  const result = await api("/api/platform/operations"),
    pending = result.backups.find((item) => item.pendingRestore);
  $("#pendingRestore").hidden = !pending;
  $("#pendingRestoreName").textContent = pending
    ? `${pending.name} will be restored after restart.`
    : "";
  $("#backupRows").innerHTML = result.backups.length
    ? result.backups
        .map(
          (backup) =>
            `<tr><td><strong>${escapeHtml(backup.name)}</strong></td><td>${escapeHtml(dateLabel(backup.modifiedAt))}</td><td>${escapeHtml(fileSize(backup.size))}</td><td>${backup.pendingRestore ? '<span class="status-dot error">Pending restore</span>' : '<span class="status-dot active">Ready</span>'}</td><td><div class="backup-actions"><a class="button" href="/api/platform/operations/backups/${encodeURIComponent(backup.name)}/download">Download</a><button class="button" type="button" data-backup-action="restore" data-backup-name="${escapeHtml(backup.name)}">Restore</button><button class="button danger" type="button" data-backup-action="delete" data-backup-name="${escapeHtml(backup.name)}">Delete</button></div></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="muted">No managed backups yet.</td></tr>';
}
function openOperation(action, backupName = "") {
  const form = $("#operationForm"),
    restore = action === "restore",
    labels = {
      create: [
        "Create backup",
        "Create a consistent snapshot of the current application database.",
      ],
      restore: [
        "Stage database restore",
        `Restore ${backupName} when the application next restarts.`,
      ],
      delete: ["Delete backup", `Permanently delete ${backupName}.`],
      cancel: ["Cancel restore", "Remove the pending restore request."],
    };
  form.reset();
  form.elements.action.value = action;
  form.elements.backupName.value = backupName;
  $("#operationTitle").textContent = labels[action][0];
  $("#operationMessage").textContent = labels[action][1];
  $("#restoreConfirmation").hidden = !restore;
  form.elements.confirmation.required = restore;
  $("#confirmOperation").textContent = labels[action][0];
  $("#confirmOperation").classList.toggle(
    "danger",
    ["restore", "delete"].includes(action),
  );
  $("#operationDialog").showModal();
}
async function submitOperation(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = event.submitter,
    body = Object.fromEntries(new FormData(form)),
    name = encodeURIComponent(body.backupName);
  const requests = {
    create: ["/api/platform/operations/backups", "POST"],
    restore: [`/api/platform/operations/backups/${name}/restore`, "POST"],
    delete: [`/api/platform/operations/backups/${name}`, "DELETE"],
    cancel: ["/api/platform/operations/restore", "DELETE"],
  };
  busy(button, true);
  try {
    await api(requests[body.action][0], {
      method: requests[body.action][1],
      body: JSON.stringify(body),
      timeoutMs: 120000,
    });
    $("#operationDialog").close();
    await loadOperations();
    toast(
      body.action === "restore"
        ? "Restore staged. Restart the application to apply it."
        : "Application operation completed",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function checkUpdates(event) {
  const button = event.currentTarget;
  busy(button, true, "Checking...");
  try {
    const { update } = await api("/api/platform/operations/updates"),
      status = $("#updateStatus"),
      link = $("#openRelease");
    status.innerHTML = `<strong>${update.updateAvailable ? "Update available" : "Application is current"}</strong><span>Installed ${escapeHtml(update.currentVersion)} · Latest ${escapeHtml(update.latestVersion)} · Published ${escapeHtml(dateLabel(update.publishedAt))}</span>`;
    link.href = update.releaseUrl;
    link.hidden = !update.releaseUrl;
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function saveApplicationSetup(event) {
  event.preventDefault();
  const button = event.submitter,
    body = Object.fromEntries(new FormData(event.currentTarget));
  busy(button, true, "Saving...");
  try {
    await api("/api/platform/setup/application", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await loadSetup();
    toast("Application identity saved");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function saveMicrosoftSetup(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = event.submitter,
    body = Object.fromEntries(new FormData(form));
  busy(button, true, "Verifying...");
  try {
    await api("/api/platform/integrations/microsoft/connect", {
      method: "POST",
      body: JSON.stringify(body),
    });
    form.elements.clientSecret.value = "";
    await loadSetup();
    toast("Microsoft application verified");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function connectStripe(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = event.submitter,
    body = Object.fromEntries(new FormData(form));
  busy(button, true, "Verifying...");
  try {
    const result = await api("/api/platform/integrations/stripe/connect", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.stripePrices = result.prices;
    form.reset();
    renderStripePrices();
    await loadIntegrations();
    $("#stripePlanForm").hidden = false;
    toast("Stripe account verified");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function configureStripe(event) {
  event.preventDefault();
  const button = event.submitter,
    form = new FormData(event.currentTarget),
    body = {
      prices: {
        starter: form.get("starter"),
        team: form.get("team"),
        business: form.get("business"),
      },
      reason: form.get("reason"),
    };
  busy(button, true, "Configuring...");
  try {
    await api("/api/platform/integrations/stripe/configure", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    await Promise.all([loadIntegrations(), loadSession()]);
    toast("Stripe plans and webhook configured");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function testStripeCheckout(event) {
  event.preventDefault();
  const button = event.submitter,
    body = Object.fromEntries(new FormData(event.currentTarget));
  busy(button, true, "Creating...");
  try {
    const result = await api(
      "/api/platform/integrations/stripe/test-checkout",
      { method: "POST", body: JSON.stringify(body) },
    );
    window.open(result.url, "_blank", "noopener");
    toast("Stripe sandbox Checkout created");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
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
async function loadJobs() {
  const status = $("#jobStatus").value,
    result = await api(
      `/api/platform/jobs?status=${encodeURIComponent(status)}&limit=50`,
    );
  $("#jobRows").innerHTML = result.jobs.length
    ? result.jobs
        .map(
          (job) =>
            `<tr><td><strong>${escapeHtml(job.type)}</strong>${job.lastError ? `<small class="job-error">${escapeHtml(job.lastError)}</small>` : ""}</td><td>${escapeHtml(job.organizationName)}</td><td><span class="status-dot ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span></td><td>${job.attempts} / ${job.maxAttempts}</td><td>${escapeHtml(dateLabel(job.updatedAt))}</td><td><button class="button" type="button" data-retry-job="${escapeHtml(job.id)}" data-job-type="${escapeHtml(job.type)}" ${job.status !== "failed" ? "disabled" : ""}>Retry</button></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="6"><div class="empty">No jobs match this view.</div></td></tr>';
}
function openJobRetry(button) {
  const form = $("#retryJobForm");
  form.reset();
  form.elements.jobId.value = button.dataset.retryJob;
  $("#retryJobMessage").textContent =
    `Retry ${button.dataset.jobType} after correcting its failure.`;
  $("#retryJobDialog").showModal();
}
async function retryJob(event) {
  event.preventDefault();
  const form = event.currentTarget,
    button = event.submitter,
    body = Object.fromEntries(new FormData(form)),
    id = encodeURIComponent(body.jobId);
  busy(button, true, "Retrying...");
  try {
    await api(`/api/platform/jobs/${id}/retry`, {
      method: "POST",
      body: JSON.stringify({ reason: body.reason }),
    });
    $("#retryJobDialog").close();
    await loadJobs();
    toast("Job queued for retry");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
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
  $("#stripeSubscriptionForm").elements.plan.value = result.subscription.plan;
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
async function stripeSubscriptionAction(event) {
  event.preventDefault();
  const button = event.submitter,
    form = new FormData(event.currentTarget),
    body = {
      action: button.dataset.stripeAction,
      plan: form.get("plan"),
      reason: form.get("reason"),
    };
  busy(button, true, "Submitting...");
  try {
    await api(
      `/api/platform/organizations/${state.detail.organization.id}/billing/subscription`,
      { method: "PUT", body: JSON.stringify(body) },
    );
    toast("Stripe accepted the subscription change");
  } catch (error) {
    toast(error.message);
  } finally {
    busy(button, false);
  }
}
async function openStripePortal() {
  const button = $("#openStripePortal");
  busy(button, true, "Opening...");
  try {
    const result = await api(
      `/api/platform/organizations/${state.detail.organization.id}/billing/portal`,
      { method: "POST", body: "{}" },
    );
    window.open(result.url, "_blank", "noopener");
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
      if (button.dataset.section === "integrations") await loadIntegrations();
      if (button.dataset.section === "owners") await loadOwners();
      if (button.dataset.section === "audit") await loadAudit();
      if (button.dataset.section === "operations") await loadOperations();
      if (button.dataset.section === "jobs") await loadJobs();
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
  $("#stripeSubscriptionForm").addEventListener(
    "submit",
    stripeSubscriptionAction,
  );
  $("#openStripePortal").addEventListener("click", openStripePortal);
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
    const form = event.currentTarget,
      button = event.submitter;
    busy(button, true, "Granting...");
    try {
      await api("/api/platform/owners", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      form.reset();
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
  $("#refreshJobs").addEventListener("click", () =>
    loadJobs().catch((error) => toast(error.message)),
  );
  $("#jobStatus").addEventListener("change", () =>
    loadJobs().catch((error) => toast(error.message)),
  );
  $("#jobRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-retry-job]");
    if (button && !button.disabled) openJobRetry(button);
  });
  $$("[data-close-job]").forEach((button) =>
    button.addEventListener("click", () => $("#retryJobDialog").close()),
  );
  $("#retryJobForm").addEventListener("submit", retryJob);
  $("#refreshOperations").addEventListener("click", () =>
    loadOperations().catch((error) => toast(error.message)),
  );
  $("#createBackup").addEventListener("click", () => openOperation("create"));
  $("#checkUpdates").addEventListener("click", checkUpdates);
  $("#cancelRestore").addEventListener("click", () => openOperation("cancel"));
  $("#backupRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-backup-action]");
    if (button)
      openOperation(button.dataset.backupAction, button.dataset.backupName);
  });
  $$("[data-close-operation]").forEach((button) =>
    button.addEventListener("click", () => $("#operationDialog").close()),
  );
  $("#operationForm").addEventListener("submit", submitOperation);
  $("#refreshIntegrations").addEventListener("click", () =>
    loadIntegrations().catch((error) => toast(error.message)),
  );
  $("#openMicrosoftSetup").addEventListener("click", () =>
    showSection("setup"),
  );
  $("#disconnectMicrosoft").addEventListener("click", async () => {
    const reason = prompt("Reason for disconnecting Microsoft 365:");
    if (!reason) return;
    try {
      await api("/api/platform/integrations/microsoft", {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      });
      await Promise.all([loadIntegrations(), loadSetup()]);
      toast("Microsoft application disconnected");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#applicationSetupForm").addEventListener("submit", saveApplicationSetup);
  $("#microsoftSetupForm").addEventListener("submit", saveMicrosoftSetup);
  $("#openStripeSetup").addEventListener("click", async () => {
    showSection("integrations");
    await loadIntegrations();
  });
  $("#skipStripeSetup").addEventListener("click", async (event) => {
    const skipped = event.currentTarget.dataset.skipped !== "true";
    try {
      await api("/api/platform/setup/stripe-skip", {
        method: "PUT",
        body: JSON.stringify({
          skipped,
          reason: skipped
            ? "Defer Stripe during setup"
            : "Require Stripe setup",
        }),
      });
      await loadSetup();
      toast(skipped ? "Stripe deferred" : "Stripe is now required");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#finishSetup").addEventListener("click", () => showSection("tenants"));
  $("#stripeConnectForm").addEventListener("submit", connectStripe);
  $("#stripePlanForm").addEventListener("submit", configureStripe);
  $("#stripeTestForm").addEventListener("submit", testStripeCheckout);
  $("#disconnectStripe").addEventListener("click", async () => {
    const reason = prompt("Reason for disconnecting Stripe:");
    if (!reason) return;
    try {
      await api("/api/platform/integrations/stripe", {
        method: "DELETE",
        body: JSON.stringify({ reason }),
      });
      state.stripePrices = [];
      await Promise.all([loadIntegrations(), loadSession()]);
      toast("Stripe disconnected");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#logout").addEventListener("click", async () => {
    await api("/api/signature/logout", { method: "POST", body: "{}" });
    location.href = "/signature.html";
  });
}

async function boot() {
  await loadSession();
  bindEvents();
  await Promise.all([loadTenants(), loadSetup({ navigate: true })]);
  const billing = new URLSearchParams(location.search).get("billing");
  if (billing)
    toast(
      billing === "success"
        ? "Stripe checkout completed"
        : "Stripe checkout canceled",
    );
}
boot().catch((error) => {
  if ([401, 403].includes(error.status))
    location.href = "/signature.html?auth=account-required";
  else toast(error.message);
});
