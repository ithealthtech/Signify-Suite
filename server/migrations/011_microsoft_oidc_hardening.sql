CREATE TABLE IF NOT EXISTS oauth_state_security (
  token_hash TEXT PRIMARY KEY REFERENCES oauth_states(token_hash) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL
) STRICT;
