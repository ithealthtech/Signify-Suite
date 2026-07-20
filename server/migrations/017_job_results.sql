ALTER TABLE background_jobs ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(result_json));

ALTER TABLE directory_sync_runs RENAME TO directory_sync_runs_legacy;

CREATE TABLE directory_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'microsoft365',
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  users_seen INTEGER NOT NULL DEFAULT 0,
  users_added INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
) STRICT;

INSERT INTO directory_sync_runs(
  id,organization_id,provider,status,users_seen,users_added,error_message,
  started_by,started_at,completed_at
)
SELECT
  id,organization_id,provider,status,users_seen,users_added,error_message,
  started_by,started_at,completed_at
FROM directory_sync_runs_legacy;

DROP TABLE directory_sync_runs_legacy;

CREATE INDEX directory_sync_runs_organization
  ON directory_sync_runs(organization_id,started_at DESC);
