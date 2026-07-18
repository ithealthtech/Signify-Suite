# Signify Creator

Signify Creator is a self-hosted, multi-tenant email-signature SaaS for
Node.js. It provides an Outlook-safe signature studio, reusable templates,
campaign banners, approvals, bulk rollout, tenant-scoped Microsoft 365
integration, Application Owner billing, analytics, audit history, uploads, QR
codes, and vCards.

## Access Model

Signify has three explicit access tiers:

1. **Application Owner** manages tenants, SaaS subscriptions, Stripe,
   Application Owner grants, integrations, and the global audit trail.
2. **Tenant Admin** manages users, branding, campaigns, approvals, and
   Microsoft 365 consent for one tenant.
3. **End User** creates and manages signatures only in assigned tenants.

Tenant Admin access never grants Application Owner authority. Stripe controls
are available only in the Application Owner control plane.

## Requirements

- Node.js 22.13 or newer; Node.js 24 LTS is recommended
- npm 10 or newer
- A persistent, writable filesystem
- An HTTPS reverse proxy for production
- Optional: a multi-tenant Microsoft Entra application
- Optional: a Stripe account

Signify uses Node's built-in HTTP server and SQLite. Express, PostgreSQL, and a
separate web server are not required inside the application process.

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
configured bootstrap account, and select **Application > First-time setup**.
Database migrations run automatically when the server starts.

## Production Installation

### Install a release package

Extract the GitHub release, open a terminal in that directory, and run:

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
- prints the login password and First-time setup URL

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

SIGNATURE_SESSION_HOURS=12
SIGNIFY_TENANT_MEDIA_LIMIT_MB=250
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
storage for each tenant. Keep the encryption key outside database backups.
Losing the key makes credentials saved through the integration wizard
unrecoverable.

Set `TRUST_PROXY=true` only when the Node.js port is inaccessible directly and
traffic arrives through a trusted reverse proxy.

#### Configuration checklist

Use this table when filling in `.env.local`. Microsoft 365 and Stripe can be
configured later from **Application > First-time setup**.

| Setting                             | What to enter                                            | Required                        |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `NODE_ENV`                          | `production`                                             | Yes                             |
| `HOST` / `PORT`                     | Private listen address and hosting-provider port         | Yes                             |
| `DATABASE_PATH`                     | Absolute path on persistent storage                      | Yes                             |
| `SIGNIFY_PUBLIC_URL`                | Public HTTPS address, with no trailing slash             | Yes                             |
| `SIGNIFY_ASSET_BASE_URL`            | Usually the same value as `SIGNIFY_PUBLIC_URL`           | Yes                             |
| `SIGNIFY_MEDIA_BASE_URL`            | Usually the same value as `SIGNIFY_PUBLIC_URL`           | Yes                             |
| `SIGNIFY_APPLICATION_OWNER_EMAIL`   | Email for the first Application Owner                    | Yes                             |
| `SIGNIFY_CREDENTIAL_ENCRYPTION_KEY` | One generated 32-byte key; keep it permanently           | Yes for UI-managed integrations |
| `SIGNATURE_ALLOW_DEFAULT_ADMIN`     | `false` after the first account exists                   | Yes                             |
| `TRUST_PROXY`                       | `true` only behind a trusted, private reverse proxy      | No                              |
| `MICROSOFT_*`                       | Leave blank and complete Microsoft setup in the owner UI | No                              |
| `STRIPE_*`                          | Leave blank and complete Stripe setup in the owner UI    | No                              |

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
- `public/uploads/`
- `public/generated-banners/`
- the configured backup directory

Do not deploy Signify to an ephemeral serverless filesystem.

## First-Time Application Setup

After the first Application Owner signs in, open
`https://your-domain.example/platform.html` and select **First-time setup**.

The wizard verifies:

1. Company identity and public URL
2. Credential-vault availability
3. Microsoft 365 application credentials and Graph permissions
4. Stripe configuration or an explicit billing deferral

Provider credentials entered in the UI are encrypted with AES-256-GCM before
storage and are never returned by the API or written to audit metadata.

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

After configuring real provider credentials, run read-only provider checks:

```powershell
npm run integrations:verify
```

The unauthenticated monitoring endpoints are:

```text
GET /api/live     process liveness
GET /api/ready    database readiness
GET /api/health   backwards-compatible readiness
GET /api/metrics  aggregate request counts, errors, status classes, and latency
```

Application logs are structured JSON and include request IDs, status codes,
duration, and sanitized server errors.

## Backups and Recovery

Create a consistent SQLite backup:

```powershell
npm run backup
```

Schedule this command at least daily and copy backups to separate durable
storage. Test restoration regularly.

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

Rotate the integration credential-encryption key while the app is stopped:

```powershell
$env:SIGNIFY_OLD_CREDENTIAL_ENCRYPTION_KEY="current-key"
$env:SIGNIFY_CREDENTIAL_ENCRYPTION_KEY="new-key"
npm run credentials:rotate
```

Update the hosted environment to the new key before restarting.

## Updating

1. Back up the database and uploaded assets.
2. Build a fresh `dist/` artifact from the new release.
3. Preserve the production environment variables and persistent directories.
4. Run `npm ci --omit=dev` in the new artifact.
5. Stop the old process and start the new process.
6. Confirm `GET /api/health` returns HTTP `200`.

Migrations are forward-only and run automatically on startup. Never replace or
delete the production database during an application update.

See [DEPLOYMENT.md](DEPLOYMENT.md) for additional proxy, provider, backup, and
release details.
