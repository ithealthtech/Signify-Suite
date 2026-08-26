ALTER TABLE installation_licenses
  ADD COLUMN max_users_per_tenant INTEGER NOT NULL DEFAULT 100000
  CHECK (max_users_per_tenant>=10 AND max_users_per_tenant<=100000);
