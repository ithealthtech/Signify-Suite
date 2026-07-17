CREATE TABLE IF NOT EXISTS oauth_states (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('microsoft')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);

CREATE INDEX IF NOT EXISTS signature_sessions_expires ON signature_sessions(expires_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires ON password_reset_tokens(expires_at);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expires ON email_verification_tokens(expires_at);
