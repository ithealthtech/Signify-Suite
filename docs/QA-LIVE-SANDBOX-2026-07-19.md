# Live Sandbox QA Report - 2026-07-19

## Result

**PASS with external-service limitations.** All locally testable release criteria passed after the defects documented below were fixed. No known critical or high-severity application defects remain. Real Microsoft 365 consent/directory/mail and successful Stripe transactions were not executed because sandbox provider credentials were not available; their request, authorization, validation, retry, webhook, and failure paths passed the automated integration suite with controlled provider doubles.

## Environment

- Source: `Signify-Creator-Beta`, version `0.4.0`
- Isolated deployment: `Signify-QA-Sandbox-20260719`
- Runtime: Node.js `24.18.0` (application minimum: `>=22.13.0`)
- Package manager: npm with `package-lock.json`
- Server: native Node.js HTTP application; Express is not required
- Database: isolated SQLite file `qa-data/signify-qa.db`
- Browser URL: `http://127.0.0.1:4189`
- Production simulation URL: `http://127.0.0.1:4188`
- Browser: clean in-app Chromium session controlled through Playwright-compatible automation
- External services: no production credentials, databases, mailboxes, tenants, Stripe accounts, or customer data
- Uploaded test assets: bundled PNG assets only

Sandbox-only accounts used:

| Role                 | Email                            | Password used during QA    |
| -------------------- | -------------------------------- | -------------------------- |
| Application Owner    | `qa.owner@example.test`          | `QaOwner-2026-Reset!`      |
| Tenant administrator | `registered.admin@example.test`  | `QaRegister-2026-Changed!` |
| End user/editor      | `qa.editor+special@example.test` | `QaEditor-2026-Strong!`    |

These credentials exist only in the disposable QA database. The owner password was reset with the supported administration script to invalidate prior sessions before final role testing.

## Deployment Procedure

Commands exercised:

```powershell
npm ci --omit=dev
node scripts/setup.cjs
node --env-file=.env.qa server.cjs
node --env-file=.env.browser2 server.cjs
npm.cmd run check
npm.cmd audit --omit=dev --audit-level=high
```

Fresh installation installed 36 packages (37 audited), generated sandbox configuration, applied migrations, bootstrapped the owner, created runtime directories, and started successfully. The production-mode deployment served `/`, `/signature.html`, `/admin.html`, `/platform.html`, `/api/live`, `/api/ready`, `/api/health`, and `/api/metrics` with HTTP 200. CSP, HSTS, secure production configuration checks, and SQLite integrity checks passed.

## Routes and Workflows Tested

### Public and authentication

- `/` and `/signature.html`
- Login success/failure, logout, registration, duplicate registration
- Forgot-password request and development reset link flow
- Short/invalid/new passwords and login with changed password
- Invitation acceptance, consumed token behavior, and input validity
- Protected route redirects and expired/invalid session handling
- Three-level access: Application Owner, tenant administrator, end user
- Direct non-owner access to `/platform.html` now redirects to the account-required studio state

### Signature Studio

- Content fields: name, title, department, company, email, website, direct phone, mobile, address, and social URLs
- Special characters and XSS-like text rendered as text without script execution
- Eight layouts, accent color, saved-template selector, vCard option
- Photo, logo, and banner uploads using local sandbox files
- Eight banner repository assets and four animation effects
- Animated GIF generation, live preview, save, reload persistence, HTML copy, signature copy, and download trigger
- Empty, malformed, special-character, and boundary input behavior

### Tenant administration

- Overview/readiness/activity
- People search/filter, invitation, add-person cancel, Microsoft sync unavailable state
- Template rollout controls, selected-user rollout, and mail-provider unavailable state
- Brand lock, organization name, color, font, logo URL/upload, and persistence
- Campaign create/edit/cancel, repository selection, upload, dates, audiences, CTA, badge, event, colors, font family, weight, and headline size
- Department mapping create/delete with confirmation
- Approval submit, reject with note, resubmit, approve, and empty queue
- Analytics rendering and settings persistence
- Session-duration boundary values and approval policy toggle

### Application Owner console

- Setup identity and readiness controls
- Microsoft/Stripe setup unavailable and invalid-credential states
- Stripe defer/require setup controls
- Tenant search, status filters, pagination state, create, suspend, reactivate, and subscription updates
- Owner-only subscription actions and provider-unavailable errors
- Application Owner grant validation and idempotent self-grant
- Update check success structure in tests and unreachable-channel live failure
- Backup create, list, download, cancel, staged restore, restore cancellation, pending-backup delete rejection, and completed deletion
- Full staged database restore across an exclusive Node.js restart, including automatic pre-restore safety backup
- Application audit table and operation records

## API Coverage

Every route family discovered in `server.cjs` and `server/signature-portal.cjs` was exercised by browser workflows or the smoke/API suite:

- Runtime, liveness, readiness, health, and metrics
- Session, login, logout, registration, invitations, password reset, capabilities, and workspace switching
- Users, profiles, templates, previews, uploads, generated media, campaigns, departments, approvals, analytics, configuration, directory sync, rollout, and email
- Platform session/setup, tenants, owners, integrations, subscriptions, updates, backups, restore staging/cancellation, and audit
- Microsoft authorization/callback, browser-bound OAuth state, consent, directory pagination, and mail-provider behavior
- Stripe connection, prices, checkout, portal, subscription actions, webhook signature/idempotency, and owner-only enforcement

