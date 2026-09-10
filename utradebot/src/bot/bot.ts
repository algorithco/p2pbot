import { Bot } from 'grammy';
import { config } from '../config';
import logger from '../logger';
import { registerSellFlow } from './handlers/sellFlow';
import { registerBuyFlow } from './handlers/buyFlow';
import { registerCodeHandler } from './handlers/codeHandler';
import { mainKeyboard } from './keyboards';

let bot: Bot | null = null;

export function getBot(): Bot | null {
  return bot;
}

export async function startBot(): Promise<Bot> {
  if (!config.botToken) throw new Error('UTRADE_BOT_TOKEN is not configured');
  if (bot) return bot;

  const b = new Bot(config.botToken);

  b.use(async (ctx, next) => {
    (ctx as unknown as { isAdmin: boolean }).isAdmin = config.adminTelegramIds.includes(ctx.from?.id || 0);
    await next();
  });

  b.command('start', async (ctx) => {
    await ctx.reply(
      '🤖 **utradebot** — Telegram account sale escrow\n\n' +
        '• Seller: /sell — give StringSession or phone:+..., I kick seller sessions and hold account\n' +
        '• After buyer pays you externally, press “Payment received” — I share phone with buyer\n' +
        '• Buyer: /buy <tradeId> — bind as buyer, receive phone, send login code\n' +
        '• I verify code, log buyer in, and log out (seller session revoked)\n\n' +
        'Commands: /sell, /buy, /mytrades, /setbuyer, /setphone, /cancel',
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() },
    );
  });

  b.callbackQuery('start_sell', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('Run /sell to start selling an account.');
  });

  b.callbackQuery('my_trades', async (ctx) => {
    await ctx.answerCallbackQuery();
    // Defer to command handler
    (ctx as unknown as { match: string }).match = '';
    // Trigger mytrades via direct call is messy; just instruct
    await ctx.reply('Run /mytrades');
  });

  b.command('cancel', async (ctx) => {
    await ctx.reply('Cancelled. Use /sell or /buy <id>.');
  });

  b.command('help', async (ctx) => {
    await ctx.reply(
      'Commands:\n' +
        '/sell — sell account (send StringSession or phone:+...)\n' +
        '/setphone <id> <phone> — set phone for trade\n' +
        '/setbuyer <id> <buyerId> — bind buyer\n' +
        '/buy <id> — become buyer\n' +
        '/mytrades — list your trades\n' +
        '/cancel — cancel current step',
    );
  });

  registerSellFlow(b);
  registerBuyFlow(b);
  registerCodeHandler(b);

  b.catch((err) => {
    const msg = String((err as Error).message || err);
    // Suppress spam for placeholder token, log as warn
    if (msg.includes('401') || msg.includes('Unauthorized')) {
      logger.warn('utradebot: Telegram API 401 — check UTRADE_BOT_TOKEN (placeholder?)', msg.slice(0, 120));
    } else {
      logger.error('utradebot error', err);
    }
  });

  // Skip setMyCommands for placeholder token to avoid 401 spam
  const isPlaceholder =
    !config.botToken ||
    config.botToken.includes('123456:ABC') ||
    config.botToken.includes('change_me') ||
    config.botToken.length < 20;
  if (isPlaceholder) {
    logger.warn(
      'UTRADE_BOT_TOKEN is placeholder/invalid — bot polling disabled, HTTP API only. Set real token from @BotFather to enable Telegram.',
    );
  } else {
    try {
      await b.api.setMyCommands([
        { command: 'start', description: 'Welcome & help' },
        { command: 'sell', description: 'Sell Telegram account (StringSession or phone)' },
        { command: 'buy', description: 'Buy account: /buy <tradeId>' },
        { command: 'mytrades', description: 'List your trades' },
        { command: 'setphone', description: 'Set phone for trade' },
        { command: 'setbuyer', description: 'Bind buyer to trade' },
        { command: 'help', description: 'Show all commands' },
      ]);
    } catch (e) {
      logger.warn('setMyCommands failed (non-fatal, check token)', e);
    }
  }

  bot = b;
  if (!isPlaceholder) {
    void b.start({
      onStart: (me) => {
        logger.info(`utradebot @${me.username} started (id ${me.id})`);
      },
    });
  } else {
    logger.warn('utradebot: Telegram polling disabled due to placeholder token');
  }
  return b;
}
