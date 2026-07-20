# Production Operations

## Deploy

1. Verify the release ZIP checksum.
2. Extract into a new versioned directory.
3. Preserve `.env.local`, the SQLite database including WAL/SHM files,
   `public/uploads`, `public/generated-banners`, and backups outside that
   directory.
4. Run `npm ci --omit=dev`, `npm run setup -- --non-interactive`, and
   `npm run integrations:verify`.
5. Start `server.cjs` and require `GET /api/ready` to return HTTP 200 before
   moving proxy traffic.

When `SIGNIFY_MEDIA_STORAGE=s3`, verify private object put/get/delete access and
bucket versioning before moving traffic. Stable signature media is proxied by
the application; provider credentials and raw object keys are never returned to
the browser.

For an existing local-media installation, run `npm run media:migrate` to copy
and SHA-256 verify objects without removing sources. Back up the local media,
verify representative signature URLs, then use
`npm run media:migrate -- --delete-source` only when the S3 copy is
authoritative.

## Monitor

- `GET /api/live` proves the Node process can serve requests.
- `GET /api/ready` proves SQLite is reachable.
- `GET /api/metrics` reports aggregate request counts, errors, status classes,
  average latency, queue health, provider failures, memory, and exporter state
  without tenant or user data. `GET /api/metrics/prometheus` exposes the same
  operational signals in Prometheus text format.
- Application logs are JSON. Alert on `server.start_failed`, `request.error`,
  repeated HTTP 500 responses, failed provider verification, and jobs that
  exhaust their attempts.
- Configure `SIGNIFY_OBSERVABILITY_ENDPOINT` to export bounded batches of
  redacted diagnostics. Failed delivery stays buffered and retries; the process
  never treats telemetry delivery as application success or availability.
- Incoming valid W3C `traceparent` headers keep their trace ID. Every response
  returns a child trace header and logs the same trace ID with the request ID.

The SLOs, alert thresholds, incident severities, retention boundaries, and
status communication procedure are defined in `docs/OBSERVABILITY.md`.

## Background Jobs

Jobs are stored in `background_jobs`. The worker atomically claims jobs, permits
only one active job per tenant, retries transient errors with exponential
backoff, and recovers stale locks after restart. Jobs that exhaust their retry
budget move to `dead_lettered` with their terminal error and timestamp retained.
Microsoft directory synchronization and bulk signature rollout are durable jobs;
the initiating request returns after validation and queueing, while the tenant
admin UI reads the persisted result from a tenant-scoped endpoint.

Use `SIGNIFY_JOB_MODE=embedded` when the web server is the only supervised
Node.js process. For a separately supervised worker, configure
`SIGNIFY_JOB_MODE=external` on the web process and run `npm run worker` with the
same environment and persistent storage. Stop both processes before replacing
or restoring the SQLite database. Start the web process before the worker after
staging a restore; only the web process is permitted to apply it. Run exactly
one worker for SQLite.

Do not edit jobs manually. An Application Owner can inspect recent jobs in the
control plane, diagnose the stored error, correct its root cause, and requeue a
dead-lettered job with a required audit reason. Requeueing resets the attempt
count and terminal timestamp without replacing the original job identity.

## Application Owner MFA

Each Application Owner can enroll a TOTP authenticator from the control plane.
Production requires enrollment by default, blocks other owner operations until
it is complete, and caps owner sessions at four hours.
The authenticator secret is encrypted with `SIGNIFY_CREDENTIAL_ENCRYPTION_KEY`;
recovery codes are stored only as hashes and are consumed once. Enrollment and
disablement revoke the owner's other sessions and create application audit
records. Run `npm run credentials:rotate` while the application is stopped to
rotate both provider credentials and MFA secrets in one database transaction.
Owners can also review their active device history and revoke one or all other
sessions. Session revocation requires a reason and is recorded in the
application audit log.
Owner grants, tenant lifecycle and entitlement changes, integration
disconnects, Stripe subscription changes, and restore/delete operations require
step-up authentication. A successful password and MFA check opens a ten-minute
privileged window and writes a separate application audit event.

## Backup And Restore

Application Owners can open **Updates & backups** in the application control
plane to create, download, delete, and stage managed database snapshots. A
staged restore is applied before SQLite opens on the next Node.js process
restart. The application validates database integrity and migration
compatibility and creates a `signify-creator-pre-restore-*.db` safety copy first.

On Hostinger, stage the restore, restart the Node.js application from the
hosting panel, then verify `/api/ready`, tenant login, and an Application Owner
login. Keep `DATABASE_PATH` and `BACKUP_DIR` on persistent writable storage.
The UI does not restore uploaded media or generated banners; recover those from
the matching external filesystem snapshot when required.

Continue to run `npm run backup` on a schedule and copy backups to a separate
durable system. The in-app backup repository is operational convenience, not an
off-site disaster-recovery copy.

## Updates

The **Updates & backups** page compares the installed package version with the
latest full GitHub release from `SIGNIFY_UPDATE_REPOSITORY`. It links to the
release but does not overwrite running application code. Deploy the release to
a new versioned directory using the process above so environment files,
persistent data, rollback capability, and host process supervision remain
intact.

## Rollback

Application files can roll back to the previous release, but database migrations
are forward-only. Back up immediately before deployment. If a rollback cannot
run against the migrated schema, restore the matching pre-deployment database
and media snapshot together. Never downgrade only the database file while the
newer process is running.

## Capacity

Track database size, WAL growth, backup duration, media usage, failed jobs, and
request latency. Each tenant's combined upload and generated-banner storage is
bounded by `SIGNIFY_TENANT_MEDIA_LIMIT_MB`; aged unreferenced media is removed by
the maintenance worker after seven days.

## PostgreSQL acceptance boundary

The PostgreSQL schema and migration runner are transition tools, not the current
web runtime authority. Run `npm run postgres:test` with a dedicated
`TEST_DATABASE_URL` to prove clean migrations, idempotency, and core constraints
against the target provider. Run `npm run postgres:migrate` only with an
intentionally configured `DATABASE_URL`. Both commands enforce production TLS,
use bounded connection timeouts, and serialize migration writers with an
advisory lock. Do not retire SQLite backups or select PostgreSQL for web traffic
until repository conversion and imported-data isolation tests are complete.

## Billing reconciliation

The worker queues `billing.reconcile` at startup and hourly. It retrieves each
Stripe-backed tenant subscription, repairs local plan/status/period drift,
records `billing_synced_at`, clears or stores a bounded provider error, and
audits changed projections. Application Owners can queue the same durable job
from **Integrations > Stripe > Reconcile subscriptions**. Failed batches use the
normal exponential retry and dead-letter controls. Webhooks remain the primary
low-latency path; reconciliation covers missed or delayed events.

## Tenant data lifecycle

Application Owners can create a redacted JSON export from a tenant record. The
export includes tenant-owned product data but excludes password hashes, session
and one-time token material, integration credentials, and raw job payloads.

Scheduling deletion requires the exact tenant slug, immediately suspends the
tenant, revokes its non-owner sessions, and creates a durable `tenant.delete`
job after `SIGNIFY_TENANT_DELETION_GRACE_DAYS`. Cancellation is available until
purging begins. The worker deletes tenant database records in one transaction,
removes local or S3 tenant media, cleans users with no remaining membership or
Application Owner role, and preserves the deletion request plus application
audit history. A media failure retries safely after database deletion.
