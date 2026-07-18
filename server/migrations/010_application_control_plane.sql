CREATE TABLE IF NOT EXISTS application_owners (
  user_id TEXT PRIMARY KEY REFERENCES signature_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  granted_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS organization_microsoft_connections (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL UNIQUE,
  tenant_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','disconnected')),
  sender_email TEXT NOT NULL DEFAULT '',
  connected_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  consented_at TEXT,
  last_verified_at TEXT,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS application_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS application_audit_created
  ON application_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS application_audit_organization
  ON application_audit_logs(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS microsoft_connection_status
  ON organization_microsoft_connections(status,updated_at DESC);

ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login';
ALTER TABLE oauth_states ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE oauth_states ADD COLUMN user_id TEXT REFERENCES signature_users(id) ON DELETE CASCADE;
