ALTER TABLE signature_campaigns
  ADD COLUMN overlay_json TEXT NOT NULL DEFAULT '{}';
