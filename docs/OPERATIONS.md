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

## Monitor

- `GET /api/live` proves the Node process can serve requests.
- `GET /api/ready` proves SQLite is reachable.
- `GET /api/metrics` reports aggregate request counts, errors, status classes,
  and average latency without tenant or user data.
- Application logs are JSON. Alert on `server.start_failed`, `request.error`,
  repeated HTTP 500 responses, failed provider verification, and jobs that
  exhaust their attempts.

## Background Jobs

Jobs are stored in `background_jobs`. The embedded worker atomically claims one
job at a time, retries transient errors with exponential backoff, and recovers
stale locks after restart. Do not edit running jobs manually. Diagnose the
stored `last_error`, correct the root cause, then set a failed job to `queued`
with `attempts=0`, `locked_at=NULL`, and `available_at` set to the current UTC
time.

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
