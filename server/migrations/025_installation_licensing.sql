CREATE TABLE installation_licenses (
  id TEXT PRIMARY KEY CHECK (id='primary'),
  license_id TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  edition TEXT NOT NULL CHECK (edition IN ('enterprise')),
  signed_token TEXT NOT NULL,
  features_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(features_json)),
  max_tenants INTEGER NOT NULL CHECK (max_tenants>=1),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_ends_at TEXT NOT NULL,
  activated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  activated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
