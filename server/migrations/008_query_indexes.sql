CREATE INDEX IF NOT EXISTS organization_memberships_status
  ON organization_memberships(organization_id,status,user_id);

CREATE INDEX IF NOT EXISTS signature_sessions_organization_user
  ON signature_sessions(organization_id,user_id,expires_at);

CREATE INDEX IF NOT EXISTS signature_campaigns_active_dates
  ON signature_campaigns(organization_id,status,start_date,end_date);

CREATE INDEX IF NOT EXISTS signature_templates_creator
  ON signature_templates(organization_id,created_by);

CREATE INDEX IF NOT EXISTS organization_invitations_status
  ON organization_invitations(organization_id,accepted_at,expires_at);
