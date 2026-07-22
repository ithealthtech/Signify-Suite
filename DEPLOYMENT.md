# Deployment

## Recommended container deployment

Use `compose.yaml` for a single self-hosted server. Copy
`.env.container.example` to `.env.container`, configure the public HTTPS URL,
owner email, company name, and a generated credential-encryption key, then run:

```bash
docker compose build
docker compose run --rm setup
docker compose run --rm migrate
docker compose up -d web worker
docker compose exec web node scripts/doctor.cjs
```

Publish only the reverse proxy. The Compose port maps to `127.0.0.1` and must
not be exposed directly. Persist all three named volumes and include them in the
host backup policy. Setup and migrations are one-shot, idempotent services; the
web service does not process background jobs, and the worker does not accept
HTTP traffic.

The current SQLite topology is limited to one host, one web process, and one
worker process. Horizontal replicas require the documented PostgreSQL runtime
conversion and acceptance suite.

At startup, the web process acquires a renewable transactional lease in the
SQLite database. A concurrent web instance using that database exits with
`RUNTIME_LEASE_HELD`; readiness becomes unavailable if the running process loses
its lease. This is a deployment guard, not horizontal scaling. Keep one web and
one worker on the same host and durable volume until the live application
runtime has been converted to PostgreSQL.

## 1. Build and install

```powershell
npm ci
npm run check
cd dist
npm ci --omit=dev
npm run setup
```

`npm run setup` is the normal first-install path. It validates persistent
storage, generates credentials, creates `.env.local`, runs migrations, and
creates the first Application Owner. Never place production secrets in source
control.

The installer automatically resolves absolute application, database, and
backup paths. It recognizes common Azure, Railway, Render, Hostinger, and Replit
domain and volume variables. Set `SIGNIFY_STORAGE_ROOT` when the provider
exposes a durable volume under a different variable; explicit `DATABASE_PATH`
and `BACKUP_DIR` values override all detection.

Hosting panels can provide configuration without a local environment file:

```powershell
npm run setup -- --non-interactive --no-write-env
```

After noninteractive setup, disable `SIGNATURE_ALLOW_DEFAULT_ADMIN`, remove the
bootstrap password from the hosting panel, and restart the application.

## 2. Required configuration

Set `NODE_ENV=production`, a writable absolute `DATABASE_PATH`, `HOST=127.0.0.1`, and the external HTTPS `SIGNIFY_PUBLIC_URL`. Set `SIGNIFY_APPLICATION_OWNER_EMAIL` to the bootstrap account that will receive global Application Owner access. Leave `SIGNATURE_ALLOW_DEFAULT_ADMIN=false` after initial account creation. If bootstrap is temporarily enabled, use a unique `SIGNIFY_BOOTSTRAP_PASSWORD` of at least 10 characters and disable bootstrap after the first start.

On an existing production database, the configured Application Owner email must already match an account. Signify never promotes an arbitrary Tenant Admin during production migration. If the configured account was not present at first startup, set `SIGNIFY_OWNER_EMAIL` and run `npm run application:grant-owner` from the server console after creating or identifying the account.

`SIGNIFY_ASSET_BASE_URL` and `SIGNIFY_MEDIA_BASE_URL` must be publicly reachable HTTPS origins because email clients load signature assets outside the application session.

Microsoft identity settings require a client ID and client secret from one multi-tenant Entra application. Each customer tenant grants and stores its own consent from Workspace settings. `MICROSOFT_TENANT_ID` and `MICROSOFT_SENDER_EMAIL` are optional legacy/control-plane transactional mail settings; they are not used in place of tenant registration for directory sync or tenant mail. Stripe settings must include the secret key, webhook secret, and at least one configured price. Startup rejects partial production integration configuration.

## 3. Reverse proxy

Terminate TLS at IIS, nginx, Caddy, Azure Application Gateway, or another trusted proxy. Forward the original `Host` and `X-Forwarded-Proto` headers. Set `TRUST_PROXY=true` only when direct access to the Node port is blocked; this enables forwarded client IPs for authentication rate limiting.

Persist these paths across deployments:

- SQLite database and its `-wal`/`-shm` files
- `public/uploads/`
- `public/generated-banners/`
- backup destination

