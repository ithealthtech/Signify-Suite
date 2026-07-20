ALTER TABLE organization_subscriptions ADD COLUMN billing_synced_at TEXT;
ALTER TABLE organization_subscriptions ADD COLUMN billing_error TEXT NOT NULL DEFAULT '';
