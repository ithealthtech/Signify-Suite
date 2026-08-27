# Changelog

## 1.1.0 - 2026-08-27

- Aligned the runtime, container, release workflow, documentation, and signed
  package naming on version `1.1.0`.
- Added periodic private-release detection and verified one-click installation
  for managed hosts, including package size limits, SHA-256 and Ed25519 checks,
  migration preflight, safety backup, readiness gating, and automatic rollback.
- Added encrypted transactional email configuration, retry and idempotency
  controls, delivery-aware account workflows, and production readiness gates.
- Added repeatable Microsoft 365 and Stripe acceptance checks for permissions,
  directory access, sandbox mail, recurring prices, webhook configuration, and
  disposable test Checkout sessions with credential-free evidence reports.

- Added a separate creator-controlled license authority with Ed25519 lease
  issuance, installation binding, activation-key rotation, revocation, and
  authenticated administration routes.
- Connected central Stripe subscription webhooks to mapped installation
  entitlements with signature verification and idempotent event handling.
- Added automatic and owner-triggered entitlement refresh, durable revocation,
  offline grace handling, and safe in-place Community downgrade behavior.
- Added detached Ed25519 signing and verification for production release
  inventories; release deployments can now reject unsigned or altered artifacts.
- Closed a concurrent tenant-creation capacity race by enforcing licensed
  capacity inside both organization creation transactions.

### Added

- Browser-based Community and Enterprise installation licensing with a stable
  installation ID, signed-key activation during setup or from the Application
  Owner console, entitlement status, tenant usage, expiration, and downgrade
  controls.
- Community Edition defaults to one tenant; signed Enterprise entitlements can
  unlock higher tenant limits and product features.
- Centrally deployable Outlook event-based add-in with tenant-scoped manifest
  generation, live signature delivery, administrative key rotation, and audit
  history.
- Managed Outlook signatures are removed on new message composition for
  inactive members and expired, past-due, or canceled tenants, then resume
  automatically after subscription restoration.
- Banner Card editor preset with an integrated technology banner, compact
  identity row, initials fallback, and an Outlook-visible shadow layer.
- Thirty-day trials for new tenant registrations now fail closed when their
  trial window expires, including editor read and write APIs.
- Expired tenant admins receive a non-dismissible subscription dialog with a
  server-created Stripe hosted-checkout link; end users are directed to their
  workspace administrator.

### Security

- Ed25519 license verification binds commercial entitlements to one
  installation, rejects modified or cross-installation keys, supports signed
  grace periods, and keeps the private issuer key outside customer deployments.
- Tenant limits are enforced on both server-side organization creation paths;
  hiding or re-enabling the browser control cannot bypass the entitlement.
- Outlook deployment credentials are encrypted at rest, rate limited, scoped
  to one tenant, excluded from API responses, and included in credential-key
  rotation.
- Subscription entitlement is enforced on the server before signature data is
  returned, and Stripe credentials remain restricted to the Application Owner.

### Acceptance status

- The complete local validation, security, build, artifact, and clean-start
  suites passed before release.
- Live Microsoft 365 mail and Stripe Checkout acceptance was not executed for
  this release because no external sandbox credentials were supplied. The new
  acceptance command fails closed until both providers are configured.

## 1.0.0 - 2026-07-22

### Added

- Resumable Application Owner onboarding with authoritative server-side
  readiness and MFA gating.
- Non-root, read-only OCI image and hardened Compose topology with one-shot
  setup/migration tools and independently supervised web and worker services.
- Durable worker heartbeat health checks and transactional SQLite web-instance
  ownership leases.
- Optional authenticated GitHub release checks for private release channels.
- Standalone three-stage browser installer with Setup, Configure, and Sign-in
  progress, atomic Application Owner creation, and pre-install application lock.
- Application-level GitHub integration for encrypted private-release access and
  update authentication.
- Clickable Microsoft 365, Stripe, and GitHub integration catalog with focused
  provider dialogs.
- Direct tenant user provisioning and improved campaign banner overlay controls,
  typography, animation effects, and stable preview dimensions.

### Changed

- Release deployment now rejects unlisted artifact files and accidental version
  downgrades before activation.
- Provider credential forms opt out of login autofill and identify secrets as
  new credentials.
- Readiness reports runtime lease health and fails closed when ownership is lost.
- Microsoft 365 and Stripe configuration are optional after installation rather
  than blockers inside the Application Owner console.
- Integration credentials use POST-only forms, encrypted vault storage, URL
  credential stripping, and actionable private-repository errors.

### Verified

