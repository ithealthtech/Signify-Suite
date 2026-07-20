CREATE TABLE feature_flags (
  id TEXT PRIMARY KEY,
  flag_key TEXT NOT NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX feature_flags_global_key
  ON feature_flags(flag_key) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX feature_flags_tenant_key
  ON feature_flags(organization_id,flag_key) WHERE organization_id IS NOT NULL;

CREATE TABLE support_access_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES signature_sessions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX support_access_active_session
  ON support_access_grants(session_id) WHERE status='active';
CREATE INDEX support_access_organization_expires
  ON support_access_grants(organization_id,status,expires_at);
