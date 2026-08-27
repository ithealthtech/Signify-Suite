# Signify Creator

**Current stable release:** [v1.0.0](https://github.com/ithealthtech/Signify-Suite/releases/tag/v1.0.0) ·
[Download the latest signed production package](https://github.com/ithealthtech/Signify-Suite/releases/latest)

Signify Creator is a self-hosted, multi-tenant email-signature SaaS for
Node.js. It provides an Outlook-safe signature studio, reusable templates,
campaign banners, approvals, bulk rollout, tenant-scoped Microsoft 365
integration, Application Owner billing, analytics, audit history, uploads, QR
codes, and vCards.

![Signify Creator Application Owner fleet dashboard](docs/images/application-owner-fleet.png)

## Access Model

Signify has three explicit access tiers:

1. **Application Owner** manages tenants, SaaS subscriptions, Stripe,
   Application Owner grants, integrations, and the global audit trail.
2. **Tenant Admin** manages users, branding, campaigns, approvals, and
   Microsoft 365 consent for one tenant.
3. **End User** creates and manages signatures only in assigned tenants.

Tenant Admin access never grants Application Owner authority. Stripe provider
credentials and integration controls are available only in the Application
Owner control plane. An expired tenant admin can open Stripe-hosted Checkout to
activate a subscription without receiving access to Stripe configuration.

## Requirements

- Docker Engine with Docker Compose for the recommended self-hosted deployment
- Node.js 22.13 or newer; Node.js 24 LTS is recommended
- npm 10 or newer
- A persistent, writable filesystem
- An HTTPS reverse proxy for production
- Optional: a multi-tenant Microsoft Entra application
- Optional: a Stripe account
- Optional: a fine-grained GitHub token with read-only Contents permission for
  private release detection and application updates

Signify uses Node's built-in HTTP server and SQLite. Express, PostgreSQL, and a
separate web server are not required inside the application process.

### PostgreSQL transition

The release includes a production-typed PostgreSQL schema and migration runner,
but the web request path remains on SQLite until its repositories are converted
and tenant-isolation acceptance passes against PostgreSQL. `DATABASE_URL` is not
a runtime database selector yet.

Validate a dedicated, empty sandbox database with:

```bash
TEST_DATABASE_URL=postgresql://signify_test:password@host:5432/signify_test \
DATABASE_SSL_MODE=verify-full npm run postgres:test
```

Apply migrations to an intentionally configured database with:

```bash
DATABASE_URL=postgresql://signify:password@host:5432/signify \
DATABASE_SSL_MODE=verify-full npm run postgres:migrate
```

Production rejects `DATABASE_SSL_MODE=disable`. Supply `DATABASE_CA_CERT` for a
private certificate authority. Migration history has SHA-256 checksums and is
serialized with a PostgreSQL advisory lock.

Import a fully migrated SQLite database only into an empty PostgreSQL target:

```bash
SOURCE_DATABASE_PATH=/persistent/signify/data/signify-creator.db \
DATABASE_URL=postgresql://signify:password@host:5432/signify \
DATABASE_SSL_MODE=verify-full npm run postgres:import
```

The importer opens SQLite read-only, verifies integrity and foreign keys, copies
all application tables in dependency order inside one serializable transaction,
and compares every target row count. Any populated target or mismatch aborts and
rolls back the import.

## Quick Start

Clone the repository and install dependencies:

```powershell
git clone https://github.com/ithealthtech/Signify-Suite.git
cd Signify-Suite
npm ci
```

Create the local configuration:

```powershell
Copy-Item .env.example .env.local
```

For local development, update these values in `.env.local`:

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=4173
SIGNATURE_ALLOW_DEFAULT_ADMIN=true
SIGNIFY_BOOTSTRAP_EMAIL=admin@example.com
SIGNIFY_BOOTSTRAP_PASSWORD=replace-with-a-unique-password
SIGNIFY_APPLICATION_OWNER_EMAIL=admin@example.com
SIGNIFY_PUBLIC_URL=http://127.0.0.1:4173
SIGNIFY_ASSET_BASE_URL=http://127.0.0.1:4173
SIGNIFY_MEDIA_BASE_URL=http://127.0.0.1:4173
```

Generate a credential-encryption key and add it to `.env.local`:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

```env
SIGNIFY_CREDENTIAL_ENCRYPTION_KEY=paste-the-generated-value-here
```

Start the application:

```powershell
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173), sign in with the
configured bootstrap account. Database migrations run automatically when the
server starts. Transactional email, Microsoft 365, Stripe, and GitHub can be
connected later from **Application > Integrations**.

## Production Installation

### Recommended: Docker Compose

Docker Compose runs an immutable, non-root web container, a separately
supervised worker, one-shot setup and migration tools, health checks, and named
persistent volumes. The application port binds to loopback so TLS terminates at
the host reverse proxy.

```bash
cp .env.container.example .env.container
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Set the generated value as `SIGNIFY_CREDENTIAL_ENCRYPTION_KEY` and replace the
public URL, company, and owner-email examples in `.env.container`. Then run:

```bash
docker compose build
docker compose run --rm setup
docker compose run --rm migrate
docker compose up -d web worker
docker compose exec web node scripts/doctor.cjs
```

The setup command prints the generated initial password. Sign in at the public
HTTPS URL and enroll Application Owner MFA. Optional providers are configured
from **Application > Integrations**.
Configure nginx, Caddy, or the hosting proxy to forward HTTPS traffic to
`127.0.0.1:4173` with the original host and `X-Forwarded-Proto` headers.

Runtime data is stored only in the `signify-data`, `signify-uploads`, and
`signify-generated-banners` volumes. The container root filesystem is read-only,
Linux capabilities are dropped, and both services run as the unprivileged
`node` user.

This SQLite Compose topology supports one web container and one worker on a
single host. Do not add web or worker replicas until PostgreSQL is the verified
runtime authority.

The web process holds a renewable transactional lease in SQLite. A second web
replica using the same database fails fast instead of accepting traffic with
ambiguous runtime ownership. One external worker remains supported. The
PostgreSQL commands currently migrate, validate, and import data; they do not
yet make `DATABASE_URL` the live application database.

### Install a release package

Open the [latest release](https://github.com/ithealthtech/Signify-Suite/releases/latest)
and download `signify-creator-vX.Y.Z.tar.gz` plus the matching `.sha256` file.
Verify that the checksum in the sidecar matches the archive, extract the
archive, open a terminal in that directory, and run:

```powershell
npm ci --omit=dev
npm run setup
npm start
```

The interactive installer asks only for values it cannot detect, such as the
owner email and company name. It reads the application path, persistent-volume
path, database path, backup path, host, port, proxy mode, and public domain from
the application and hosting environment. It shows the detected paths before
making changes. It then:

- verifies Node.js and all writable directories
- generates the credential-encryption key and initial owner password
- writes `.env.local` with bootstrap disabled
- initializes SQLite and applies every migration
- creates the first Application Owner
- prints the login password and application URL

Store the displayed password immediately; it is shown only for a fresh
installation. If `.env.local` already exists, the installer backs it up before
updating it. Rerunning setup validates the installation without resetting users
or passwords.

Detection recognizes `PORT`, `WEBSITE_HOSTNAME`, `RAILWAY_PUBLIC_DOMAIN`,
`RAILWAY_VOLUME_MOUNT_PATH`, `RENDER_EXTERNAL_URL`, `RENDER_DISK_PATH`,
`HOSTINGER_APP_URL`, `REPLIT_DOMAINS`, and `PERSISTENT_STORAGE_PATH`. Set
`SIGNIFY_STORAGE_ROOT` to the host's durable volume when its variable is not
recognized. Explicit `DATABASE_PATH`, `BACKUP_DIR`, `HOST`, `PORT`,
`SIGNIFY_PUBLIC_URL`, and `TRUST_PROXY` values always take precedence.

For a hosting panel that supplies environment variables and does not provide an
interactive terminal, configure the required values in the panel and run:

```powershell
npm run setup -- --non-interactive --no-write-env
```

After that command, set `SIGNATURE_ALLOW_DEFAULT_ADMIN=false`, remove
`SIGNIFY_BOOTSTRAP_PASSWORD` from the panel, and restart the application. Run
`npm run setup -- --help` for all installer options.

### Browser installer for managed Node.js hosting

When the host provides a deployment panel but no interactive terminal, configure
these values in the hosting environment before the first start:

```env
NODE_ENV=production
HOST=0.0.0.0
PORT=4173
TRUST_PROXY=true
DATABASE_PATH=/persistent/signify/data/signify-creator.db
BACKUP_DIR=/persistent/signify/backups
SIGNATURE_ALLOW_DEFAULT_ADMIN=false
SIGNIFY_APPLICATION_OWNER_EMAIL=owner@example.com
SIGNIFY_PUBLIC_URL=https://signatures.example.com
SIGNIFY_ASSET_BASE_URL=https://signatures.example.com
SIGNIFY_MEDIA_BASE_URL=https://signatures.example.com
SIGNIFY_CREDENTIAL_ENCRYPTION_KEY=<generated-base64-key>
SIGNIFY_SETUP_TOKEN=<generated-one-time-token>
```

Generate the credential key and one-time setup token locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Deploy and start `server.cjs`, then open
`https://your-domain.example/setup.html`. Until installation completes, normal
pages redirect to the installer and application APIs remain unavailable. Enter
the setup token, company identity, and first Application Owner credentials. The
operation is transactional and permanently locks the installer in the database.
Remove `SIGNIFY_SETUP_TOKEN` from the hosting panel and restart after success.

The browser installer does not invent persistent paths. Confirm the host keeps
the database, uploads, generated banners, and backups across redeployments. Use
the CLI installer when shell access is available because it can detect and
validate those paths directly.

### 1. Build the release

From a clean source checkout:

```powershell
npm ci
npm run check
```

`npm run check` runs formatting validation, ESLint, integration tests, database
migrations, and the production build. The deployable application is written to
`dist/`.

### 2. Install production dependencies

```powershell
Set-Location dist
npm ci --omit=dev
npm run setup
```

The `dist/` directory is self-contained and excludes development databases,
backups, and tests.

### 3. Configure production

The installer creates `dist/.env.local`. For noninteractive hosting, set these
values in the hosting provider's environment-variable interface before running
setup:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
TRUST_PROXY=true
LOG_LEVEL=info

DATABASE_PATH=/persistent/signify/data/signify-creator.db
BACKUP_DIR=/persistent/signify/backups
SIGNIFY_BACKUP_STORAGE=s3
SIGNIFY_BACKUP_RETENTION_DAYS=30
SIGNIFY_BACKUP_MINIMUM_COPIES=7
SIGNIFY_BACKUP_INCLUDE_LOCAL_MEDIA=true
BACKUP_S3_BUCKET=signify-production-recovery
BACKUP_S3_REGION=us-east-1
BACKUP_S3_PREFIX=signify-recovery

SIGNATURE_SESSION_HOURS=12
SIGNIFY_TENANT_MEDIA_LIMIT_MB=250
SIGNIFY_TENANT_DELETION_GRACE_DAYS=7
SIGNIFY_SERVICE_NAME=signify-creator
SIGNIFY_ENVIRONMENT=production
SIGNIFY_OBSERVABILITY_ENDPOINT=https://collector.example.com/events
SIGNIFY_OBSERVABILITY_TOKEN=replace-with-collector-token
SIGNATURE_ALLOW_DEFAULT_ADMIN=false
SIGNIFY_BOOTSTRAP_EMAIL=owner@example.com
SIGNIFY_BOOTSTRAP_PASSWORD=replace-with-a-long-random-password
SIGNIFY_APPLICATION_OWNER_EMAIL=owner@example.com
SIGNIFY_COMPANY_NAME=Example Company
SIGNIFY_PUBLIC_URL=https://signatures.example.com
SIGNIFY_ASSET_BASE_URL=https://signatures.example.com
SIGNIFY_MEDIA_BASE_URL=https://signatures.example.com
SIGNIFY_ALLOW_REGISTRATION=false
SIGNIFY_CREDENTIAL_ENCRYPTION_KEY=replace-with-a-generated-32-byte-key
```

Use absolute persistent paths for `DATABASE_PATH` and `BACKUP_DIR`.
`SIGNIFY_TENANT_MEDIA_LIMIT_MB` limits the combined uploads and generated-banner
storage for each tenant. `SIGNIFY_TENANT_DELETION_GRACE_DAYS` controls the
reversible delay before a scheduled tenant purge and accepts 1 through 90 days.
Keep the encryption key outside database backups.
Losing the key makes credentials saved through the integration wizard
unrecoverable.

`SIGNIFY_OBSERVABILITY_ENDPOINT` is optional and must use HTTPS in production.
When configured, the web and worker processes batch redacted diagnostic events
to the collector. Store `SIGNIFY_OBSERVABILITY_TOKEN` in the hosting provider's
secret store. Prometheus-compatible metrics remain available at
`GET /api/metrics/prometheus`; see `docs/OBSERVABILITY.md` for alert and SLO
operations.

Set `TRUST_PROXY=true` only when the Node.js port is inaccessible directly and
traffic arrives through a trusted reverse proxy.

#### Configuration checklist

Use this table when filling in `.env.local`. Transactional email, Microsoft
365, Stripe, and GitHub can be configured later from **Application >
Integrations**.

| Setting                              | What to enter                                            | Required          |
| ------------------------------------ | -------------------------------------------------------- | ----------------- |
| `NODE_ENV`                           | `production`                                             | Yes               |
| `HOST` / `PORT`                      | Private listen address and hosting-provider port         | Yes               |
| `DATABASE_PATH`                      | Absolute path on persistent storage                      | Yes               |
| `SIGNIFY_PUBLIC_URL`                 | Public HTTPS address, with no trailing slash             | Yes               |
| `SIGNIFY_ASSET_BASE_URL`             | Usually the same value as `SIGNIFY_PUBLIC_URL`           | Yes               |
| `SIGNIFY_MEDIA_BASE_URL`             | Usually the same value as `SIGNIFY_PUBLIC_URL`           | Yes               |
| `SIGNIFY_APPLICATION_OWNER_EMAIL`    | Email for the first Application Owner                    | Yes               |
| `SIGNIFY_CREDENTIAL_ENCRYPTION_KEY`  | One generated 32-byte key; keep it permanently           | Yes               |
| `SIGNIFY_LICENSE_PUBLIC_KEY`         | Publisher-provided Ed25519 public verification key       | Commercial builds |
| `SIGNIFY_LICENSE_AUTHORITY_URL`      | Publisher-provided HTTPS licensing service URL           | Commercial builds |
| `SIGNIFY_RELEASE_SIGNING_PUBLIC_KEY` | Publisher release verification public key                | Managed updates   |
| `SIGNIFY_JOB_MODE`                   | `embedded`, or `external` with a supervised worker       | Yes               |
| `SIGNIFY_UPDATE_GITHUB_TOKEN`        | Fine-grained read-only token for private release checks  | Private repo only |
| `SIGNIFY_UPDATE_CHECK_HOURS`         | Automatic release-check interval; defaults to `6`        | No                |
| `SIGNIFY_RELEASES_DIR`               | Absolute immutable-release storage path                  | Managed updates   |
| `SIGNIFY_CURRENT_LINK`               | Absolute active-release link                             | Managed updates   |
| `SIGNIFY_DEPLOY_RESTART_SCRIPT`      | Absolute supervisor restart adapter                      | Managed updates   |
| `SIGNIFY_DEPLOY_HEALTH_URL`          | Public `/api/ready` URL used after restart               | Managed updates   |
| `SIGNIFY_MEDIA_STORAGE`              | `local` for one host, or `s3` for private object storage | Yes               |
| `SIGNIFY_TENANT_DELETION_GRACE_DAYS` | Reversible tenant-deletion delay from `1` through `90`   | Yes               |
| `S3_BUCKET` / `S3_REGION`            | Tenant-media bucket and its region                       | With `s3`         |
| `S3_ENDPOINT`                        | S3-compatible endpoint; blank for AWS                    | Provider-specific |
| `S3_ACCESS_KEY_ID` / secret          | Static credentials, or workload identity                 | Provider-specific |
| `SIGNATURE_ALLOW_DEFAULT_ADMIN`      | `false` after the first account exists                   | Yes               |
| `SIGNIFY_REQUIRE_OWNER_MFA`          | `true` to require enrollment before control-plane use    | Yes               |
| `TRUST_PROXY`                        | `true` only behind a trusted, private reverse proxy      | No                |
| `SIGNIFY_MAIL_PROVIDER`              | `resend` for account email, or `disabled` during setup   | Before launch     |
| `RESEND_API_KEY`                     | Resend API key stored in the host secret store           | With `resend`     |
| `SIGNIFY_MAIL_FROM`                  | Verified sender, such as `Signify <hello@example.com>`   | With `resend`     |
| `SIGNIFY_MAIL_REPLY_TO`              | Optional monitored support mailbox                       | No                |
| `MICROSOFT_*`                        | Leave blank and complete Microsoft setup in the owner UI | No                |
| `STRIPE_*`                           | Leave blank and complete Stripe setup in the owner UI    | No                |

Generate the encryption key once:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Do not regenerate this key during an update. Use `npm run credentials:rotate`
when intentional rotation is required.

### 4. Start the Node.js application

```powershell
npm start
```

The equivalent direct command is:

```powershell
node --env-file=.env.local server.cjs
```

Run the process under a supervisor such as systemd, NSSM, Docker, PM2, or the
hosting provider's Node.js process manager. The process must receive `SIGTERM`
or `SIGINT` during shutdown so SQLite can close cleanly.

The default `SIGNIFY_JOB_MODE=embedded` runs the durable queue in the web
process and is appropriate for a single-process host. When the host can
supervise a second Node.js process, set `SIGNIFY_JOB_MODE=external` for the web
and run:

```powershell
npm run worker
```

Run exactly one worker for a SQLite deployment. The queue uses atomic claims,
but additional worker processes do not improve SQLite write throughput.
Microsoft directory synchronization and bulk signature rollout always execute
through this queue. Their status and result survive browser refreshes and web
process restarts; the tenant admin UI polls the authenticated, tenant-scoped job
endpoint until work completes.

For multi-instance or disposable application hosts, set
`SIGNIFY_MEDIA_STORAGE=s3`. Signify stores private, server-side-encrypted
objects under tenant-prefixed keys and serves stable signature URLs through the
application. Configure bucket versioning and lifecycle retention at the storage
provider. Do not make the bucket public. Static access keys are optional when
the host supplies an IAM workload identity.

Copy existing local media after configuring and testing the private bucket:

```powershell
npm run media:migrate
```

The command uploads every tenant object and verifies its SHA-256 content while
leaving local files intact. After backups and application reads have been
verified against S3, rerun with `-- --delete-source` to remove each local source
only after its remote content passes verification.

### 5. Configure the reverse proxy

Terminate TLS at nginx, Caddy, IIS, Apache, or the hosting platform. Proxy to
`127.0.0.1:4173` and preserve:

- `Host`
- `X-Forwarded-For`
- `X-Forwarded-Proto`

The public URL must use HTTPS in production. Do not expose the internal Node.js
port directly to the internet.

### 6. Preserve application data

These locations must survive deployments and restarts:

- the SQLite database plus its `-wal` and `-shm` files
- `public/uploads/` and `public/generated-banners/` when using local media
- the private object-storage bucket and version history when using S3 media
- the configured backup directory

Do not deploy Signify to an ephemeral serverless filesystem.

## First-Time Application Setup

Fresh deployments use the standalone page at
`https://your-domain.example/setup.html`. Before installation completes, all
normal application pages redirect to this installer and protected APIs fail
closed.

The progress tracker has three stages:

1. **Setup** verifies Node.js, storage, migrations, HTTPS, credential-vault
   configuration, the one-time setup token, company name, and public URL.
2. **Configure** creates the first Application Owner with a strong password.
3. **Sign in** unlocks the application only after the installation transaction
   commits successfully.

After installation, remove `SIGNIFY_SETUP_TOKEN` from the host and restart the
application. The installer remains locked by database state. Transactional
email, Microsoft 365, Stripe, and GitHub are optional during setup and can be
connected later from **Application > Integrations**.

Provider credentials entered in the owner UI are encrypted with AES-256-GCM
before storage and are never returned by the API or written to audit metadata.

### Community and commercial licensing

An installation without a commercial key runs as **Community Edition** and can
manage its initial workspace with up to 10 users and managed signatures. The
Application page becomes a single-workspace settings view and does not expose
multi-tenant creation. Application Owners use **Application > Licensing**
to copy the installation ID, enter a commercial license key, inspect tenant
capacity and expiration, validate the current entitlement, or return to
Community Edition. A key can also be entered during first-time browser setup;
customers do not need a server console for activation.

Commercial keys are Ed25519-signed entitlements bound to one installation ID.
Tenant and per-tenant user capacity are enforced by the server for Application
Owner tenant creation, public workspace registration, invitations, direct user
creation, invitation acceptance, and Microsoft 365 directory sync. Pending
invitations reserve user capacity. Expired licenses retain data and exports but
revert creation capacity to the Community limits after the signed grace period.

Official builds embed the Signify-controlled public key and HTTPS authority URL.
The owner UI exchanges activation keys, refreshes rights immediately, reports
offline grace and revocation state, and automatically refreshes every 12 hours.
Central Stripe product mappings control tenant capacity and features without
shipping Stripe credentials or the license private key to a customer host. See
[`docs/LICENSING.md`](docs/LICENSING.md) for the edition rights, authority
deployment, key boundary, and signed-release process.

### Transactional email

Open **Application > Integrations > Transactional Email** and enter a Resend
API key plus a sender from a verified domain. Signify sends a verification
message before encrypting and storing the key. This channel is used only for
account verification, password recovery, and invitations. Tenant Microsoft 365
connections remain separate and are used for signature delivery and directory
operations.

Public registration stays unavailable in production until transactional email
is connected. Direct user creation remains available to tenant administrators.
Completed and permanently failed delivery jobs remove message bodies and token
links from the durable queue.

### Microsoft 365

Register one Entra application for accounts in any organizational directory.
Configure these web redirect URIs:

```text
https://your-domain.example/auth/microsoft/callback
https://your-domain.example/auth/microsoft/admin-consent/callback
```

Required Microsoft Graph permissions:

- Delegated: `User.Read`
- Application: `User.Read.All`
- Application: `Organization.Read.All`
- Application: `Mail.Send`

Application permissions require tenant-wide administrator consent. Each
customer Tenant Admin completes consent for their own Microsoft tenant from
Workspace settings.

#### Centrally managed Outlook signatures

Tenant Admins can enable the Outlook add-in in **Workspace > Settings**, then
download `signify-outlook.xml`. In Microsoft 365 Admin Center, open **Settings >
Integrated apps > Upload custom apps**, upload the manifest, and assign it to
the tenant's users or groups. The add-in retrieves the current tenant-scoped
signature whenever a new message is composed. Inactive users, expired trials,
and past-due or canceled subscriptions receive an empty signature; delivery
resumes automatically after access is restored.

The manifest contains a narrow, read-only deployment credential. Rotating the
deployment key immediately invalidates the old manifest, so deploy the newly
downloaded manifest after rotation. Production add-in deployment requires the
configured public application URL to use HTTPS and remain reachable by Outlook.

### Stripe

Open **Application > Integrations** and enter a Stripe test secret key. Signify
can then:

- verify the Stripe account
- discover active recurring prices
- map prices to Starter, Team, and Business
- create and maintain the signed webhook endpoint
- launch a test-mode Checkout session

Move to a live key only after sandbox verification succeeds. Stripe remains an
Application Owner integration; tenant users never receive Stripe credentials or
provider controls.

### Private GitHub releases

Open **Application > Integrations**, select **GitHub**, and enter:

- repository name in `owner/repository` format
- a fine-grained personal access token restricted to that repository
- repository permission **Contents: Read-only**; no write or organization
  permissions are required

Signify verifies private repository access before encrypting the token. Update
checks use the stored credential server-side to read the latest release and its
download assets. The token is never returned to the browser. Configure
`SIGNIFY_UPDATE_REPOSITORY` and `SIGNIFY_UPDATE_GITHUB_TOKEN` instead when an
unattended environment-based integration is preferred.

Release detection runs every six hours by default. Change
`SIGNIFY_UPDATE_CHECK_HOURS` when a different interval is required. Managed
installations can use **Application > Updates & backups > Install update** after
configuring the release directory, current-release link, restart adapter,
health URL, and publisher signing key documented in [DEPLOYMENT.md](DEPLOYMENT.md).
Signify downloads the private release server-side, verifies the SHA-256 digest
and Ed25519 signature, preflights migrations against a database copy, creates a
safety backup, restarts, and rolls back automatically if readiness fails.
Hosting panels without stable links and a restart adapter remain download-only
and should deploy the same signed package through their native release system.

The host must allow outbound HTTPS access to `api.github.com` and GitHub release
asset endpoints. Revoke and replace any token that appears in a URL, log, or
support transcript.

## Hostinger Node.js Web Apps

For Hostinger Business or Cloud Node.js hosting, use:

| Setting          | Value           |
| ---------------- | --------------- |
| Node.js version  | `24.x`          |
| Framework        | `Other`         |
| Build command    | `npm run build` |
| Output directory | `dist`          |
| Entry file       | `server.cjs`    |

Add production environment variables in hPanel instead of uploading
`.env.local`. Confirm that Hostinger persists the database, uploads, generated
banners, and backups across deployments. If persistent writable storage is not
available, use a Hostinger VPS or another host with a persistent volume.

## Validation and Health

Capture the current size, dependency, test-duration, startup, and health-request
baseline with:

```bash
npm run benchmark
```

The machine-readable result is written to `docs/performance-current.json` for
comparison with the initial `docs/performance-baseline.json`; methodology and
acceptance rules are in `docs/OPTIMIZATION.md`.

Run the complete local validation suite:

```powershell
npm run check
npm audit --omit=dev
```

After configuring provider credentials, run read-only permission and endpoint
checks:

```powershell
npm run integrations:verify
```

Before a release, use dedicated Microsoft 365 and Stripe test resources, set
`SIGNIFY_ACCEPTANCE_M365_SENDER` to a sandbox mailbox, then run
`npm run integrations:accept`. The command refuses Stripe live keys, sends one
labeled Microsoft test message, creates and expires one Stripe test Checkout,
and writes a credential-free report to `tmp/provider-acceptance.json`. See
`docs/OPERATIONS.md` for the required permissions and evidence procedure.

The unauthenticated monitoring endpoints are:

```text
GET /api/live     process liveness
GET /api/ready    database readiness
GET /api/health   backwards-compatible readiness
GET /api/metrics  aggregate request counts, errors, status classes, and latency
```

Application logs are structured JSON and include request IDs, status codes,
latency, and sanitized server errors. The production deployment, monitoring, queue recovery,
backup, restore, rollback, and capacity runbook is in `docs/OPERATIONS.md`. A
CycloneDX production dependency inventory is generated with `npm run sbom` and
included as `docs/sbom.cdx.json` in release artifacts.

Security reporting, ASVS evidence, privacy/retention baselines, subprocessors,
incident response, and service-term requirements are shipped in `SECURITY.md`
and the corresponding `docs/` records. Operators must complete legal entity,
jurisdiction, provider, and contact details before commercial launch.

## Backups and Recovery

Application Owners can manage on-demand snapshots from **Application > Updates
& backups**. Creating and downloading backups is immediate. Restores are staged
and applied safely on the next Node.js process restart; on Hostinger, use the
hosting panel's application restart action after staging. The prior database is
preserved automatically as a pre-restore safety backup.

Create a consistent SQLite backup:

```powershell
npm run backup
```

With `SIGNIFY_BACKUP_STORAGE=s3`, this validates the snapshot, requires bucket
versioning, uploads it with SHA-256 metadata and server-side encryption,
replicates local tenant media into versioned keys, and applies local/off-site
retention while preserving `SIGNIFY_BACKUP_MINIMUM_COPIES`. Static backup keys
are optional when the host supplies an IAM workload identity.

Run a non-destructive recovery drill against the newest configured recovery
point:

```powershell
npm run recovery:drill
```

Schedule backup at least daily and the drill at least quarterly. For local-only
mode, copy backups and media to a separate durable system.

Reset an existing Tenant Admin account:

```powershell
$env:SIGNATURE_ADMIN_EMAIL="owner@example.com"
$env:SIGNATURE_ADMIN_PASSWORD="a-new-strong-password"
$env:SIGNATURE_ORGANIZATION_ID="org-id" # only for multi-workspace accounts
npm run signature:reset-admin
```

Recover Application Owner access for an existing account:

```powershell
$env:SIGNIFY_OWNER_EMAIL="owner@example.com"
npm run application:grant-owner
```

Production defaults to `SIGNIFY_REQUIRE_OWNER_MFA=true`. On first sign-in, an
Application Owner can access only MFA setup until enrollment is complete.
Enrollment requires the current password and a TOTP authenticator; ten one-time
recovery codes are shown once. Owner sessions are limited to four hours, and
enabling or disabling MFA revokes the owner's other sessions.
The same security panel lists active devices, last activity, expiry, MFA
evidence, and supports audited individual or bulk session revocation.
High-impact owner changes require step-up authentication when the current
password and MFA proof are more than ten minutes old.

Rotate the integration and MFA credential-encryption key while the app is
stopped:

```powershell
$env:SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY="current-key"
$env:SIGNIFY_CREDENTIAL_ENCRYPTION_KEY="new-key"
npm run credentials:rotate
```

The rotation is atomic across provider and MFA secrets. Update the hosted
environment to the new key before restarting.

## Updating

1. Create an application backup and confirm off-site recovery is healthy.
2. Use **Application > Updates & backups** when managed updates are configured,
   or deploy the signed release package through the hosting platform.
3. Preserve the production environment variables and persistent directories.
4. Confirm `GET /api/ready` returns HTTP `200` with the new version.

Migrations are forward-only and run automatically on startup. Never replace or
delete the production database during an application update.

See [DEPLOYMENT.md](DEPLOYMENT.md) for additional proxy, provider, backup, and
release details.
