"use strict";

function applicationReadiness({
  config,
  db,
  installer,
  runtimeHealth,
  transactionalEmail,
  version,
}) {
  const setupRequired = installer.required(),
    databaseReady = (() => {
      try {
        return Boolean(db.prepare("SELECT 1 ready").get().ready);
      } catch {
        return false;
      }
    })(),
    mail = transactionalEmail.summary(),
    checks = [
      {
        id: "database",
        label: "Application database",
        ok: databaseReady,
        required: true,
      },
      {
        id: "runtime",
        label: "Runtime ownership",
        ok: Boolean(runtimeHealth.ready),
        required: true,
      },
      {
        id: "setup",
        label: "First-time setup",
        ok: !setupRequired,
        required: false,
      },
      {
        id: "public_url",
        label: "Public HTTPS URL",
        ok:
          !config.production ||
          /^https:\/\//i.test(config.signature.publicUrl || ""),
        required: config.production && !setupRequired,
      },
      {
        id: "credential_vault",
        label: "Credential encryption",
        ok: Boolean(config.signature.credentialEncryptionKey),
        required: config.production && !setupRequired,
      },
      {
        id: "transactional_email",
        label: "Account email delivery",
        ok: mail.configured,
        required:
          config.production &&
          !setupRequired &&
          Boolean(config.signature.allowRegistration),
      },
    ],
    blocking = checks.filter((check) => check.required && !check.ok),
    status = setupRequired
      ? databaseReady && runtimeHealth.ready
        ? "setup_required"
        : "unavailable"
      : blocking.length
        ? "unavailable"
        : "ok";
  return {
    status,
    service: "signify-creator",
    database: databaseReady ? "ready" : "unavailable",
    runtime: runtimeHealth.ready
      ? "ready"
      : runtimeHealth.error || "unavailable",
    setupRequired,
    version,
    checks,
    time: new Date().toISOString(),
  };
}

module.exports = { applicationReadiness };
