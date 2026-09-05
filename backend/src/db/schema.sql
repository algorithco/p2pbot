-- Canonical backend schema — mirrors src/db/queries.ts ensureTables().
-- ensureTables() is authoritative at boot; this file documents/creates the same shape.
-- Deal statuses (canonical webapp-first): AWAITING_DEPOSIT, DEPOSIT_CONFIRMED,
-- ITEM_SENT, BUYER_CONFIRMED (legacy), RELEASED, REFUNDED.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  username TEXT,
  ton_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  buyer_id BIGINT,
  seller_id BIGINT,
  buyer_telegram_id BIGINT,
  seller_telegram_id BIGINT,
  asset TEXT,
  amount NUMERIC,
  fee_bps INT,
  fee_amount NUMERIC,
  status TEXT,
  contract_address TEXT,
  payment_address TEXT,
  terms TEXT,
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  tx_hash TEXT,
  resolved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  confirmations JSONB DEFAULT '{}'::jsonb,
  payout_address TEXT,
  chat_key TEXT,
  chat_key_created_at TIMESTAMPTZ,
  deal_type TEXT DEFAULT 'P2P',
  channel_username TEXT,
  channel_id TEXT,
  channel_title TEXT,
  channel_snapshot JSONB DEFAULT '{}'::jsonb,
  channel_verified BOOLEAN DEFAULT false,
  channel_verified_at TIMESTAMPTZ,
  escrow_holder_id BIGINT,
  transfer_to_escrow_at TIMESTAMPTZ,
  transfer_to_buyer_at TIMESTAMPTZ,
  pending_new_owner TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_type ON deals(deal_type);
CREATE INDEX IF NOT EXISTS idx_deals_channel_id ON deals(channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT,
  message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  sender_telegram_id BIGINT,
  content TEXT,
  encrypted_content TEXT,
  iv TEXT,
  auth_tag TEXT,
  is_encrypted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_links (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  token TEXT UNIQUE,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deal_join_requests (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  token TEXT,
  requester_telegram_id BIGINT,
  requester_username TEXT,
  requester_first_name TEXT,
  requester_photo_url TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT,
  text TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_deal_created ON messages(deal_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_deal_links_expires ON deal_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_join_requests_deal_token ON deal_join_requests(deal_id, token);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON deal_join_requests(status);
