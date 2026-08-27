"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { createCredentialVault } = require("./credential-vault.cjs");

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function address(value) {
  const candidate = String(value || "").trim(),
    bracketed = candidate.match(/<([^<>]+)>$/),
    mailbox = (bracketed?.[1] || candidate).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) && !/[\r\n]/.test(candidate)
    ? candidate
    : "";
}

function plainText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.("retry-after") || 0);
  return retryAfter > 0
    ? Math.min(5000, retryAfter * 1000)
    : Math.min(3000, 250 * 2 ** attempt);
}

function createTransactionalEmail({
  config,
  db,
  fetchImpl = fetch,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const vault = createCredentialVault(config.signature.credentialEncryptionKey);

  function settings(override = null) {
    if (override) return { ...override, source: "verification" };
    const row = db
      .prepare("SELECT * FROM application_integrations WHERE provider='email'")
      .get();
    if (row?.encrypted_credentials) {
      const credentials = vault.decrypt("email", row.encrypted_credentials),
        configuration = parseJson(row.configuration_json);
      return {
        provider: "resend",
        apiKey: credentials.apiKey || "",
        from: configuration.from || "",
        replyTo: configuration.replyTo || "",
        endpoint: configuration.endpoint || "https://api.resend.com",
        source: "vault",
        lastVerifiedAt: row.last_verified_at || null,
      };
    }
    return {
      ...config.mail,
      source: config.mail.apiKey ? "environment" : "none",
    };
  }

  function summary() {
    const current = settings(),
      configured = Boolean(
        current.provider === "resend" &&
        current.apiKey &&
        address(current.from) &&
        (!current.replyTo || address(current.replyTo)),
      );
    return {
      provider: current.provider || "disabled",
      configured,
      source: current.source,
      from: current.from || "",
      replyTo: current.replyTo || "",
      lastVerifiedAt: current.lastVerifiedAt || null,
    };
  }

  async function send(message, override = null) {
    const current = settings(override),
      to = address(message.to),
      from = address(current.from),
      replyTo = current.replyTo ? address(current.replyTo) : "",
      subject = String(message.subject || "").trim(),
      html = String(message.html || ""),
      idempotencyKey = String(
        message.idempotencyKey ||
          `signify/${createHash("sha256")
            .update(`${to}\0${subject}\0${html}`)
            .digest("base64url")}`,
      ).slice(0, 256);
    if (
      current.provider !== "resend" ||
      !current.apiKey ||
      !from ||
      !to ||
      (current.replyTo && !replyTo)
    )
      throw Object.assign(new Error("Transactional email is not configured."), {
        status: 503,
        code: "MAIL_NOT_CONFIGURED",
      });
    if (
      !subject ||
      /[\r\n]/.test(subject) ||
      subject.length > 200 ||
      !html ||
      Buffer.byteLength(html) > 512 * 1024
    )
      throw Object.assign(
        new Error("Transactional email content is invalid."),
        {
          status: 400,
          code: "MAIL_CONTENT_INVALID",
        },
      );
    let lastResponse;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        lastResponse = await fetchImpl(`${current.endpoint}/emails`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${current.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "User-Agent": "Signify-Creator",
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            html,
            text: String(message.text || plainText(html)).slice(0, 512 * 1024),
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        if (attempt < 2) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        throw Object.assign(
          new Error("Transactional email provider could not be reached."),
          { status: 502, code: "MAIL_PROVIDER_UNAVAILABLE" },
        );
      }
      if (lastResponse.ok) {
        const payload = await lastResponse.json();
        return { id: String(payload.id || ""), provider: "resend" };
      }
      if (
        attempt < 2 &&
        (lastResponse.status === 429 || lastResponse.status >= 500)
      ) {
        await wait(retryDelay(lastResponse, attempt));
        continue;
      }
      break;
    }
    let providerMessage = "";
    try {
      providerMessage = String((await lastResponse.json()).message || "");
    } catch {}
    throw Object.assign(
      new Error(
        providerMessage
          ? `Transactional email was rejected: ${providerMessage.slice(0, 240)}`
          : "Transactional email was rejected by the provider.",
      ),
      {
        status: 502,
        code: "MAIL_PROVIDER_REJECTED",
      },
    );
  }

  async function verify(input, recipient) {
    const provider = {
      provider: "resend",
      apiKey: String(input.apiKey || "").trim(),
      from: String(input.from || "").trim(),
      replyTo: String(input.replyTo || "").trim(),
      endpoint: "https://api.resend.com",
    };
    const delivery = await send(
      {
        to: recipient,
        subject: "Signify email delivery verified",
        html: "<p>Transactional email is connected and ready for account verification, invitations, and password recovery.</p>",
        idempotencyKey: `signify/email-verification/${randomUUID()}`,
      },
      provider,
    );
    return { ...provider, delivery };
  }

  return { send, settings, summary, verify };
}

module.exports = { address, createTransactionalEmail, plainText, retryDelay };
