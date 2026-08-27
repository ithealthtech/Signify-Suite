"use strict";

function deployment() {
  const query = new URLSearchParams(location.search);
  return {
    id:
      globalThis.SIGNIFY_OUTLOOK_DEPLOYMENT?.id ||
      query.get("deployment") ||
      "",
    token:
      globalThis.SIGNIFY_OUTLOOK_DEPLOYMENT?.token || query.get("token") || "",
  };
}

function applyManagedSignature(event) {
  const credentials = deployment();
  const email = Office.context.mailbox.userProfile.emailAddress;
  fetch("/api/outlook-addin/signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...credentials, email }),
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload.error?.message || "Signature delivery failed.");
      return payload;
    })
    .then(
      (payload) =>
        new Promise((resolve, reject) => {
          Office.context.mailbox.item.disableClientSignatureAsync((result) =>
            result.status === Office.AsyncResultStatus.Succeeded
              ? resolve(payload)
              : reject(
                  new Error(
                    result.error?.message ||
                      "Outlook could not disable its client signature.",
                  ),
                ),
          );
        }),
    )
    .then(
      (payload) =>
        new Promise((resolve, reject) => {
          Office.context.mailbox.item.body.setSignatureAsync(
            payload.enabled ? payload.html : "",
            { coercionType: Office.CoercionType.Html },
            (result) =>
              result.status === Office.AsyncResultStatus.Succeeded
                ? resolve()
                : reject(
                    new Error(
                      result.error?.message ||
                        "Outlook rejected the signature.",
                    ),
                  ),
          );
        }),
    )
    .catch(() => {})
    .finally(() => event.completed());
}

Office.actions.associate("onMessageComposeHandler", applyManagedSignature);
