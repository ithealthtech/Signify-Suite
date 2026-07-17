ALTER TABLE signature_users ADD COLUMN email_verified_at TEXT;
UPDATE signature_users SET email_verified_at=COALESCE(email_verified_at,created_at);

ALTER TABLE signature_sessions ADD COLUMN csrf_token_hash TEXT;
ALTER TABLE signature_sessions ADD COLUMN created_ip TEXT;
ALTER TABLE signature_sessions ADD COLUMN user_agent TEXT;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX IF NOT EXISTS email_verification_tokens_user ON email_verification_tokens(user_id,expires_at);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens(user_id,expires_at);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id,email)
) STRICT;
CREATE INDEX IF NOT EXISTS organization_invitations_expires ON organization_invitations(expires_at);
