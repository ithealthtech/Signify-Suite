"use strict";

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderChecks(target, checks) {
  target.innerHTML = checks
    .map(
      (check) =>
        `<div class="system-check ${check.ok ? "ok" : ""}"><i>${check.ok ? "&#10003;" : "!"}</i><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span></div>`,
    )
    .join("");
}

function setStep(step) {
  document.querySelectorAll("[data-wizard-step]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.wizardStep) !== step;
  });
  document.querySelectorAll("[data-progress-step]").forEach((item) => {
    const position = Number(item.dataset.progressStep),
      complete = position < step;
    item.classList.toggle("active", position === step);
    item.classList.toggle("complete", complete);
    item.toggleAttribute("aria-current", position === step);
    item.querySelector("i").innerHTML = complete
      ? "&#10003;"
      : String(position);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(new Error(body.error?.message || "Setup failed."), {
      status: response.status,
      code: body.error?.code,
      body,
    });
  return body;
}

function showOnly(panel) {
  [
    "loadingPanel",
    "lockedPanel",
    "unavailablePanel",
    "installerForm",
    "completePanel",
  ].forEach((id) => {
    $(`#${id}`).hidden = id !== panel;
  });
}

async function loadStatus() {
  showOnly("loadingPanel");
  try {
    const status = await request("/api/setup/status");
    if (!status.required) {
      showOnly("lockedPanel");
      setStep(3);
      return;
    }
    if (!status.available) {
      renderChecks($("#unavailableChecks"), status.checks);
      showOnly("unavailablePanel");
      setStep(1);
      return;
    }
    renderChecks($("#systemChecks"), status.checks);
    const form = $("#installerForm");
    form.elements.companyName.value = status.companyName || "";
    form.elements.publicUrl.value = status.publicUrl || location.origin;
    showOnly("installerForm");
    setStep(1);
  } catch (error) {
    $("#loadingPanel h2").textContent = "The system check failed.";
    $("#loadingPanel p:last-child").textContent = error.message;
  }
}

$("#continueConfigure").addEventListener("click", () => {
  const form = $("#installerForm");
  if (
    !form.elements.companyName.reportValidity() ||
    !form.elements.publicUrl.reportValidity()
  )
    return;
  setStep(2);
  form.elements.name.focus();
});
$("#backToSetup").addEventListener("click", () => setStep(1));
$("#retrySetup").addEventListener("click", loadStatus);
$("#installerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = $("#installButton"),
    message = $("#installerMessage"),
    body = Object.fromEntries(new FormData(form));
  if (!form.reportValidity()) return;
  if (body.password !== body.confirmPassword) {
    message.textContent = "Passwords do not match.";
    form.elements.confirmPassword.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Securing workspace...";
  message.textContent = "Creating the owner account and locking the installer.";
  try {
    const result = await request("/api/setup/install", {
      method: "POST",
      body: JSON.stringify(body),
    });
    form.reset();
    $("#continueToLogin").href = result.next;
    showOnly("completePanel");
    setStep(3);
  } catch (error) {
    message.textContent = error.message;
    if (error.code === "SETUP_UNAVAILABLE" && error.body?.checks) {
      renderChecks($("#unavailableChecks"), error.body.checks);
      showOnly("unavailablePanel");
      setStep(1);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Complete setup";
  }
});

loadStatus();
