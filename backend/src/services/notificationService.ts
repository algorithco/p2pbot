// src/services/notificationService.ts
import { db } from '../db/queries';
import logger from '../logger';

/** Persist a notification row and best-effort deliver it via the notify hub. */
export async function saveAndNotify(chatId: number, message: string) {
  try {
    await db.query('INSERT INTO notifications (chat_id, message) VALUES ($1,$2)', [chatId, String(message)]);
  } catch (e) {
    logger.warn('could not persist notification', e);
  }
  try {
    const notify = await import('../bot/notify');
    // Generic party notice via hub (UZBEK latin, short).
    await notify.adminDecisionToParty(
      Number(chatId),
      { id: 0, amount: 0, asset: 'TON' },
      String(message).slice(0, 200),
    );
  } catch (e) {
    logger.warn('saveAndNotify hub send failed', e);
  }
}

/** Notify admins via the notify hub; safe to call fire-and-forget. */
export async function alertAdmins(message: string) {
  try {
    const notify = await import('../bot/notify');
    await notify.unknownDepositToAdmins({
      amount: '',
      asset: '',
      address: 'admin',
      memo: String(message).slice(0, 300),
    });
  } catch (err) {
    logger.warn('alertAdmins hub send failed', err);
  }
}
