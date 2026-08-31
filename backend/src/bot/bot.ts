import { Bot } from 'grammy';
import { config } from '../config';
import logger from '../logger';
import { registerCommands } from './commands/start';
import { registerNewDeal } from './commands/newdeal';
import { registerStatus } from './commands/status';
import { registerConfirm } from './commands/confirm';
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
  registerNewDeal(b);
  registerStatus(b);
  registerConfirm(b);
  registerAdminCommands(b);

  // Global error handler — log but keep polling alive
  b.catch((err) => {
    logger.error('Bot error', err);
  });

  await b.api.setMyCommands([
    { command: 'start', description: '🏠 Main menu — welcome & actions' },
    { command: 'menu', description: '🏠 Open main menu' },
    { command: 'help', description: '📖 Commands guide & usage' },
    { command: 'about', description: '✨ About TonEscrow' },
    { command: 'newdeal', description: '➕ Create a new escrow deal' },
    { command: 'status', description: '📊 Check deal status by ID' },
    { command: 'confirm', description: '✅ Confirm your side of a deal' },
    { command: 'deals', description: '📋 My last deals' },
    { command: 'admin_release', description: '👑 Admin: release deal funds' },
    { command: 'admin_refund', description: '👑 Admin: refund deal funds' },
    { command: 'admin_set_fiat_sent', description: '👑 Admin: mark fiat as sent' },
  ]);

  if (config.webappUrl) {
    try {
      await b.api.setChatMenuButton({
        menu_button: {
          type: 'web_app',
          text: '🚀 Open Escrow',
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