The API suite verified valid and malformed payloads, missing data, duplicate requests, authentication, CSRF, authorization, tenant isolation, status codes, structured errors, atomic updates, rate limits, provider failures, webhook retries/idempotency, and database reopen behavior.

## Responsive and Accessibility Checks

- Viewports: `1440x900`, `768x1024`, and `390x844`
- Studio and administration pages had no document overflow, incoherent overlap, or broken visible images
- Dialogs, tables, navigation, studio controls, and forms remained usable at each viewport
- Interactive controls were inspected for accessible names and state
- Added explicit labels for people filtering, rollout templates, campaign headline size, and saved-template selection
- Disabled provider controls, validation feedback, status toasts, modal close/cancel controls, and destructive confirmations were verified
- Browser logs contained no application console warnings/errors. One automation-runtime error was recorded because that runtime intentionally does not implement native `prompt()`; the Save Current trigger itself was exercised and normal browsers support the API.

## Defects Found and Fixed

### High - campaign overlay edit caused data loss

Reproduction: create a campaign with CTA, badge, event, font, weight, size, and colors; reopen Edit. Overlay controls reverted to defaults because the database did not store overlay metadata.

Fix: migration `015_campaign_overlay_metadata.sql`, server-side overlay validation/allowlists, API persistence/DTO support, edit-form hydration, and smoke regression tests. Live retest persisted all values after reload.

### Medium - successful async forms could throw after request completion

Reproduction: submit an Application Owner grant. The API succeeded, then the UI attempted `event.currentTarget.reset()` after `await`; the event target was null.

Fix: capture form/button references synchronously in all affected platform handlers. Added static frontend regressions forbidding post-await `event.currentTarget` use. Live grant completed, toasted success, and reset the form.

### Medium - update checker exposed a generic 500

Reproduction: check for updates while the release channel is unreachable. Native `fetch` rejection escaped as `Server error`.

Fix: normalize timeout/network failures to HTTP 502 `UPDATE_CHECK_FAILED` with an actionable user message. Added rejected-fetch tests. Live retest displayed `The release channel could not be reached.` and restored the enabled button.

### Medium - non-owner platform route exposed an unusable shell

Reproduction: tenant administrator navigates directly to `/platform.html`. The API returned 403, but the client redirected only for 401.

Fix: redirect for both 401 and 403. Live retest landed on `/signature.html?auth=account-required`.

### Medium - Windows restore replacement could fail on transient locks

Fix: bounded retry for `EBUSY`, `EACCES`, and `EPERM` during atomic database replacement. The implementation still refuses unsafe replacement when another server continuously owns the database. Exclusive-restart restore passed and restored the expected pre-backup value.

### Low - four controls lacked explicit accessible names

Fix: added explicit accessible labels to the affected filters/selectors/range input and verified discovery by label.

## Persistence and Reliability Evidence

- Migrations apply cleanly through version 015
- Database integrity, foreign keys, query plans, transaction behavior, and reopen safety pass automated tests
- Signature, settings, branding, campaign overlay, tenant, subscription, and approval changes survived refresh
- Deleted department mapping did not reappear
- Backup restore survived process restart and restored the prior application identity
- Pending restore was cleared after successful startup
- Automatic pre-restore safety backups were created
- Structured logs showed expected 4xx/502/503 responses for negative paths; no unexplained post-fix 500 remained

## Final Validation Results

```text
Prettier format check: PASS
ESLint: PASS
Unit tests: PASS
Frontend tests: PASS
Database tests: PASS
Background job tests: PASS
Media tests: PASS
Application operations tests: PASS
Setup tests: PASS
Smoke/API/integration tests: PASS
CycloneDX SBOM test (35 production components): PASS
Production build: PASS
Production artifact test (74 allowlisted files): PASS
npm production dependency audit: PASS - 0 vulnerabilities
Live desktop/tablet/mobile browser workflows: PASS
Database backup/restore restart test: PASS
```

## External Limitations

1. Microsoft 365: a real sandbox Entra tenant, application registration, client credential, and consent-capable administrator are required to execute a live Graph authorization, directory import, and mail send. No production tenant was used.
2. Stripe: a real Stripe test-mode secret and webhook signing secret are required for a successful hosted Checkout/Portal/webhook round trip. Invalid test-like credentials were rejected correctly; provider contracts and idempotency passed controlled integration tests.
3. Native download capture: the `.htm` download control was clicked, but the in-app browser automation did not surface its programmatic download event. HTML generation, copy output, endpoint behavior, and the control trigger were verified.
4. Email delivery: no sandbox SMTP/Graph provider was configured. Invitation/reset development links and controlled provider success/failure paths were verified.

## Final Disposition

The local Node.js application, database, three-tier authorization model, tenant workflows, signature functionality, owner operations, and deployment artifact are release-testable and passed all checks available in this environment. Provider-backed release acceptance remains conditional on supplying non-production Microsoft 365 and Stripe credentials and running the documented integration verification against those sandboxes.