- Full lint, security, unit, integration, smoke, SBOM, build, artifact, and
  production-startup gates pass with 23 SQLite migrations.
- HTTPS production-loopback browser checks pass for MFA enforcement, setup,
  signature preview, backup creation, and mobile/tablet overflow.

## 0.4.0 - 2026-07-18

### Added

- Durable SQLite background jobs with atomic claims, retry backoff,
  deduplication, stale-lock recovery, and graceful worker shutdown.
- Tenant media quotas, atomic media writes, immutable caching, and conservative
  cleanup for aged unreferenced assets.
- Dedicated liveness, readiness, and aggregate runtime metrics endpoints.
- Query-plan, job, media, frontend client, SBOM, and service-level test suites.
- CycloneDX production SBOM and a production operations runbook.

### Changed

- Consolidated browser request, CSRF, escaping, initials, and exact shared style
  primitives across all three portals without changing the login design.
- Extracted authentication security, authorization, validation, HTTP response,
  media, and job services from the backend portal module.
- Added SQLite indexes for email lookup, workspace selection, approval queues,
  tenant pagination, and Application Owner checks.
- Added GET request coalescing, bounded browser request timeouts, and cancellation
  for superseded signature previews.
- Hardened listener startup diagnostics and idempotent HTTP/job/database
  shutdown.

### Security

- Production release artifacts use an explicit static asset allowlist and reject
  runtime data, local configuration, databases, logs, backups, archives, and
  populated provider secrets.
- Tenant storage identifiers are validated before filesystem access, and
  production dependency auditing reports no known vulnerabilities.

## 0.3.1 - 2026-07-18

### Security

- Production packaging now copies an explicit public-asset allowlist instead of
  the working tree's complete `public` directory.
- Added an artifact gate that rejects runtime uploads, generated media,
  databases, local environment files, backups, logs, archives, dependencies,
  and populated provider secrets.

## 0.3.0 - 2026-07-18

Signify Creator 0.3.0 promotes the multi-tenant control plane, guided provider
onboarding, and self-hosted Node.js installer from the release-candidate line.

### Application control plane

- Added explicit Application Owner, Tenant Admin, and End User access tiers.
- Added an Application Owner interface for tenant creation, onboarding links,
  suspension and restoration, plan and seat management, owner grants, provider
  health, and global audit history.
- Restricted Stripe configuration, Checkout, billing portal, plan changes,
  cancellation, and reactivation to Application Owners.
- Preserved tenant-scoped signature design, campaigns, banner overlays,
  approvals, analytics, directory sync, and rollout workflows.

### Microsoft 365

- Added per-tenant Microsoft administrator consent, tenant verification,
  connection health, sender validation, and tenant-bound directory and mail
  operations.
- Added multi-tenant Microsoft sign-in resolution so authenticated identities
  are matched only to the connected Signify tenant.
- Added application credential, home-tenant, Microsoft Graph, and required
  permission validation.
- Hardened callbacks with browser-bound, expiring, one-time state, PKCE S256,
  nonce verification, cancellation handling, tenant-session matching, and local
  malformed-code rejection.

### Stripe

- Added guided test/live account verification and recurring-price discovery.
- Added Signify plan mapping, signed webhook endpoint creation and reuse, test
  Checkout, customer portal, subscription changes, cancellation, reactivation,
  and provider disconnect controls.
- Retained signed, idempotent webhook processing as the subscription authority.
- Added actionable downstream failure responses without exposing provider
  credentials.

### Setup and operations

- Added interactive `npm run setup` installation for extracted Node.js release
  packages.
- Added noninteractive hosting-panel setup and environment-only validation.
- Added automatic application, persistent-volume, database, backup, host, port,
  proxy, and public-domain detection for common managed Node.js hosts.
- Added safe environment backups and preservation of existing Microsoft,
  Stripe, Azure, and future Signify settings during setup reruns.
- Added credential-encryption key generation, writable-storage checks, automatic
  migrations, first-owner creation, bootstrap disablement, and clear startup
  instructions.
- Added offline Application Owner recovery, Tenant Admin reset, provider
  verification, and atomic integration-key rotation commands to production
  artifacts.

### Security and reliability

- Added AES-256-GCM provider credential storage with provider-specific
  authenticated context; secrets are not returned by APIs or audit metadata.
- Enforced server-side three-tier authorization, tenant isolation, CSRF, request
  validation, seat limits, and owner-only provider mutations.
- Added audited provider replacement, disconnect, tenant lifecycle,
  subscription, and owner-grant operations.
