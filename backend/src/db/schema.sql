-- Canonical backend schema — mirrors src/db/queries.ts ensureTables().
-- ensureTables() is authoritative at boot; this file documents/creates the same shape.
-- Deal statuses (canonical strings): AWAITING_DEPOSIT, DEPOSIT_CONFIRMED,
-- BUYER_CONFIRMED, RELEASED, REFUNDED.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE,
  username TEXT,
  ton_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  buyer_id INTEGER,
  seller_id INTEGER,
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
  confirmations JSONB DEFAULT '{}'::jsonb
);

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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_links (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  token TEXT UNIQUE,
  expires_at TIMESTAMPTZ
);
