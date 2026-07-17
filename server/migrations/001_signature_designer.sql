CREATE TABLE IF NOT EXISTS install_profiles (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  database_provider TEXT NOT NULL DEFAULT 'sqlite',
  deployment_target TEXT NOT NULL DEFAULT 'node',
  public_url TEXT,
  options_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(options_json)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS signature_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  signature_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(signature_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS signature_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  template_json TEXT NOT NULL CHECK (json_valid(template_json)),
  created_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE IF NOT EXISTS signature_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS signature_sessions_user ON signature_sessions(user_id,expires_at);