- Added resilient Windows artifact rebuilds and upgraded CI actions to their
  supported Node.js 24 runtimes.

### Fixes

- Included all documented recovery and setup scripts in production artifacts.
- Removed tablet-width page overflow from the signature studio while retaining
  internal overflow handling for large Outlook-safe signatures.
- Rejected Microsoft callbacks without authorization codes as malformed client
  requests instead of reporting misleading downstream provider failures.

### Validation

- Added installer regression coverage for generated credentials, persistent
  paths, migrations, owner bootstrap, rerun safety, configuration preservation,
  managed-host detection, and invalid production settings.
- Expanded integration coverage for OAuth state, PKCE, nonce, callback
  cancellation, admin consent, tenant registration, Stripe signatures, webhook
  retries, idempotency, billing transitions, and provider failures.
- Revalidated role boundaries, tenant isolation, invitations, sessions, CSRF,
  rate limiting, seat enforcement, campaigns, overlays, approvals, templates,
  uploads, rollout, analytics, database integrity, backup/recovery, migrations,
  production startup, security headers, and responsive browser rendering.

## 0.3.0-rc.4 - 2026-07-18

### Fixed

- Removed page-level horizontal overflow from the signature studio between the
  mobile and desktop breakpoints while retaining scroll protection inside the
  rendered signature preview.
- Reject Microsoft sign-in callbacks without an authorization code locally with
  HTTP 400 instead of forwarding malformed requests and reporting a downstream
  provider failure.

### Validation

- Added callback regressions for missing Microsoft authorization codes and
  canceled Microsoft administrator consent, including one-time state and cookie
  cleanup assertions.
- Revalidated Application Owner, Tenant Admin, and End User authorization,
  tenant isolation, CSRF, OAuth state/PKCE/nonce, Microsoft tenant consent,
  Stripe signatures and idempotency, campaigns, approvals, rollout, installer,
  migrations, production packaging, and responsive frontend rendering.

## 0.3.0-rc.3 - 2026-07-18

### Changed

- Setup now detects absolute application, persistent-storage, database, backup,
  host, port, proxy, and public URL values from common managed Node.js hosting
  environments while retaining explicit environment overrides.

## 0.3.0-rc.2 - 2026-07-18

### Added

- Interactive and hosting-panel setup installer with environment generation,
  persistent-storage checks, database migrations, and first-owner creation.
- Installer regression coverage for fresh installs, safe reruns, configuration
  backups, generated credentials, and production validation failures.

## 0.3.0-rc.1 - 2026-07-18

### Added

- Three-tier authorization: Application Owner, Tenant Admin, and End User.
- Application Owner control plane for tenant lifecycle, onboarding invitations, subscriptions, Stripe checkout, owner grants, and global audit history.
- Per-tenant Microsoft 365 admin consent, tenant verification, sender validation, directory sync status, and tenant-bound Microsoft sign-in.
- Offline Application Owner recovery command.
- Application Owner first-time setup and readiness workflow.
- Encrypted Microsoft and Stripe credential storage with atomic key rotation.
- Microsoft application, tenant, Graph, and permission validation.
- Stripe account discovery, recurring-price mapping, automatic webhook registration, and sandbox-ready onboarding.
- Stripe billing portal, provider-backed plan changes, cancellation, and reactivation controls.
- Live read-only provider acceptance verification and expanded regression coverage.

### Changed

- Removed Stripe Checkout and customer portal controls and routes from tenant administration.
- Routed Graph directory and mail operations through each organization's registered Microsoft tenant.
- Preserved the original login page and existing signature, campaign, banner, approval, analytics, and rollout features.

### Fixed

- Included the documented Tenant Admin reset command in production artifacts.

## 0.2.0 - 2026-07-17

First stable Signify Creator release.

### Added

- Multi-tenant signature studio, reusable templates, campaign banners, approvals, bulk rollout, analytics, audit history, QR codes, and vCards.
- Microsoft 365 login, directory synchronization, profile-photo import, and Graph email delivery when configured.
- Stripe Checkout, customer portal, subscription state, seat limits, and signed idempotent webhooks when configured.
- Production build artifact, health check, structured logging, backup command, Hostinger deployment guidance, and automated CI validation.

### Security and reliability

- Server-side role and tenant enforcement, CSRF protection, browser-bound OAuth state, session revocation, rate limiting, and strict request validation.
- Atomic user, approval, directory-sync, and webhook workflows.
- Signature data normalization and HTML attribute escaping.
- Clean and existing-database migration, integrity, backup, production-startup, and responsive browser verification.
