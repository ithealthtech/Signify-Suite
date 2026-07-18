# Changelog

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
