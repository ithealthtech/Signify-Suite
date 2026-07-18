# Signify Creator

Signify Creator is a multi-tenant email-signature SaaS. It combines an Outlook-safe signature studio with member governance, reusable templates, campaigns, approvals, bulk rollout, per-tenant Microsoft 365 integration, Application Owner-managed Stripe subscriptions, click analytics, audit history, image uploads, QR codes, and vCards.

Access has three explicit tiers:

1. **Application Owner** controls tenant lifecycle, SaaS subscriptions, Stripe, Application Owner grants, and the global audit trail.
2. **Tenant Admin** controls users, branding, campaigns, approvals, and Microsoft 365 consent for one tenant.
3. **End User** creates and manages signatures only within assigned tenants.

Tenant Admin status never grants Application Owner authority. Stripe routes and controls are not exposed in tenant or end-user interfaces.

## Requirements

- Node.js 22.13 or newer
- A writable local filesystem for SQLite and uploaded/generated assets
- HTTPS reverse proxy for production
- Optional Microsoft Entra application and sender mailbox
- Optional Stripe account, prices, and webhook endpoint

## Local development

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. Development creates the bootstrap administrator when the database is empty. Defaults are `admin@signify.local` and `SignifyDemo123!`; override them in `.env.local`.

For an explicit environment, copy `.env.example` to `.env.local`, set `NODE_ENV=development`, and change the bootstrap credentials. Database migrations run automatically at startup.

## Validation

```powershell
npm run format:check
npm run lint
npm test
npm run build
npm audit --omit=dev
```

`npm test` uses a temporary clean database and verifies migrations, the three-tier authorization model, Application Owner tenant lifecycle, tenant Microsoft admin consent and sign-in, owner-only Stripe access, browser-bound OAuth state, email verification, password recovery, invitations, CSRF, tenant isolation, approval integrity, atomic updates, subscription enforcement, Microsoft directory pagination, image normalization, saved-template rollout, campaign updates, brand rendering, signed/idempotent Stripe webhooks, rate limiting, database integrity, and database reopen behavior.

## Operations

Create a consistent SQLite backup after configuring `.env.local`:

```powershell
npm run backup
```

Reset an existing account to administrator access:

```powershell
$env:SIGNATURE_ADMIN_EMAIL="owner@example.com"
$env:SIGNATURE_ADMIN_PASSWORD="a-new-strong-password"
$env:SIGNATURE_ORGANIZATION_ID="org-id" # required only for multi-workspace accounts
npm run signature:reset-admin
```

Grant or recover global Application Owner access from the server console:

```powershell
$env:SIGNIFY_OWNER_EMAIL="owner@example.com"
npm run application:grant-owner
```

The account must already exist. This command does not change tenant membership.

The health endpoint is `GET /api/health`. Application logs are structured JSON and include request IDs, response status, duration, and server-side errors without response stack traces.

## Production artifact

```powershell
npm run build
cd dist
npm ci --omit=dev
node --env-file=.env.local server.cjs
```

The artifact excludes development data, backups, temporary merge files, tests, and installer code. See [DEPLOYMENT.md](DEPLOYMENT.md) for proxy, Microsoft, Stripe, backup, and release details.
