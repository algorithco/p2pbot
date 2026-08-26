// src/services/notificationService.ts
import { db } from '../db/queries';
import { getBot } from '../bot/bot';
import { config } from '../config';
import logger from '../logger';

/** Persist a notification row and best-effort deliver it via the running bot. */
export async function saveAndNotify(chatId: number, message: string) {
  await db.query(
    'INSERT INTO notifications (chat_id, message) VALUES ($1,$2)',
    [chatId, message]
  );
  const bot = getBot();
  if (bot) {
    await bot.api.sendMessage(chatId, message);
  }
}

/** Notify admins; safe to call fire-and-forget. Resolves silently without a bot. */
export async function alertAdmins(message: string) {
  const bot = getBot();
  if (!bot) return;
  const botRef = bot;
  for (const adminId of config.adminTelegramIds) {
    try {
      await botRef.api.sendMessage(adminId, `⚠️ ADMIN ALERT:\n${message}`);
    } catch (err) {
      logger.warn(`Could not notify admin ${adminId}`, err);
    }
  }
}
