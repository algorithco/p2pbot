import { Pool } from 'pg';
import { config } from '../config';

const pool = new Pool({ connectionString: config.databaseUrl });

export const db = pool;

export async function connectDB() {
  await pool.query('SELECT 1');
  console.log('Connected to PostgreSQL');
  await ensureTables();
  console.log('Ensured DB tables');
}

/** Idempotently add a column to a table (e.g. ensureColumn('deals', 'tx_hash TEXT')). */
async function ensureColumn(table: string, columnDef: string) {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDef}`);
}

export async function ensureTables() {
  await pool.query(`
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
      created_at TIMESTAMPTZ DEFAULT now()
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
  `);

  // Canonical extra deal columns — boot stays idempotent on pre-existing installs.
  await ensureColumn('deals', 'tx_hash TEXT');
  await ensureColumn('deals', 'resolved_at TIMESTAMPTZ');
  await ensureColumn('deals', 'updated_at TIMESTAMPTZ');
  await ensureColumn("deals", "confirmations JSONB DEFAULT '{}'::jsonb");
  // Encrypted seller-buyer channel: per-deal symmetric key (base64 32B encrypted at rest if ENCRYPTION_KEY set)
  await ensureColumn('deals', 'chat_key TEXT');
  await ensureColumn('deals', 'chat_key_created_at TIMESTAMPTZ');

  // Messages E2E: ciphertext-only at rest, plus legacy content for migration
  await ensureColumn('messages', 'encrypted_content TEXT');
  await ensureColumn('messages', 'iv TEXT');
  await ensureColumn('messages', 'auth_tag TEXT');
  await ensureColumn('messages', 'is_encrypted BOOLEAN DEFAULT false');

  // Indexes for chat polling
  await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_deal_created ON messages(deal_id, created_at ASC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_deal_links_expires ON deal_links(expires_at)');

  // Telegram IDs exceed 32-bit range — widen legacy INTEGER id columns to BIGINT.
  await pool.query('ALTER TABLE deals ALTER COLUMN buyer_id TYPE BIGINT');
  await pool.query('ALTER TABLE deals ALTER COLUMN seller_id TYPE BIGINT');
}

export async function saveNotification(chatId: number, message: string) {
  const res = await pool.query('INSERT INTO notifications (chat_id, message) VALUES ($1,$2) RETURNING *', [chatId, message]);
  return res.rows[0];
}

export async function listNotifications(limit = 100) {
  const res = await pool.query('SELECT * FROM notifications ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function getUserByTelegramId(telegramId: number) {
  const res = await pool.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [telegramId]);
  return res.rows[0] || null;
}

export async function createUserIfNotExists(telegramId: number, username?: string) {
  // Try to insert; if there's a unique constraint on telegram_id this will update the username
  const res = await pool.query(
    `INSERT INTO users (telegram_id, username) VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING *`,
    [telegramId, username || null]
  );
  return res.rows[0];
}

export async function upsertUserByTelegramId(telegramId: number, username?: string) {
  return createUserIfNotExists(telegramId, username);
}

export async function listDeals(limit = 100) {
  const res = await pool.query('SELECT * FROM deals ORDER BY id DESC LIMIT $1', [limit]);
  return res.rows;
}

export async function getDealLinks(dealId: number) {
  const res = await pool.query('SELECT * FROM deal_links WHERE deal_id = $1 ORDER BY id DESC', [dealId]);
  return res.rows;
}

export async function getDealLink(token: string) {
  const res = await pool.query('SELECT * FROM deal_links WHERE token = $1 LIMIT 1', [token]);
  return res.rows[0] || null;
}
