ALTER TABLE background_jobs RENAME TO background_jobs_legacy;

CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  locked_at TEXT,
  completed_at TEXT,
  dead_lettered_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO background_jobs(
  id,organization_id,type,payload_json,status,attempts,max_attempts,
  available_at,locked_at,completed_at,dead_lettered_at,last_error,dedupe_key,
  created_at,updated_at
)
SELECT
  id,organization_id,type,payload_json,
  CASE status WHEN 'failed' THEN 'dead_lettered' ELSE status END,
  attempts,max_attempts,available_at,locked_at,completed_at,
  CASE WHEN status='failed' THEN updated_at ELSE NULL END,
  last_error,dedupe_key,created_at,updated_at
FROM background_jobs_legacy;

DROP TABLE background_jobs_legacy;

CREATE INDEX background_jobs_claim
  ON background_jobs(status,available_at,created_at);

CREATE INDEX background_jobs_organization
  ON background_jobs(organization_id,created_at DESC);
