ALTER TABLE organization_memberships ADD COLUMN signature_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(signature_json));

UPDATE organization_memberships
SET signature_json=(
  SELECT signature_users.signature_json
  FROM signature_users
  WHERE signature_users.id=organization_memberships.user_id
)
WHERE signature_json='{}';
