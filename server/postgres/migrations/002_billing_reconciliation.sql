ALTER TABLE organization_subscriptions
  ADD COLUMN billing_synced_at TIMESTAMPTZ,
  ADD COLUMN billing_error TEXT NOT NULL DEFAULT '';
