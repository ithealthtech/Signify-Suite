CREATE TABLE outlook_addin_deployments (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX outlook_addin_deployments_enabled
  ON outlook_addin_deployments(enabled,updated_at DESC);
