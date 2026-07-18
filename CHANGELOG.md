# Changelog

## Unreleased

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
