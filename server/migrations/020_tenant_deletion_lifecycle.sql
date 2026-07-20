CREATE TABLE tenant_deletion_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','purging','completed','canceled')),
  reason TEXT NOT NULL,
  requested_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  execute_after TEXT NOT NULL,
  canceled_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  canceled_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE UNIQUE INDEX tenant_deletion_requests_pending
  ON tenant_deletion_requests(organization_id)
  WHERE status IN ('pending','purging');

CREATE INDEX tenant_deletion_requests_status_execute
  ON tenant_deletion_requests(status,execute_after);
