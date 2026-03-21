-- Supabase Migration: PhishSim Training Tool
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- Campaigns table
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  template TEXT NOT NULL,
  smtp_host TEXT NOT NULL DEFAULT 'internal',
  smtp_port INTEGER DEFAULT 587,
  smtp_user TEXT DEFAULT '',
  smtp_pass TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Recipients table
CREATE TABLE IF NOT EXISTS recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT DEFAULT '',
  token UUID NOT NULL DEFAULT gen_random_uuid(),
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ
);

-- Temp inbox addresses
CREATE TABLE IF NOT EXISTS temp_addresses (
  email TEXT PRIMARY KEY,
  label TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Inbox messages
CREATE TABLE IF NOT EXISTS inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "to" TEXT NOT NULL,
  "from" TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_recipients_campaign ON recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_token ON recipients(token);
CREATE INDEX IF NOT EXISTS idx_inbox_to ON inbox("to");
CREATE INDEX IF NOT EXISTS idx_inbox_received ON inbox(received_at DESC);

-- Enable Row Level Security (allow all for service role / anon with key)
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE temp_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox ENABLE ROW LEVEL SECURITY;

-- Policies: allow full access (internal tool, no user auth)
CREATE POLICY "Allow all on campaigns" ON campaigns FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on recipients" ON recipients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on temp_addresses" ON temp_addresses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on inbox" ON inbox FOR ALL USING (true) WITH CHECK (true);
