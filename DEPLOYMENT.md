# Deployment

## 1. Build and install

```powershell
npm ci
npm run check
cd dist
npm ci --omit=dev
```

Create `dist/.env.local` from `.env.example`. Never place production secrets in source control.

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

## 7. Backups and monitoring

Schedule `npm run backup` at least daily and copy backups to separate durable storage. Test restoration by starting a release against a copied backup. Monitor `GET /api/health`, process exits, HTTP 5xx logs, failed directory sync runs, and Stripe webhook delivery failures.

`BACKUP_DIR` is an operator-controlled filesystem location. The workspace backup-location field is informational and does not override the server environment variable.

## 8. Start

```powershell
node --env-file=.env.local server.cjs
```

Run the process under Windows Service Manager, NSSM, systemd, Docker, or another supervisor that restarts failed processes and captures stdout/stderr JSON logs.
