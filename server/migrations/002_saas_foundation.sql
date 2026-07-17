CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO organizations(id,name,slug,settings_json)
SELECT
  'org-default',
  COALESCE(json_extract(options_json,'$.companyName'),'Signify Workspace'),
  'default-workspace',
  json_object(
    'publicUrl', COALESCE(public_url,''),
    'assetBaseUrl', COALESCE(json_extract(options_json,'$.assetBaseUrl'),public_url,''),
    'mediaBaseUrl', COALESCE(json_extract(options_json,'$.mediaBaseUrl'),public_url,'')
  )
FROM install_profiles
WHERE id='signature-install'
ON CONFLICT(id) DO NOTHING;

INSERT INTO organizations(id,name,slug)
SELECT 'org-default','Signify Workspace','default-workspace'
WHERE NOT EXISTS (SELECT 1 FROM organizations);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id,user_id)
) STRICT;

INSERT INTO organization_memberships(organization_id,user_id,role,status)
SELECT 'org-default',id,role,status FROM signature_users
WHERE 1=1
ON CONFLICT(organization_id,user_id) DO NOTHING;

ALTER TABLE signature_templates ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
UPDATE signature_templates SET organization_id='org-default' WHERE organization_id IS NULL;
CREATE INDEX IF NOT EXISTS signature_templates_organization ON signature_templates(organization_id,name);

ALTER TABLE signature_sessions ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
UPDATE signature_sessions SET organization_id='org-default' WHERE organization_id IS NULL;

CREATE TABLE IF NOT EXISTS organization_subscriptions (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'beta' CHECK (plan IN ('beta','starter','team','business')),
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled')),
  seats INTEGER NOT NULL DEFAULT 10 CHECK (seats > 0),
  trial_ends_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  current_period_end TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO organization_subscriptions(organization_id,plan,status,seats,trial_ends_at)
SELECT id,'beta','trialing',10,strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days') FROM organizations
WHERE 1=1
ON CONFLICT(organization_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX IF NOT EXISTS audit_logs_organization_created ON audit_logs(organization_id,created_at DESC);
