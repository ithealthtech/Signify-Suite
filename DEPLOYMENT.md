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

Set `NODE_ENV=production`, a writable absolute `DATABASE_PATH`, `HOST=127.0.0.1`, and the external HTTPS `SIGNIFY_PUBLIC_URL`. Leave `SIGNATURE_ALLOW_DEFAULT_ADMIN=false` after initial account creation. If bootstrap is temporarily enabled, use a unique `SIGNIFY_BOOTSTRAP_PASSWORD` of at least 10 characters and disable bootstrap after the first start.

`SIGNIFY_ASSET_BASE_URL` and `SIGNIFY_MEDIA_BASE_URL` must be publicly reachable HTTPS origins because email clients load signature assets outside the application session.

## 3. Reverse proxy

Terminate TLS at IIS, nginx, Caddy, Azure Application Gateway, or another trusted proxy. Forward the original `Host` and `X-Forwarded-Proto` headers. Set `TRUST_PROXY=true` only when direct access to the Node port is blocked; this enables forwarded client IPs for authentication rate limiting.

Persist these paths across deployments:

- SQLite database and its `-wal`/`-shm` files
- `public/uploads/`
- `public/generated-banners/`
- backup destination

This release requires a persistent filesystem and should not be deployed to an ephemeral serverless runtime.

## 4. Microsoft 365

Set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TENANT_ID` together. Configure this redirect URI in Entra ID:

```text
https://your-domain.example/auth/microsoft/callback
```

For invitations, password recovery, verification, individual signature delivery, and rollout email delivery, set `MICROSOFT_SENDER_EMAIL` and grant Microsoft Graph application permission `Mail.Send`. Directory sync requires application permission `User.Read.All`. Microsoft login requests delegated `User.Read` and uses it to fill missing profile fields and import the signed-in user's profile photo. Apply tenant admin consent to the application permissions.

## 5. Stripe

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the applicable `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_TEAM`, and `STRIPE_PRICE_BUSINESS` values. Register this webhook URL:

```text
https://your-domain.example/webhooks/stripe
```

Subscribe to Checkout session completion, customer subscription changes/deletion, and invoice paid/payment-failed events. The handler verifies signatures and stores event IDs before acknowledging successful processing.

## 6. Backups and monitoring

Schedule `npm run backup` at least daily and copy backups to separate durable storage. Test restoration by starting a release against a copied backup. Monitor `GET /api/health`, process exits, HTTP 5xx logs, failed directory sync runs, and Stripe webhook delivery failures.

## 7. Start

```powershell
node --env-file=.env.local server.cjs
```

Run the process under Windows Service Manager, NSSM, systemd, Docker, or another supervisor that restarts failed processes and captures stdout/stderr JSON logs.
