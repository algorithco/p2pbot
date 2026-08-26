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
    ctx.session = { isAdmin: config.adminTelegramIds.includes(ctx.from?.id || 0) };
    await next();
  });

  registerCommands(b);
  registerNewDeal(b);
  registerStatus(b);
  registerConfirm(b);
  registerAdminCommands(b);

  await b.api.setMyCommands([
    { command: 'start', description: 'Start the escrow bot' },
    { command: 'newdeal', description: 'Create a new escrow deal' },
    { command: 'status', description: 'Check deal status' },
    { command: 'confirm', description: 'Confirm your side of a deal' },
    { command: 'admin_release', description: 'Admin: release deal funds' },
    { command: 'admin_refund', description: 'Admin: refund deal funds' },
    { command: 'admin_set_fiat_sent', description: 'Admin: mark fiat as sent' },
  ]);

  if (config.webappUrl) {
    await b.api.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Open Escrow',
        web_app: { url: config.webappUrl },
      },
    });
  }

  bot = b;
  void b.start({
    onStart: (me) => {
      logger.info(`Bot @${me.username} started (id ${me.id})`);
    },
  });
  return bot;
}
