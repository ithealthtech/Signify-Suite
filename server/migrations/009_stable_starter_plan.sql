UPDATE organization_subscriptions
SET plan='starter',
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE plan='beta';
