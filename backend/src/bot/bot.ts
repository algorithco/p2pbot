import { Bot } from 'grammy';
import { config } from '../config';
import logger from '../logger';
import { registerCommands } from './commands/start';
import { registerAdminCommands } from './commands/admin';

let bot: Bot | null = null;

export function getBot(): Bot | null {
  return bot;
}

/** Build, wire and start the singleton bot. Resolves once polling has begun. */
export async function startBot(): Promise<Bot> {
  if (!config.botToken) throw new Error('BOT_TOKEN is not configured');
  if (bot) return bot;

  const b = new Bot(config.botToken);

  // Middleware: flag admins on every update.
  b.use(async (ctx, next) => {
    (ctx as any).session = { isAdmin: config.adminTelegramIds.includes(ctx.from?.id || 0) };
    await next();
  });

  registerCommands(b);
  registerAdminCommands(b);

  // Global error handler — log but keep polling alive
  b.catch((err) => {
    logger.error('Bot error', err);
  });

  await b.api.setMyCommands([
    { command: 'start', description: 'Ilovani ochish' },
    { command: 'reyting', description: 'Oylik savdo reytingi' },
    { command: 'admin_release', description: 'Admin: pulni chiqarish' },
    { command: 'admin_refund', description: 'Admin: pulni qaytarish' },
    { command: 'disputes', description: 'Admin: nizolar' },
  ]);

  if (config.webappUrl) {
    try {
      await b.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: 'Ilovani ochish',
          web_app: { url: config.webappUrl },
        },
      });
    } catch (err) {
      logger.warn('setChatMenuButton failed — check WEBAPP_URL is https and bot has rights', err);
    }
  }

  bot = b;
  void b.start({
    onStart: (me) => {
      logger.info(`Bot @${me.username} started (id ${me.id})`);
    },
  });
  return bot;
}
