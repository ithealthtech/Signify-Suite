ALTER TABLE installation_licenses ADD COLUMN authority_url TEXT NOT NULL DEFAULT '';
ALTER TABLE installation_licenses ADD COLUMN last_refreshed_at TEXT;
ALTER TABLE installation_licenses ADD COLUMN last_refresh_attempt_at TEXT;
ALTER TABLE installation_licenses ADD COLUMN last_refresh_error TEXT NOT NULL DEFAULT '';
ALTER TABLE installation_licenses ADD COLUMN revoked_at TEXT;
ALTER TABLE installation_licenses ADD COLUMN revocation_reason TEXT NOT NULL DEFAULT '';

CREATE TABLE installation_license_revocations (
  license_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reason TEXT NOT NULL DEFAULT ''
) STRICT;
