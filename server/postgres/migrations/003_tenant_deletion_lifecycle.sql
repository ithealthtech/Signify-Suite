CREATE TABLE tenant_deletion_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  organization_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','purging','completed','canceled')),
  reason TEXT NOT NULL,
  requested_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  execute_after TIMESTAMPTZ NOT NULL,
  canceled_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  canceled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX tenant_deletion_requests_pending
  ON tenant_deletion_requests(organization_id)
  WHERE status IN ('pending','purging');

CREATE INDEX tenant_deletion_requests_status_execute
  ON tenant_deletion_requests(status,execute_after);