This release requires a persistent filesystem and should not be deployed to an ephemeral serverless runtime.

## 4. Hostinger Node.js Web Apps

Use a Hostinger Business or Cloud plan with the Node.js Web App deployment type. Select Node.js `24.x`, choose framework type `Other`, use `npm run build` as the build command, `dist` as the output directory, and `server.cjs` as the entry file. Add the production variables from `.env.example` in hPanel rather than uploading `.env.local`.

Before using Hostinger managed hosting, confirm that the configured database, upload, generated-banner, and backup directories persist across redeployments. If the plan cannot provide durable writable storage for those paths, deploy this release on a Hostinger VPS or use another host with a persistent volume. The application uses the built-in Node HTTP server and does not require Express.

For a new deployment without terminal access, set
`SIGNATURE_ALLOW_DEFAULT_ADMIN=false`, generate
`SIGNIFY_CREDENTIAL_ENCRYPTION_KEY` and `SIGNIFY_SETUP_TOKEN` using the commands
in the README, and start the application. Open `/setup.html` on the public HTTPS
domain. The application redirects normal pages to this installer until it
atomically creates the first Application Owner and records the permanent setup
lock. Remove `SIGNIFY_SETUP_TOKEN` from hPanel and restart after completion.

The setup status endpoint is `GET /api/setup/status`. It reports only readiness
checks and never returns either secret. `POST /api/setup/install` is rate
limited, requires the one-time token, and is disabled permanently once the
database contains an owner or installation-completion record.

## 5. Microsoft 365

