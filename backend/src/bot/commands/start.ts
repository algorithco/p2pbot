import { Bot } from 'grammy';

export function registerCommands(bot: Bot) {
  bot.command('start', async (ctx) => {
    await ctx.reply('Welcome to the Escrow Bot! Use /newdeal to create a deal.');
  });
}