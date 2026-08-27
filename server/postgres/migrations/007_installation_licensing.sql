CREATE TABLE installation_licenses (
  id TEXT PRIMARY KEY CHECK (id='primary'),
  license_id TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  edition TEXT NOT NULL CHECK (edition IN ('enterprise')),
  signed_token TEXT NOT NULL,
  features_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  max_tenants INTEGER NOT NULL CHECK (max_tenants>=1),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  grace_ends_at TIMESTAMPTZ NOT NULL,
  activated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