Register one Entra application with **Accounts in any organizational directory** enabled. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`, then configure both web redirect URIs:

```text
https://your-domain.example/auth/microsoft/callback
https://your-domain.example/auth/microsoft/admin-consent/callback
```

Configure delegated Microsoft Graph permission `User.Read` for sign-in. Configure application permissions `User.Read.All`, `Organization.Read.All`, and `Mail.Send`; these require tenant-wide administrator consent. A Tenant Admin starts consent from Workspace settings, Microsoft returns the tenant ID, and Signify verifies that tenant through Microsoft Graph before storing the connection. The Entra administrator granting application permissions must hold a role Microsoft permits to approve those permissions; Global Administrator is the compatible choice for this permission set.

After consent, the Tenant Admin validates and saves a sender mailbox in Workspace settings. Directory sync, rollout delivery, invitations, and signature email use only that tenant's connection and sender. A Microsoft tenant ID can be connected to only one Signify tenant. Disconnecting Signify does not remove the enterprise application from Entra; the customer must separately revoke consent in Entra when required.

`MICROSOFT_TENANT_ID` and `MICROSOFT_SENDER_EMAIL` may be retained only for legacy installation migration and system-level verification/recovery mail. New tenant directory and email operations never fall back to those values.

Directory sync follows Microsoft Graph pagination, imports licensed users up to the available seat count, and commits the local import atomically.

## 6. Stripe

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the applicable `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_TEAM`, and `STRIPE_PRICE_BUSINESS` values. Stripe is a control-plane integration: only an Application Owner can create checkout or change stored subscription data. Tenant Admins and End Users have read-only plan/seat visibility and no Stripe API route. Register this webhook URL:

```text
https://your-domain.example/webhooks/stripe
```

Subscribe to Checkout session completion, customer subscription changes/deletion, and invoice paid/payment-failed events. The handler verifies signatures and stores event IDs before acknowledging successful processing.

Application Owners use `/platform.html` to create tenants, copy initial Tenant Admin invitation links, suspend or restore tenants, adjust seats/plans, inspect Microsoft connection health, manage owner grants, and review the global audit trail. Every lifecycle, subscription, Stripe, and owner-grant mutation requires CSRF validation and records an Application Owner audit event with a reason.

### Guided provider setup

Set one installation-level encryption key before storing credentials through
the owner interface:

```text
SIGNIFY_CREDENTIAL_ENCRYPTION_KEY=<32 bytes encoded as base64 or 64 hex characters>
```

Open **Application > First-time setup** after the first Application Owner signs
in. The wizard stores company/public URL settings, validates the Microsoft home
tenant application against Graph, and requires Stripe configuration or an
explicit billing deferral. **Application > Integrations** can then:

- validate and replace Microsoft application credentials
- display Microsoft tenant and granted application-permission health
- validate a Stripe test or live key and discover recurring prices
- map Signify plans and create the signed webhook endpoint
- open Stripe's customer portal and submit plan, cancellation, or reactivation changes
- disconnect either provider with an audited reason

Provider secrets are encrypted with AES-256-GCM and provider-specific
authenticated context. They are never returned by the API or included in audit
metadata. Keep the encryption key outside database backups. Losing it makes
stored provider credentials unrecoverable.

Rotate the encryption key while the application is stopped:

```powershell
$env:SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY="<current key>"
$env:SIGNIFY_CREDENTIAL_ENCRYPTION_KEY="<new key>"
npm run credentials:rotate
```

Update the hosted environment to the new key before restarting. Verify real
provider access without exposing secrets:

```powershell
npm run integrations:verify
```

## 7. Backups and monitoring

Schedule `npm run backup` at least daily and copy backups to separate durable storage. Test restoration by starting a release against a copied backup. Monitor `GET /api/health`, process exits, HTTP 5xx logs, failed directory sync runs, and Stripe webhook delivery failures.

`BACKUP_DIR` is an operator-controlled filesystem location. The workspace backup-location field is informational and does not override the server environment variable.

## 8. Start

```powershell
node --env-file=.env.local server.cjs
```

Run the process under Windows Service Manager, NSSM, systemd, Docker, or another supervisor that restarts failed processes and captures stdout/stderr JSON logs.

## 9. Immutable staging and production delivery

The release workflow deploys a published artifact to the GitHub `staging`
environment first. Production cannot start until staging has completed. Create
both protected GitHub environments and configure these environment secrets:

- `SIGNIFY_SSH_HOST` and `SIGNIFY_SSH_USER`
- `SIGNIFY_SSH_PRIVATE_KEY`, limited to the deployment account
- `SIGNIFY_SSH_KNOWN_HOSTS`, generated from a separately verified host key
- `SIGNIFY_DEPLOY_ROOT`, an absolute host directory without shell metacharacters
- `SIGNIFY_DEPLOY_COMMAND`, an absolute executable host-adapter path
- `SIGNIFY_HEALTH_URL`, the environment readiness URL

Require manual approval on the production environment. The deployment account
must not have interactive root access and should only write the release and
incoming directories and invoke the restart adapter.

The host adapter receives the extracted artifact directory as its only
argument. It must load the persistent environment and invoke the deployment
controller from that artifact. Example `/opt/signify/bin/deploy`:

```sh
#!/bin/sh
set -eu
artifact="$1"
exec node --env-file=/opt/signify/shared/.env.local \
  "$artifact/scripts/deploy-release.cjs" "$artifact"
```

The controller rejects files not listed in `checksums.txt`, checksum changes,
and version downgrades. A disaster-recovery rollback to an older application
version requires the operator to set `SIGNIFY_DEPLOY_ALLOW_DOWNGRADE=true` for
that deployment invocation and document the database compatibility decision.

Configure the persistent environment:

```env
SIGNIFY_RELEASES_DIR=/opt/signify/releases
SIGNIFY_CURRENT_LINK=/opt/signify/current
SIGNIFY_DEPLOY_RESTART_SCRIPT=/opt/signify/bin/restart
SIGNIFY_DEPLOY_HEALTH_URL=https://signify.example.com/api/ready
DATABASE_PATH=/opt/signify/shared/data/signify-creator.db
```

The restart adapter takes no arguments and should restart the web and external
worker supervisors. The controller verifies every artifact checksum, installs
locked production dependencies, migrates a copied database as a preflight,
atomically changes the current-release link, and requires readiness to report
the candidate version. A failed restart or health gate restores the prior link,
restarts it, and verifies rollback health. Database migrations remain
forward-only, so create a recovery point immediately before deployment.

Hostinger managed Node.js Web Apps may not provide SSH, stable symlinks, or a
restart adapter. In that environment, keep GitHub production deployment
disabled and use Hostinger's external deployment mechanism with the same
artifact, staging, preflight, readiness, and rollback gates. A Hostinger VPS can
use the supplied controller directly.
