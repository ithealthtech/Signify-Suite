CREATE TABLE outlook_addin_deployments (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX outlook_addin_deployments_enabled
  ON outlook_addin_deployments(enabled,updated_at DESC);
