CREATE TABLE install_profiles (
  id TEXT PRIMARY KEY,
  profile_name TEXT NOT NULL,
  database_provider TEXT NOT NULL DEFAULT 'postgresql',
  deployment_target TEXT NOT NULL DEFAULT 'node',
  public_url TEXT,
  options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE signature_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  signature_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX signature_users_email_nocase ON signature_users(lower(email));

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX organizations_created ON organizations(created_at DESC);

CREATE TABLE organization_memberships (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  signature_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id)
);
CREATE INDEX organization_memberships_status ON organization_memberships(organization_id,status,user_id);
CREATE INDEX organization_memberships_user_status_created ON organization_memberships(user_id,status,created_at,organization_id);
CREATE INDEX organization_memberships_workflow ON organization_memberships(organization_id,(signature_json->>'workflowStatus'),(signature_json->>'submittedAt'));

CREATE TABLE signature_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_json JSONB NOT NULL,
  created_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signature_templates_organization ON signature_templates(organization_id,name);
CREATE INDEX signature_templates_creator ON signature_templates(organization_id,created_by);

CREATE TABLE signature_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT,
  created_ip TEXT,
  user_agent TEXT,
  mfa_verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX signature_sessions_user ON signature_sessions(user_id,expires_at);
CREATE INDEX signature_sessions_expires ON signature_sessions(expires_at);
CREATE INDEX signature_sessions_organization_user ON signature_sessions(organization_id,user_id,expires_at);

CREATE TABLE organization_subscriptions (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter','team','business')),
  status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled')),
  seats INTEGER NOT NULL DEFAULT 10 CHECK (seats > 0),
  trial_ends_at TIMESTAMPTZ,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_price_id TEXT,
  current_period_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX organization_subscriptions_customer ON organization_subscriptions(stripe_customer_id);
CREATE INDEX organization_subscriptions_subscription ON organization_subscriptions(stripe_subscription_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_logs_organization_created ON audit_logs(organization_id,created_at DESC);

CREATE TABLE signature_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  start_date TIMESTAMPTZ NOT NULL,
  end_date TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  overlay_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (end_date >= start_date)
);
CREATE INDEX signature_campaigns_organization_dates ON signature_campaigns(organization_id,start_date,end_date);
CREATE INDEX signature_campaigns_active_dates ON signature_campaigns(organization_id,status,start_date,end_date);

CREATE TABLE signature_tracking_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  last_clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,user_id,kind,destination_url)
);
CREATE INDEX signature_tracking_links_organization ON signature_tracking_links(organization_id,clicks DESC);

CREATE TABLE department_signature_defaults (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES signature_templates(id) ON DELETE CASCADE,
  accent_color TEXT NOT NULL DEFAULT '#2563eb',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,department)
);

CREATE TABLE directory_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'microsoft365',
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed')),
  users_seen INTEGER NOT NULL DEFAULT 0 CHECK (users_seen >= 0),
  users_added INTEGER NOT NULL DEFAULT 0 CHECK (users_added >= 0),
  error_message TEXT,
  started_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX directory_sync_runs_organization ON directory_sync_runs(organization_id,started_at DESC);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_verification_tokens_user ON email_verification_tokens(user_id,expires_at);
CREATE INDEX email_verification_tokens_expires ON email_verification_tokens(expires_at);

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX password_reset_tokens_user ON password_reset_tokens(user_id,expires_at);
CREATE INDEX password_reset_tokens_expires ON password_reset_tokens(expires_at);

CREATE TABLE organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,email)
);
CREATE INDEX organization_invitations_expires ON organization_invitations(expires_at);
CREATE INDEX organization_invitations_status ON organization_invitations(organization_id,accepted_at,expires_at);

CREATE TABLE stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE oauth_states (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('microsoft')),
  purpose TEXT NOT NULL DEFAULT 'login',
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES signature_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX oauth_states_expires ON oauth_states(expires_at);

CREATE TABLE oauth_state_security (
  token_hash TEXT PRIMARY KEY REFERENCES oauth_states(token_hash) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL
);

CREATE TABLE application_owners (
  user_id TEXT PRIMARY KEY REFERENCES signature_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  granted_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_owners_status_user ON application_owners(status,user_id);

CREATE TABLE organization_microsoft_connections (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL UNIQUE,
  tenant_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','disconnected')),
  sender_email TEXT NOT NULL DEFAULT '',
  connected_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  consented_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX microsoft_connection_status ON organization_microsoft_connections(status,updated_at DESC);

CREATE TABLE application_audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_audit_created ON application_audit_logs(created_at DESC);
CREATE INDEX application_audit_organization ON application_audit_logs(organization_id,created_at DESC);

CREATE TABLE application_integrations (
  provider TEXT PRIMARY KEY CHECK (provider IN ('microsoft','stripe')),
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  mode TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  account_name TEXT NOT NULL DEFAULT '',
  configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_credentials TEXT,
  credential_key_id TEXT NOT NULL DEFAULT '',
  last_verified_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_integrations_status ON application_integrations(status,updated_at DESC);

CREATE TABLE application_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','dead_lettered')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX background_jobs_claim ON background_jobs(status,available_at,created_at);
CREATE INDEX background_jobs_organization ON background_jobs(organization_id,created_at DESC);

CREATE TABLE application_owner_mfa (
  user_id TEXT PRIMARY KEY REFERENCES signature_users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','enabled')),
  encrypted_secret TEXT NOT NULL,
  credential_key_id TEXT NOT NULL,
  last_counter BIGINT NOT NULL DEFAULT -1,
  enrolled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE application_owner_mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_owner_mfa_recovery_user ON application_owner_mfa_recovery_codes(user_id,used_at);

CREATE TABLE mfa_login_challenges (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at TIMESTAMPTZ NOT NULL,
  created_ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mfa_login_challenges_expiry ON mfa_login_challenges(expires_at);
