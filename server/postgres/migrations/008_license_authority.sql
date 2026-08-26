ALTER TABLE installation_licenses ADD COLUMN authority_url TEXT NOT NULL DEFAULT '';
ALTER TABLE installation_licenses ADD COLUMN last_refreshed_at TIMESTAMPTZ;
ALTER TABLE installation_licenses ADD COLUMN last_refresh_attempt_at TIMESTAMPTZ;
ALTER TABLE installation_licenses ADD COLUMN last_refresh_error TEXT NOT NULL DEFAULT '';
ALTER TABLE installation_licenses ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE installation_licenses ADD COLUMN revocation_reason TEXT NOT NULL DEFAULT '';

CREATE TABLE installation_license_revocations (
  license_id TEXT PRIMARY KEY,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL DEFAULT ''
);
