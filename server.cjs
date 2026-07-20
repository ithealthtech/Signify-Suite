"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const { loadConfig } = require("./server/config.cjs");
const { openDatabase } = require("./server/database.cjs");
const { createSignaturePortal } = require("./server/signature-portal.cjs");
const { createJobQueue, startJobWorker } = require("./server/job-queue.cjs");
const { createMediaStorage } = require("./server/media-storage.cjs");
const { createObservability } = require("./server/observability.cjs");
const { acquireRuntimeLease } = require("./server/runtime-lease.cjs");
const {
  applyPendingRestore,
  createApplicationOperations,
} = require("./server/application-operations.cjs");
const packageMetadata = require("./package.json");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".vcf": "text/vcard; charset=utf-8",
};
const publicFiles = new Set([
  "signature.html",
  "signature.css",
  "signature.js",
  "admin.html",
  "admin.css",
  "admin.js",
  "platform.html",
  "platform.css",
  "platform.js",
  "signify-shared.js",
  "signify-shared.css",
  "signature-it-banner.png",
]);

function securityHeaders(production = false) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...(production
      ? {
          "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
        }
      : {}),
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data: https:; connect-src 'self'",
  };
}

function json(res, status, payload, requestId, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
  });
  res.end(body);
}

function readBody(req, { limit = 1048576 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        const error = new Error("Request body is too large.");
        error.status = 413;
        error.code = "PAYLOAD_TOO_LARGE";
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}
async function readJsonBody(req, { limit = 1048576 } = {}) {
  const body = await readBody(req, { limit });
  if (!body.length) return {};
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("JSON request body must be an object.");
      error.status = 400;
      error.code = "INVALID_JSON_OBJECT";
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.code === "INVALID_JSON_OBJECT") throw error;
    const invalid = new Error("Invalid JSON request body.");
    invalid.status = 400;
    invalid.code = "INVALID_JSON";
    throw invalid;
  }
}

function serve(config, req, res, pathname, requestId) {
  let relative;
  try {
    relative =
      decodeURIComponent(pathname) === "/"
        ? "signature.html"
        : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return json(
      res,
      400,
      { error: { code: "INVALID_PATH", message: "Invalid path." } },
      requestId,
    );
  }
  if (relative === "index.html") relative = "signature.html";
  if (
    !publicFiles.has(relative) &&
    !relative.startsWith("event-banners/") &&
    !relative.startsWith("generated-banners/") &&
    !relative.startsWith("icons/") &&
    !relative.startsWith("uploads/")
  )
    return json(
      res,
      404,
      { error: { code: "NOT_FOUND", message: "Route not found." } },
      requestId,
    );
  let file = publicFiles.has(relative)
    ? path.join(config.sourceRoot, relative)
    : path.join(config.publicRoot, relative);
  if (relative === "signature-it-banner.png")
    file = path.join(config.publicRoot, relative);
  const resolved = path.resolve(file);
  const allowedRoots = [
    path.resolve(config.sourceRoot),
    path.resolve(config.publicRoot),
  ];
  if (
    !allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    )
  )
    return json(
      res,
      400,
      { error: { code: "INVALID_PATH", message: "Invalid path." } },
      requestId,
    );
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())
    return json(
      res,
      404,
      {
        error: {
          code: "STATIC_ASSET_NOT_FOUND",
          message: "Static asset not found.",
        },
      },
      requestId,
    );
  const stat = fs.statSync(resolved);
  res.writeHead(200, {
    "Content-Type":
      contentTypes[path.extname(resolved)] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control":
      config.production &&
      (relative.startsWith("uploads/") ||
        relative.startsWith("generated-banners/"))
        ? "public, max-age=31536000, immutable"
        : config.production && path.extname(resolved) !== ".html"
          ? "public, max-age=3600"
          : "no-cache",
    "X-Request-Id": requestId,
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  fs.createReadStream(resolved).pipe(res);
}

async function serveObjectMedia(mediaStorage, req, res, pathname, requestId) {
  if (mediaStorage.mode !== "s3") return false;
  const match = pathname.match(
    /^\/(uploads|generated-banners)\/([a-z0-9_-]+)\/([a-z0-9_.-]+)$/i,
  );
  if (!match || !["GET", "HEAD"].includes(req.method)) return false;
  let object;
  try {
    object = await mediaStorage.read({
      collection: match[1],
      organizationId: match[2],
      name: match[3],
    });
  } catch (error) {
    if (error.name === "NoSuchKey" || error.$metadata?.httpStatusCode === 404)
      return json(
        res,
        404,
        { error: { code: "MEDIA_NOT_FOUND", message: "Media not found." } },
        requestId,
      );
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": object.contentType,
    ...(Number.isFinite(object.contentLength)
      ? { "Content-Length": object.contentLength }
      : {}),
    "Cache-Control": object.cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  });
  if (req.method === "HEAD") return res.end();
  object.body.pipe(res);
  return true;
}

