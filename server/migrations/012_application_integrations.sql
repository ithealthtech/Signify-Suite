CREATE TABLE IF NOT EXISTS application_integrations (
  provider TEXT PRIMARY KEY CHECK (provider IN ('microsoft','stripe')),
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  mode TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  encrypted_credentials TEXT,
  credential_key_id TEXT NOT NULL DEFAULT '',
  last_verified_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS application_integrations_status
  ON application_integrations(status,updated_at DESC);

CREATE TABLE IF NOT EXISTS application_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
