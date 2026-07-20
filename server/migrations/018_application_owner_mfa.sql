ALTER TABLE signature_sessions ADD COLUMN mfa_verified_at TEXT;

CREATE TABLE application_owner_mfa (
  user_id TEXT PRIMARY KEY REFERENCES signature_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enabled')),
  encrypted_secret TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  last_counter INTEGER NOT NULL DEFAULT -1,
  enrolled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE application_owner_mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX application_owner_mfa_recovery_user
  ON application_owner_mfa_recovery_codes(user_id,used_at);

CREATE TABLE mfa_login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TEXT NOT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX mfa_login_challenges_expiry ON mfa_login_challenges(expires_at);
