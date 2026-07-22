DROP INDEX IF EXISTS application_integrations_status;

CREATE TABLE application_integrations_next (
  provider TEXT PRIMARY KEY CHECK (provider IN ('microsoft','stripe','github')),
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

INSERT INTO application_integrations_next SELECT * FROM application_integrations;
DROP TABLE application_integrations;
ALTER TABLE application_integrations_next RENAME TO application_integrations;
CREATE INDEX application_integrations_status ON application_integrations(status,updated_at DESC);
