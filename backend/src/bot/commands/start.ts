import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../../config';
import { webAppButton } from '../keyboards';

function welcomeText(): string {
  return [
    `🛡️ SafeDeal — xavfsiz savdo.`,
    `Bot pulni tovar topshirilgunga qadar ushlaydi.`,
    `Hamma ish ilovada bajariladi.`,
    `Davom etish uchun pastdagi tugmani bosing.`,
  ].join('\n');
}

function helpText(): string {
  return [
    `📖 Yordam: hamma ish ilovada.`,
    `Havola orqali qo'shiling va to'lovni ilovada qiling.`,
    `Muammo bo'lsa admin bilan bog'laning.`,
  ].join('\n');
}

function welcomeKeyboard(): InlineKeyboard {
  const base = (config.webappUrl || '').replace(/\/$/, '');
  if (base) {
    return webAppButton(base, 'Ilovani ochish').row().text('Yordam', 'help');
  }
  return new InlineKeyboard().text('Yordam', 'help');
}

export function registerCommands(bot: Bot) {
  bot.command('start', async (ctx) => {
    const payload = ((ctx.match as string) || '').trim();
    if (payload.startsWith('join_')) {
      const rest = payload.slice(5);
      const sep = rest.indexOf('_');
      if (sep !== -1) {
        const dealId = rest.slice(0, sep);
        const token = rest.slice(sep + 1);
        const base = (config.webappUrl || '').replace(/\/$/, '');
        if (dealId && token && base) {
          const joinUrl = `${base}/#/deal/${dealId}/join/${token}`;
          const kb = webAppButton(joinUrl, 'Ilovani ochish');
          await ctx.reply(`🤝 Sherik taklifini qabul qilish ilovada.\nPastdagi tugmani bosing.`, { reply_markup: kb });
        } else {
          await ctx.reply(`🤝 Sherik taklifini qabul qilish ilovada.\nIlovani oching.`);
        }
      }
    }
    await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeKeyboard() });
  });

  bot.callbackQuery('menu:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeKeyboard() });
    } catch {
      // best-effort: edit fails when the message is unchanged/deleted — reply instead.
      await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeKeyboard() });
    }
  });

  const showHelp = async (ctx: any) => {
    try {
      await ctx.answerCallbackQuery?.();
    } catch {} // best-effort: callback may already be answered/expired.
    try {
      await ctx.editMessageText?.(helpText(), { parse_mode: 'HTML' });
    } catch {
      // best-effort: uneditable message — reply instead.
      await ctx.reply(helpText(), { parse_mode: 'HTML' });
    }
  };

  bot.callbackQuery('help', async (ctx) => showHelp(ctx));
  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: 'HTML' });
  });
}