function createApplication(options = {}) {
  const config = options.config || loadConfig(options.env);
  const runtimeHealth = options.runtimeHealth || { ready: true, error: null };
  const restored =
    options.db || options.skipPendingRestore
      ? null
      : applyPendingRestore(config);
  const db = options.db || openDatabase(config.databasePath);
  const operations = createApplicationOperations({
    config,
    db,
    fetchImpl: options.fetchImpl,
    version: packageMetadata.version,
  });
  const mediaStorage =
    options.mediaStorage ||
    createMediaStorage(config, { s3Client: options.s3Client });
  const jobHandlers = {},
    jobQueue = createJobQueue(db, jobHandlers);
  const signaturePortal = createSignaturePortal({
    db,
    production: config.production,
    signature: config.signature,
    json,
    readJsonBody,
    readBody,
    publicRoot: config.publicRoot,
    mediaStorage,
    trustProxy: config.trustProxy,
    fetchImpl: options.fetchImpl,
    stripeFactory: options.stripeFactory,
    operations,
    enqueueJob: jobQueue.enqueue,
    deletionGraceDays: config.deletionGraceDays,
    packageVersion: packageMetadata.version,
  });
  Object.assign(jobHandlers, signaturePortal.jobHandlers);
  const rateBuckets = new Map(),
    observability =
      options.observability ||
      createObservability({
        config,
        db,
        fetchImpl: options.fetchImpl,
        output: options.logOutput,
      });
  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || "unknown";
  }
  function checkRateLimit(req, pathname) {
    const policies = {
        "/api/signature/login": { limit: 10, windowMs: 15 * 60 * 1000 },
        "/api/signature/register": { limit: 5, windowMs: 60 * 60 * 1000 },
        "/api/signature/password/forgot": {
          limit: 5,
          windowMs: 60 * 60 * 1000,
        },
        "/api/signature/password/reset": {
          limit: 10,
          windowMs: 60 * 60 * 1000,
        },
        "/api/signature/login/mfa": {
          limit: 10,
          windowMs: 15 * 60 * 1000,
        },
      },
      policy = policies[pathname];
    if (req.method !== "POST" || !policy) return null;
    const now = Date.now(),
      key = `${clientIp(req)}:${pathname}`,
      existing = rateBuckets.get(key);
    const bucket =
      !existing || existing.resetAt <= now
        ? { count: 0, resetAt: now + policy.windowMs }
        : existing;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 5000)
      for (const [entryKey, value] of rateBuckets)
        if (value.resetAt <= now) rateBuckets.delete(entryKey);
    return bucket.count > policy.limit
      ? Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      : null;
  }
  const handler = async (req, res) => {
    const requestId = randomUUID(),
      trace = observability.traceContext(req.headers.traceparent),
      spanId = randomUUID().replaceAll("-", "").slice(0, 16);
    const startedAt = Date.now();
    for (const [name, value] of Object.entries(
      securityHeaders(config.production),
    ))
      res.setHeader(name, value);
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("traceparent", `00-${trace.traceId}-${spanId}-01`);
    res.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      observability.recordRequest({
        requestId,
        traceId: trace.traceId,
        spanId,
        method: req.method,
        path: String(req.url || "").split("?")[0],
        status: res.statusCode,
        durationMs,
        ip: clientIp(req),
      });
    });
    try {
      const url = new URL(req.url || "/", "http://signature.local");
      const retryAfter = checkRateLimit(req, url.pathname);
      if (retryAfter)
        return json(
          res,
          429,
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many attempts. Try again later.",
            },
          },
          requestId,
          { "Retry-After": String(retryAfter) },
        );
      if (url.pathname === "/api/live") {
        if (req.method !== "GET")
          return json(
            res,
            405,
            {
              error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Method not allowed.",
              },
            },
            requestId,
            { Allow: "GET" },
          );
        return json(
          res,
          200,
          {
            status: "ok",
            service: "signify-creator",
            time: new Date().toISOString(),
          },
          requestId,
        );
      }
      if (["/api/metrics", "/api/metrics/prometheus"].includes(url.pathname)) {
        if (req.method !== "GET")
          return json(
            res,
            405,
            {
              error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Method not allowed.",
              },
            },
            requestId,
            { Allow: "GET" },
          );
        if (url.pathname === "/api/metrics/prometheus") {
          const body = Buffer.from(observability.prometheus());
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            "Content-Length": body.length,
            "Cache-Control": "no-store",
            "X-Request-Id": requestId,
          });
          return res.end(body);
        }
        return json(res, 200, observability.snapshot(), requestId);
      }
      if (["/api/health", "/api/ready"].includes(url.pathname)) {
        if (req.method !== "GET")
          return json(
            res,
            405,
            {
              error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Method not allowed.",
              },
            },
            requestId,
            { Allow: "GET" },
          );
        db.prepare("SELECT 1").get();
        if (!runtimeHealth.ready)
          return json(
            res,
            503,
            {
              status: "unavailable",
              service: "signify-creator",
              database: "ready",
              runtime: runtimeHealth.error || "runtime lease unavailable",
              version: packageMetadata.version,
              time: new Date().toISOString(),
            },
            requestId,
          );
        return json(
          res,
          200,
          {
            status: "ok",
            service: "signify-creator",
            database: "ready",
            runtime: "ready",
            version: packageMetadata.version,
            time: new Date().toISOString(),
          },
          requestId,
        );
      }
      if (
        await serveObjectMedia(mediaStorage, req, res, url.pathname, requestId)
      )
        return;
      const handled = await signaturePortal(req, res, url, requestId);
      if (handled !== false) return handled;
      if (req.method !== "GET" && req.method !== "HEAD")
        return json(
          res,
          405,
          {
            error: {
              code: "METHOD_NOT_ALLOWED",
              message: "Method not allowed.",
            },
          },
          requestId,
          { Allow: "GET, HEAD" },
        );
      return serve(config, req, res, url.pathname, requestId);
    } catch (error) {
      observability.log(
        error.status && error.status < 500 ? "warn" : "error",
        "request.error",
        {
          requestId,
          code: error.code || "SERVER_ERROR",
          status: error.status || 500,
          message: error.status ? error.message : "Unhandled server error",
          stack: error.status ? undefined : error.stack,
        },
      );
      return json(
        res,
        error.status || 500,
        {
          error: {
            code: error.code || "SERVER_ERROR",
            message: error.status ? error.message : "Server error.",
          },
        },
        requestId,
      );
    }
  };
  return {
    config,
    db,
    handler,
    jobHandlers,
    jobQueue,
    mediaStorage,
    observability,
    operations,
    restored,
    runtimeHealth,
  };
}

