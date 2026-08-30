-- utradebot schema — account sale escrow
-- Applied idempotently by ensureTables() at boot

CREATE TABLE IF NOT EXISTS utrade_trades (
  id SERIAL PRIMARY KEY,
  seller_telegram_id BIGINT NOT NULL,
  buyer_telegram_id BIGINT,
  phone TEXT,                       -- E.164, nullable until seller shares
  phone_enc TEXT,                   -- fallback encrypted phone if needed
  session_encrypted TEXT NOT NULL,  -- StringSession AES-256-GCM (base64 iv+tag+cipher)
  status TEXT NOT NULL,             -- PENDING_SESSION, SELLER_REMOVED, AWAITING_PAYMENT, PHONE_SHARED, AWAITING_CODE, AWAITING_BUYER_LOGIN, COMPLETED, FAILED, CANCELLED
  buyer_code_hash TEXT,             -- Telegram phoneCodeHash for buyer login attempt (optional)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,           -- auto-cancel after 24h if not completed
  meta JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS utrade_events (
  id SERIAL PRIMARY KEY,
  trade_id INTEGER REFERENCES utrade_trades(id) ON DELETE CASCADE,
  actor_telegram_id BIGINT,
  event TEXT NOT NULL,
  meta JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_utrade_trades_seller ON utrade_trades(seller_telegram_id);
CREATE INDEX IF NOT EXISTS idx_utrade_trades_buyer ON utrade_trades(buyer_telegram_id);
CREATE INDEX IF NOT EXISTS idx_utrade_trades_status ON utrade_trades(status);
