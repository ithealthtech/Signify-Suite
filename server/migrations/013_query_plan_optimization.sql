CREATE INDEX IF NOT EXISTS signature_users_email_nocase
  ON signature_users(lower(email));

CREATE INDEX IF NOT EXISTS organization_memberships_user_status_created
  ON organization_memberships(user_id,status,created_at,organization_id);

CREATE INDEX IF NOT EXISTS organization_memberships_workflow
  ON organization_memberships(
    organization_id,
    json_extract(signature_json,'$.workflowStatus'),
    json_extract(signature_json,'$.submittedAt')
  );

CREATE INDEX IF NOT EXISTS organizations_created
  ON organizations(created_at DESC);

CREATE INDEX IF NOT EXISTS application_owners_status_user
  ON application_owners(status,user_id);
