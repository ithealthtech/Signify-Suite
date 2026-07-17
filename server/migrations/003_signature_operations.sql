CREATE TABLE IF NOT EXISTS signature_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX IF NOT EXISTS signature_campaigns_organization_dates ON signature_campaigns(organization_id,start_date,end_date);

CREATE TABLE IF NOT EXISTS signature_tracking_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES signature_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  last_clicked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (organization_id,user_id,kind,destination_url)
) STRICT;
CREATE INDEX IF NOT EXISTS signature_tracking_links_organization ON signature_tracking_links(organization_id,clicks DESC);

CREATE TABLE IF NOT EXISTS department_signature_defaults (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  template_id TEXT NOT NULL,
  accent_color TEXT NOT NULL DEFAULT '#2563eb',
  updated_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (organization_id,department)
) STRICT;

CREATE TABLE IF NOT EXISTS directory_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'microsoft365',
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed')),
  users_seen INTEGER NOT NULL DEFAULT 0,
  users_added INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_by TEXT REFERENCES signature_users(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS directory_sync_runs_organization ON directory_sync_runs(organization_id,started_at DESC);
