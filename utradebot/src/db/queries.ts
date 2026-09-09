import { Pool } from 'pg';
import { config } from '../config';
import logger from '../logger';
import * as fs from 'fs';
import * as path from 'path';

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function ensureTables(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(sql);
  } else {
    // Fallback inline (for dist without schema.sql copy)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS utrade_trades (
        id SERIAL PRIMARY KEY,
        seller_telegram_id BIGINT NOT NULL,
        buyer_telegram_id BIGINT,
        phone TEXT,
        phone_enc TEXT,
        session_encrypted TEXT NOT NULL,
        status TEXT NOT NULL,
        buyer_code_hash TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
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
    `);
  }
  logger.info('utradebot: ensured tables');
}

export async function createTrade(params: {
  sellerTelegramId: number;
  sessionEncrypted: string;
  phone?: string | null;
  status?: string;
  buyerTelegramId?: number | null;
}): Promise<{ id: number; status: string }> {
  const res = await pool.query(
    `INSERT INTO utrade_trades (seller_telegram_id, buyer_telegram_id, phone, session_encrypted, status, expires_at, meta)
     VALUES ($1,$2,$3,$4,$5, now() + interval '24 hours', '{}'::jsonb) RETURNING id, status`,
    [
      params.sellerTelegramId,
      params.buyerTelegramId || null,
      params.phone || null,
      params.sessionEncrypted,
      params.status || 'SELLER_REMOVED',
    ],
  );
  return res.rows[0];
}

export async function getTrade(id: number): Promise<Record<string, unknown> | null> {
  const res = await pool.query('SELECT * FROM utrade_trades WHERE id = $1 LIMIT 1', [id]);
  return res.rows[0] || null;
}

export async function getTradeBySeller(sellerId: number, statusNot?: string): Promise<Record<string, unknown> | null> {
  let q = 'SELECT * FROM utrade_trades WHERE seller_telegram_id = $1';
  const params: unknown[] = [sellerId];
  if (statusNot) {
    q += ' AND status != $2 ORDER BY id DESC LIMIT 1';
    params.push(statusNot);
  } else {
    q += ' ORDER BY id DESC LIMIT 1';
  }
  const res = await pool.query(q, params);
  return res.rows[0] || null;
}

export async function getActiveTradeForUser(telegramId: number): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `SELECT * FROM utrade_trades WHERE (seller_telegram_id = $1 OR buyer_telegram_id = $1)
     AND status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY id DESC LIMIT 1`,
    [telegramId],
  );
  return res.rows[0] || null;
}

export async function updateTradeStatus(
  id: number,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const sets: string[] = ['status = $1', 'updated_at = now()'];
  const params: unknown[] = [status];
  let idx = 2;
  for (const [k, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${k} = $${idx++}`);
  }
  if (status === 'COMPLETED') sets.push('completed_at = now()');
  params.push(id);
  await pool.query(`UPDATE utrade_trades SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

export async function setBuyer(id: number, buyerId: number): Promise<void> {
  await pool.query('UPDATE utrade_trades SET buyer_telegram_id = $1, updated_at = now() WHERE id = $2', [buyerId, id]);
}

export async function setPhone(id: number, phone: string): Promise<void> {
  await pool.query('UPDATE utrade_trades SET phone = $1, updated_at = now() WHERE id = $2', [phone, id]);
}

export async function appendEvent(
  tradeId: number,
  actorId: number | null,
  event: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  await pool.query('INSERT INTO utrade_events (trade_id, actor_telegram_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)', [
    tradeId,
    actorId,
    event,
    JSON.stringify(meta),
  ]);
}

export async function listTradesForSeller(sellerId: number, limit = 20): Promise<Record<string, unknown>[]> {
  const res = await pool.query('SELECT * FROM utrade_trades WHERE seller_telegram_id = $1 ORDER BY id DESC LIMIT $2', [
    sellerId,
    limit,
  ]);
  return res.rows;
}
