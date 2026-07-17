CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0 CHECK (livemode IN (0,1)),
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX IF NOT EXISTS organization_subscriptions_customer ON organization_subscriptions(stripe_customer_id);
CREATE INDEX IF NOT EXISTS organization_subscriptions_subscription ON organization_subscriptions(stripe_subscription_id);
