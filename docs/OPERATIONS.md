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
  and average latency without tenant or user data.
- Application logs are JSON. Alert on `server.start_failed`, `request.error`,
  repeated HTTP 500 responses, failed provider verification, and jobs that
  exhaust their attempts.

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
The authenticator secret is encrypted with `SIGNIFY_CREDENTIAL_ENCRYPTION_KEY`;
recovery codes are stored only as hashes and are consumed once. Enrollment and
disablement revoke the owner's other sessions and create application audit
records. Run `npm run credentials:rotate` while the application is stopped to
rotate both provider credentials and MFA secrets in one database transaction.

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