function startServer(options = {}) {
  const runtimeHealth = { ready: true, error: null },
    application = createApplication({ ...options, runtimeHealth });
  const runtimeLease = acquireRuntimeLease(application.db, {
    onHealth(ready, error) {
      runtimeHealth.ready = ready;
      runtimeHealth.error = error?.message || null;
      if (error)
        application.observability.log("error", "runtime.lease_unhealthy", {
          code: error.code,
          message: error.message,
        });
    },
  });
  application.observability.start();
  const server = http.createServer(application.handler);
  const jobs =
    application.config.jobMode === "embedded"
      ? startJobWorker(application.db, {
          publicRoot: application.config.publicRoot,
          mediaStorage: application.mediaStorage,
          handlers: application.jobHandlers,
        })
      : { stop: async () => {} };
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.once("error", async (error) => {
    application.observability.log("error", "server.start_failed", {
      code: error.code || "LISTEN_FAILED",
      message: error.message,
    });
    await jobs.stop();
    runtimeLease.release();
    application.db.close();
    process.exitCode = 1;
  });
  server.listen(application.config.port, application.config.host, () =>
    application.observability.log("info", "server.started", {
      url: `http://${application.config.host}:${application.config.port}`,
      jobMode: application.config.jobMode,
    }),
  );
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    application.observability.log("info", "server.stopping", { signal });
    const forceClose = setTimeout(() => server.closeAllConnections(), 10000);
    forceClose.unref();
    server.closeIdleConnections();
    server.close(async () => {
      clearTimeout(forceClose);
      await jobs.stop();
      await application.observability.stop();
      runtimeLease.release();
      application.db.close();
      process.exit(0);
    });
  }
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return { ...application, jobs, runtimeLease, server };
}

if (require.main === module) startServer();
module.exports = { createApplication, serveObjectMedia, startServer };
