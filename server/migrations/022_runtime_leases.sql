CREATE TABLE runtime_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_runtime_leases_expiry ON runtime_leases(expires_at);
