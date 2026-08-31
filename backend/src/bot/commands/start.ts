import { Bot } from 'grammy';
import { config } from '../../config';
import { db } from '../../db/queries';
import { getDealById } from '../../services/dealService';
import {
  mainMenuKeyboard,
  helpKeyboard,
  createDealKeyboard,
  backToMenuKeyboard,
} from '../keyboards';

// ── helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function displayName(ctx: any): string {
  const u = ctx.from;
  if (!u) return 'there';
  const n = (u.first_name || u.username || 'there').trim();
  return escapeHtml(n.slice(0, 32));
}

function feeLabel(): string {
  const bps = config.feeBps ?? 100;
  const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
  return `${pct}% (${bps} bps)`;
}

// ── message builders (HTML) ─────────────────────────────────────────────────

function welcomeMessage(name: string, isAdmin: boolean): string {
  const fee = feeLabel();
  const network = escapeHtml(config.tonNetwork || 'mainnet');
  const adminHint = isAdmin ? `\n\n👑 <b>Admin detected</b> — you have access to <code>/admin_release</code>, <code>/admin_refund</code> & <code>/admin_set_fiat_sent</code>.` : '';
  return [
    `🛡️ <b>TonEscrow — Secure P2P Escrow on TON</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    `Hi, <b>${name}</b> 👋`,
    ``,
    `Welcome to <b>the safest way</b> to trade <b>TON</b> & <b>USDT</b> on Telegram.`,
    `Funds stay locked until <b>both parties confirm</b> — no scams, no chasing.`,
    ``,
    `┌ <b>✨ Why TonEscrow?</b>`,
    `│  🔒 <b>Escrow-protected</b> — on-chain or custodial`,
    `│  ⚡️ <b>Instant links</b> — one-tap join for counterparty`,
    `│  💬 <b>Per-deal chat</b> + real-time notifications`,
    `│  💎 <b>TON & USDT (Jetton)</b> supported`,
    `│  🛡️ <b>Transparent fee: ${fee}</b>`,
    `│  ⏱ <b>24h deadline</b> with auto-resolve`,
    `└  🌐 Network: <code>${network}</code>`,
    ``,
    `📖 <b>How it works — 4 steps</b>`,
    `  <b>1️⃣ Create</b> → <code>/newdeal @seller 10 TON</code>`,
    `  <b>2️⃣ Invite</b> → share the join link`,
    `  <b>3️⃣ Deposit</b> → pay to escrow address`,
    `  <b>4️⃣ Confirm</b> → both tap <code>/confirm &lt;id&gt;</code> → auto-release`,
    ``,
    `👇 <b>Choose an action below to get started:</b>`,
    adminHint,
  ]
    .join('\n')
    .trim();
}

function helpMessage(): string {
  return [
    `📖 <b>TonEscrow — Commands Guide</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `🚀 <b>Getting Started</b>`,
    `  <code>/start</code> — open main menu (this screen)`,
    `  <code>/menu</code> — same as /start`,
    `  <code>/help</code> — show this guide`,
    `  <code>/about</code> — about the bot`,
    ``,
    `➕ <b>Creating Deals</b>`,
    `  <code>/newdeal &lt;@seller|seller_id&gt; &lt;amount&gt; &lt;TON|USDT&gt; [terms]</code>`,
    `  <i>Example:</i> <code>/newdeal @alice 25 TON fast delivery</code>`,
    `  <i>Example:</i> <code>/newdeal 123456789 100 USDT no refund after ship</code>`,
    `  → Bot creates deal, gives you a <b>join link</b> to send to counterparty.`,
    ``,
    `📊 <b>Tracking</b>`,
    `  <code>/status &lt;deal_id&gt;</code> — full timeline & status`,
    `  <i>Tap “My Deals”</i> — see your last 5 deals instantly`,
    ``,
    `✅ <b>Confirmations</b>`,
    `  <code>/confirm &lt;deal_id&gt;</code> — confirm your side (only in DEPOSIT_CONFIRMED)`,
    `  → When <b>both parties</b> confirm → funds <b>auto-release</b>`,
    ``,
    `👑 <b>Admin Only</b>`,
    `  <code>/admin_release &lt;id&gt;</code> — force release`,
    `  <code>/admin_refund &lt;id&gt;</code> — force refund`,
    `  <code>/admin_set_fiat_sent &lt;id&gt;</code> — mark fiat sent`,
    ``,
    `💡 <b>Tip:</b> Use the <b>Open Escrow App</b> button for a visual deal manager — same deals, nicer UI!`,
  ].join('\n');
}

function howItWorksMessage(): string {
  return [
    `ℹ️ <b>How TonEscrow Works</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Think of us as a <b>neutral vault</b> between buyer & seller.`,
    ``,
    ` <b>1️⃣ Buyer creates deal</b>`,
    `    └ <code>/newdeal @seller 10 TON</code>`,
    `    └ Bot stores deal as <code>AWAITING_DEPOSIT</code>`,
    `    └ Generates a <b>one-time join link</b>`,
    ``,
    ` <b>2️⃣ Counterparty joins</b>`,
    `    └ Opens join link (or via Mini App)`,
    `    └ Bot assigns role (buyer/seller) automatically`,
    ``,
    ` <b>3️⃣ Deposit</b>`,
    `    └ Buyer pays to <b>escrow address</b> shown on deal card`,
    `    └ On-chain mode: contract holds funds · Off-chain: custodial wallet`,
    `    └ Status → <code>DEPOSIT_CONFIRMED</code>`,
    ``,
    ` <b>4️⃣ Mutual confirmation</b>`,
    `    └ Both run <code>/confirm &lt;id&gt;</code> (or tap in App)`,
    `    └ First confirm → <code>BUYER_CONFIRMED</code> (waiting for other)`,
    `    └ Second confirm → <code>RELEASED</code> 🎉 — funds released`,
    ``,
    ` <b>🛡️ Safety nets</b>`,
    `    • 24h deadline — unresolved deals can be refunded by admin`,
    `    • Every state change is logged (<code>tx_hash</code>, <code>confirmations</code>)`,
    `    • Admin never holds your keys — signer service is isolated`,
    ``,
    ` <b>💎 Supported assets</b>: <code>TON</code> (9 decimals) & <code>USDT</code> (Jetton, 6 decimals)`,
    ` <b>💰 Fee</b>: ${feeLabel()} — shown upfront, no hidden charges`,
  ].join('\n');
}

function supportMessage(): string {
  const webapp = config.webappUrl ? `\n  🌐 Mini App: ${escapeHtml(config.webappUrl)}` : '';
  return [
    `🛟 <b>Support & Help</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `Need a hand? We’ve got you:`,
    ``,
    `  📖 <b>Quick help</b> → tap <b>Commands</b> for all commands`,
    `  ℹ️ <b>How it works</b> → visual step-by-step flow`,
    `  ➕ <b>Create Deal</b> → start a new escrow in 10s`,
    `  📋 <b>My Deals</b> → track everything you’re part of`,
    webapp,
    ``,
    `  🐛 <b>Found a bug?</b> — contact the admins via Telegram`,
    `  👑 <b>Admins</b>: <code>${(config.adminTelegramIds || []).join(', ') || 'not configured'}</code>`,
    ``,
    `  ⚠️ <b>Safety tip:</b> Always double-check the escrow address before sending funds. The bot will <b>never DM you first</b> asking for keys.`,
  ]
    .filter(Boolean)
    .join('\n');
}

function aboutMessage(): string {
  return [
    `✨ <b>About TonEscrow</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    ` <b>TonEscrow</b> is a Telegram-native <b>P2P escrow</b> built on <b>TON blockchain</b>.`,
    ` We make peer-to-peer trades as safe as an exchange — without giving up custody.`,
    ``,
    ` <b>🏗 Built with</b>`,
    `  • grammY bot + Express REST (backend :3000)`,
    `  • Tact smart contract (<code>Escrow.tact</code>) + W5 signer`,
    `  • Telegram Mini App (webapp :8080) — same deals, beautiful UI`,
    `  • Postgres + TON watcher (auto-confirms deposits)`,
    ``,
    ` <b>🔐 Trust model</b>`,
    `  • Non-custodial when on-chain — contract enforces rules`,
    `  • Fee address & logic are transparent`,
    `  • Every deal has an immutable audit trail`,
    ``,
    ` <b>📦 Version</b>: 1.0 · <b>Mode</b>: ${config.requireOnchain ? 'on-chain ⛓' : 'off-chain (custodial) 🗄'}`,
    ` <b>🌐 Network</b>: <code>${escapeHtml(config.tonNetwork)}</code>`,
    ``,
    ` <i>Crafted for traders who value speed & safety. Share the bot to grow the network!</i> 🤝`,
  ].join('\n');
}

function createHelpMessage(): string {
  return [
    `➕ <b>Create a New Escrow Deal</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    ` <b>Syntax</b>:`,
    ` <code>/newdeal &lt;@seller|seller_id&gt; &lt;amount&gt; &lt;TON|USDT&gt; [terms]</code>`,
    ``,
    ` <b>Examples</b>:`,
    `  <code>/newdeal @alice 2.5 TON fast deal, no fee on refund</code>`,
    `  <code>/newdeal 987654321 50 USDT ship within 24h</code>`,
    `  <code>/newdeal @bob 0.5 TON</code>`,
    ``,
    ` <b>What happens next?</b>`,
    `  1. Bot creates <b>Deal #ID</b> (status: AWAITING_DEPOSIT)`,
    `  2. You get a <b>join link</b> — send it to counterparty`,
    `  3. Once they join, pay to the <b>escrow address</b> shown`,
    `  4. Both run <code>/confirm &lt;id&gt;</code> → funds release`,
    ``,
    ` 💡 <b>Pro tip</b>: Tap <b>Open Escrow App</b> for a form-based creator — no syntax to memorize!`,
  ].join('\n');
}

// ── registration ─────────────────────────────────────────────────────────────

export function registerCommands(bot: Bot) {
  // /start — rich welcome + deal invite deep-link with approval flow
  bot.command('start', async (ctx) => {
    const payload = (ctx.match as string)?.trim() || '';
    const name = displayName(ctx);
    const isAdmin = Boolean((ctx as any).session?.isAdmin);
    const webappUrl = config.webappUrl || undefined;

    // Handle bot deep-link: join_<dealId>_<token>  (e.g., https://t.me/uzsavdochibot?start=join_123_550e8400-e29b-41d4-a716-446655440000)
    if (payload && payload.startsWith('join_')) {
      const rest = payload.slice(5); // remove "join_"
      const sep = rest.indexOf('_');
      if (sep === -1) {
        await ctx.reply(`❌ <b>Invalid invite link</b> — malformed payload.`, { parse_mode: 'HTML' });
      } else {
        const dealIdStr = rest.slice(0, sep);
        const token = rest.slice(sep + 1);
        const dealId = Number(dealIdStr);
        const requesterId = ctx.from?.id;
        const requesterUsername = ctx.from?.username || null;
        const requesterFirstName = ctx.from?.first_name || null;
        if (!Number.isInteger(dealId) || !token || !requesterId) {
          await ctx.reply(`❌ <b>Invalid invite link</b>.`, { parse_mode: 'HTML' });
        } else {
          try {
            const { getDealById, getDealLink, createJoinRequest } = await import('../../services/dealService');
            const deal = await getDealById(dealId);
            if (!deal) {
              await ctx.reply(`❌ <b>Deal #${escapeHtml(dealIdStr)} not found.</b> The link may be expired or invalid.`, { parse_mode: 'HTML' });
            } else if (Number(deal.buyer_telegram_id) === requesterId || Number(deal.seller_telegram_id) === requesterId) {
              await ctx.reply(`ℹ️ You are already a party to <b>Deal #${deal.id}</b> — <code>${escapeHtml(String(deal.status))}</code>.`, { parse_mode: 'HTML' });
            } else if (deal.buyer_telegram_id != null && deal.seller_telegram_id != null) {
              await ctx.reply(`❌ <b>Deal #${deal.id} is already full.</b> Both buyer and seller are set.`, { parse_mode: 'HTML' });
            } else {
              const link = await getDealLink(token);
              if (!link || Number(link.deal_id) !== dealId) {
                await ctx.reply(`❌ <b>Invalid or expired invite link</b> for Deal #${deal.id}.`, { parse_mode: 'HTML' });
              } else if (new Date(link.expires_at).getTime() <= Date.now()) {
                await ctx.reply(`⏰ <b>Invite link expired</b> for Deal #${deal.id}. Ask the creator to generate a new one.`, { parse_mode: 'HTML' });
              } else {
                // Determine creator (existing party) and missing role
                const creatorId = (deal.buyer_telegram_id != null ? Number(deal.buyer_telegram_id) : Number(deal.seller_telegram_id));
                const missingRole = deal.buyer_telegram_id == null ? 'buyer' : 'seller';
                if (!creatorId) {
                  await ctx.reply(`❌ <b>Deal #${deal.id} has no creator</b> — contact support.`, { parse_mode: 'HTML' });
                } else {
                  // Try to get requester photo for creator approval card
                  let photoUrl: string | null = null;
                  let photoFileId: string | null = null;
                  try {
                    const photos = await ctx.api.getUserProfilePhotos(requesterId, { limit: 1 });
                    if (photos.total_count > 0 && photos.photos[0]?.[0]) {
                      const fileId = (photos.photos[0][0] as unknown as { file_id: string }).file_id;
                      photoFileId = fileId;
                      // We will send via file_id directly, no need for URL
                    }
                  } catch {}
                  const joinReq = await createJoinRequest({
                    dealId,
                    token,
                    requesterTelegramId: requesterId,
                    requesterUsername,
                    requesterFirstName,
                    requesterPhotoUrl: photoUrl,
                  });
                  // Notify requester
                  await ctx.reply(
                    [
                      `✅ <b>Join request sent!</b>`,
                      ``,
                      `You requested to join <b>Deal #${deal.id}</b> as <b>${escapeHtml(missingRole)}</b>.`,
                      `  💎 <code>${escapeHtml(String(deal.amount))} ${escapeHtml(String(deal.asset))}</code>`,
                      `  📝 <i>${escapeHtml(String(deal.terms || '').slice(0, 80))}</i>`,
                      ``,
                      `The creator has been asked to approve you (showing your profile). You will be notified once approved.`,
                    ].join('\n'),
                    { parse_mode: 'HTML' }
                  );
                  // Notify creator with approval card (photo + username)
                  try {
                    const { InlineKeyboard } = await import('grammy');
                    const creatorName = requesterFirstName ? escapeHtml(requesterFirstName) : escapeHtml(String(requesterId));
                    const creatorUsername = requesterUsername ? `@${escapeHtml(requesterUsername)}` : `ID ${requesterId}`;
                    const caption = [
                      `🔔 <b>Join request for Deal #${deal.id}</b>`,
                      `━━━━━━━━━━━━━━━━━━━━━━━`,
                      ``,
                      `👤 <b>${creatorName}</b> ${creatorUsername}`,
                      `🆔 <code>${requesterId}</code> wants to join as <b>${escapeHtml(missingRole)}</b>.`,
                      ``,
                      `  💎 <code>${escapeHtml(String(deal.amount))} ${escapeHtml(String(deal.asset))}</code>`,
                      `  📝 <i>${escapeHtml(String(deal.terms || '').slice(0, 80))}</i>`,
                      ``,
                      `Do you approve this connection? Deal starts after your confirmation.`,
                    ].join('\n');
                    const kb = new InlineKeyboard()
                      .text('✅ Approve', `approve_join:${joinReq.id}`)
                      .text('❌ Decline', `reject_join:${joinReq.id}`);
                    if (photoFileId) {
                      await ctx.api.sendPhoto(creatorId, photoFileId, { caption, parse_mode: 'HTML', reply_markup: kb });
                    } else {
                      await ctx.api.sendMessage(creatorId, caption, { parse_mode: 'HTML', reply_markup: kb });
                    }
                  } catch (e) {
                    // Fallback: if we cannot message creator (blocked), tell requester
                    await ctx.reply(`⚠️ Could not notify the creator (ID ${creatorId}) — they may have blocked the bot. Ask them to start the bot first.`, { parse_mode: 'HTML' });
                  }
                  return; // Do not show welcome after handling join
                }
              }
            }
          } catch (e) {
            await ctx.reply(`⚠️ <b>Join failed:</b> ${escapeHtml(String((e as Error).message || e))}`, { parse_mode: 'HTML' });
          }
        }
      }
      // For join_ payload we already replied; still show welcome? We returned early on success, but for errors we fall through to welcome
    }

    await ctx.reply(welcomeMessage(name, isAdmin), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(webappUrl),
      link_preview_options: { is_disabled: true } as any,
    });
  });

  // Handle approval callbacks
  bot.callbackQuery(/^approve_join:(\d+)$/, async (ctx) => {
    const requestId = Number(ctx.match?.[1]);
    const approverId = ctx.from?.id;
    if (!requestId || !approverId) return ctx.answerCallbackQuery({ text: 'Invalid request' });
    try {
      const { approveJoinRequest, getJoinRequestById, getDealById } = await import('../../services/dealService');
      const req = await getJoinRequestById(requestId);
      if (!req) return ctx.answerCallbackQuery({ text: 'Request not found' });
      const deal = await getDealById(req.deal_id);
      if (!deal) return ctx.answerCallbackQuery({ text: 'Deal not found' });
      await approveJoinRequest(requestId, approverId);
      await ctx.answerCallbackQuery({ text: 'Approved — deal started!' });
      const role = req.requester_telegram_id ? 'buyer/seller' : 'counterparty';
      // Edit creator's message
      try {
        await ctx.editMessageCaption({
          caption: `✅ <b>Approved!</b> Deal #${deal.id} — @${escapeHtml(req.requester_username || String(req.requester_telegram_id))} joined as ${escapeHtml(String(req.requester_telegram_id === deal.buyer_telegram_id ? 'buyer' : 'seller'))}. Deal is now active.`,
          parse_mode: 'HTML',
        });
      } catch {
        await ctx.editMessageText(`✅ <b>Approved!</b> Deal #${deal.id} — @${escapeHtml(req.requester_username || String(req.requester_telegram_id))} joined.`, { parse_mode: 'HTML' });
      }
      // Notify requester
      try {
        await ctx.api.sendMessage(req.requester_telegram_id, `✅ <b>Your join request for Deal #${deal.id} was approved!</b>\n\nDeal is now active — you can chat and deposit.`, { parse_mode: 'HTML' });
      } catch {}
      // Notify both parties deal started
      const otherId = Number(req.requester_telegram_id);
      try {
        await ctx.api.sendMessage(otherId, `🎉 <b>Deal #${deal.id} started!</b>\nYou are now connected as ${deal.buyer_telegram_id == otherId ? 'buyer' : 'seller'}. Use /status ${deal.id} or the Mini App.`, { parse_mode: 'HTML' });
      } catch {}
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message || 'Approve failed'), show_alert: true });
    }
  });

  bot.callbackQuery(/^reject_join:(\d+)$/, async (ctx) => {
    const requestId = Number(ctx.match?.[1]);
    const approverId = ctx.from?.id;
    if (!requestId || !approverId) return ctx.answerCallbackQuery({ text: 'Invalid request' });
    try {
      const { rejectJoinRequest, getJoinRequestById } = await import('../../services/dealService');
      const req = await getJoinRequestById(requestId);
      if (!req) return ctx.answerCallbackQuery({ text: 'Request not found' });
      await rejectJoinRequest(requestId, approverId);
      await ctx.answerCallbackQuery({ text: 'Declined' });
      try {
        await ctx.editMessageCaption({ caption: `❌ <b>Declined</b> — join request for Deal #${req.deal_id} from @${escapeHtml(req.requester_username || String(req.requester_telegram_id))} was declined.`, parse_mode: 'HTML' });
      } catch {
        await ctx.editMessageText(`❌ <b>Declined</b> — join request for Deal #${req.deal_id} declined.`, { parse_mode: 'HTML' });
      }
      try {
        await ctx.api.sendMessage(req.requester_telegram_id, `❌ <b>Your join request for Deal #${req.deal_id} was declined</b> by the creator.`, { parse_mode: 'HTML' });
      } catch {}
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message || 'Reject failed'), show_alert: true });
    }
  });

  // aliases
  bot.command('menu', async (ctx) => {
    const name = displayName(ctx);
    const isAdmin = Boolean((ctx as any).session?.isAdmin);
    await ctx.reply(welcomeMessage(name, isAdmin), {
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(config.webappUrl || undefined),
      link_preview_options: { is_disabled: true } as any,
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(helpMessage(), {
      parse_mode: 'HTML',
      reply_markup: helpKeyboard(config.webappUrl || undefined),
      link_preview_options: { is_disabled: true } as any,
    });
  });

  bot.command('about', async (ctx) => {
    await ctx.reply(aboutMessage(), {
      parse_mode: 'HTML',
      reply_markup: backToMenuKeyboard(config.webappUrl || undefined),
      link_preview_options: { is_disabled: true } as any,
    });
  });

  // /deals alias — quick access to My Deals without tapping the menu
  bot.command('deals', async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid) return ctx.reply('Could not identify you.');
    try {
      const res = await db.query(
        'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 5',
        [uid]
      );
      const rows = res.rows as any[];
      if (rows.length === 0) {
        await ctx.reply(
          `📋 <b>My Deals</b> — nothing yet\n━━━━━━━━━━━━━━━━━━━━━━━\n\nYou’re not part of any deal yet.\nTap <b>Create Deal</b> to start!`,
          { parse_mode: 'HTML', reply_markup: createDealKeyboard(config.webappUrl || undefined) }
        );
        return;
      }
      const statusEmoji: Record<string, string> = {
        AWAITING_DEPOSIT: '⏳',
        DEPOSIT_CONFIRMED: '💰',
        BUYER_CONFIRMED: '✅',
        RELEASED: '🎉',
        REFUNDED: '↩️',
      };
      const lines = rows.map((d) => {
        const emoji = statusEmoji[d.status] || '•';
        return `${emoji} <b>#${d.id}</b> — <code>${escapeHtml(String(d.amount))} ${escapeHtml(String(d.asset))}</code> · <code>${escapeHtml(String(d.status))}</code>`;
      });
      const text = [`📋 <b>My Deals — last ${rows.length}</b>`, `━━━━━━━━━━━━━━━━━━━━━━━`, ``, ...lines, ``, `Use <code>/status &lt;id&gt;</code> for details.`].join('\n');
      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard();
      rows.forEach((d, i) => {
        kb.text(`#${d.id}`, `deal_status:${d.id}`);
        if (i % 2 === 1 || i === rows.length - 1) kb.row();
      });
      if (config.webappUrl) kb.webApp('🚀 Open App', config.webappUrl).row();
      kb.text('🏠 Main Menu', 'menu:home');
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      await ctx.reply('⚠️ Could not load deals — try again later.', { parse_mode: 'HTML' });
    }
  });

  // ── callback query handlers — menu navigation ───────────────────────────

  bot.callbackQuery('menu:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    const name = displayName(ctx);
    const isAdmin = Boolean((ctx as any).session?.isAdmin);
    try {
      await ctx.editMessageText(welcomeMessage(name, isAdmin), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(config.webappUrl || undefined),
        link_preview_options: { is_disabled: true } as any,
      });
    } catch {
      await ctx.reply(welcomeMessage(name, isAdmin), {
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(config.webappUrl || undefined),
      });
    }
  });

  bot.callbackQuery('menu:create', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(createHelpMessage(), {
        parse_mode: 'HTML',
        reply_markup: createDealKeyboard(config.webappUrl || undefined),
        link_preview_options: { is_disabled: true } as any,
      });
    } catch {
      await ctx.reply(createHelpMessage(), {
        parse_mode: 'HTML',
        reply_markup: createDealKeyboard(config.webappUrl || undefined),
      });
    }
  });

  bot.callbackQuery('menu:create_ton', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'TON selected — check the example below 👇' });
    const text = [
      `💎 <b>Create TON Deal — Quick Start</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Copy & edit this template:`,
      `<code>/newdeal @seller_username 1.5 TON terms: ship in 24h</code>`,
      ``,
      `Or with Telegram ID:`,
      `<code>/newdeal 123456789 0.25 TON no terms</code>`,
      ``,
      `After sending, you’ll get a <b>join link</b> + <b>payment address</b>. Share the link with your counterparty!`,
    ].join('\n');
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: createDealKeyboard(config.webappUrl || undefined),
      });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: createDealKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:create_usdt', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'USDT selected — check the example below 👇' });
    const text = [
      `💵 <b>Create USDT Deal — Quick Start</b>`,
      `━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Copy & edit this template:`,
      `<code>/newdeal @seller_username 25 USDT fast escrow</code>`,
      ``,
      `Or with Telegram ID:`,
      `<code>/newdeal 123456789 100 USDT</code>`,
      ``,
      `USDT uses <b>6 decimals</b> (Jetton). Same flow: join link → deposit → mutual confirm → release.`,
    ].join('\n');
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: createDealKeyboard(config.webappUrl || undefined),
      });
    } catch {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: createDealKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:how', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(howItWorksMessage(), {
        parse_mode: 'HTML',
        reply_markup: backToMenuKeyboard(config.webappUrl || undefined, [
          { label: '➕ Create Deal', data: 'menu:create' },
          { label: '📖 Commands', data: 'menu:help' },
        ]),
        link_preview_options: { is_disabled: true } as any,
      });
    } catch {
      await ctx.reply(howItWorksMessage(), { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(helpMessage(), {
        parse_mode: 'HTML',
        reply_markup: helpKeyboard(config.webappUrl || undefined),
      });
    } catch {
      await ctx.reply(helpMessage(), { parse_mode: 'HTML', reply_markup: helpKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:support', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(supportMessage(), {
        parse_mode: 'HTML',
        reply_markup: backToMenuKeyboard(config.webappUrl || undefined, [
          { label: '📖 Commands', data: 'menu:help' },
          { label: 'ℹ️ How it Works', data: 'menu:how' },
        ]),
      });
    } catch {
      await ctx.reply(supportMessage(), { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:about', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(aboutMessage(), {
        parse_mode: 'HTML',
        reply_markup: backToMenuKeyboard(config.webappUrl || undefined),
      });
    } catch {
      await ctx.reply(aboutMessage(), { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(config.webappUrl || undefined) });
    }
  });

  bot.callbackQuery('menu:deals', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Fetching your deals…' });
    const uid = ctx.from?.id;
    if (!uid) {
      await ctx.reply('Could not identify you. Try again from Telegram.');
      return;
    }
    try {
      const res = await db.query(
        'SELECT * FROM deals WHERE buyer_telegram_id = $1 OR seller_telegram_id = $1 ORDER BY id DESC LIMIT 5',
        [uid]
      );
      const rows = res.rows as any[];
      if (rows.length === 0) {
        const text = [
          `📋 <b>My Deals</b> — nothing yet`,
          `━━━━━━━━━━━━━━━━━━━━━━━`,
          ``,
          `You’re not part of any deal yet.`,
          `Tap <b>Create Deal</b> to start your first escrow!`,
          ``,
          `<i>Tip: deals appear here after you create one or join via a link.</i>`,
        ].join('\n');
        try {
          await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: createDealKeyboard(config.webappUrl || undefined),
          });
        } catch {
          await ctx.reply(text, { parse_mode: 'HTML', reply_markup: createDealKeyboard(config.webappUrl || undefined) });
        }
        return;
      }

      const statusEmoji: Record<string, string> = {
        AWAITING_DEPOSIT: '⏳',
        DEPOSIT_CONFIRMED: '💰',
        BUYER_CONFIRMED: '✅',
        RELEASED: '🎉',
        REFUNDED: '↩️',
      };
      const lines = rows.map((d) => {
        const emoji = statusEmoji[d.status] || '•';
        const asset = escapeHtml(String(d.asset || ''));
        const amount = escapeHtml(String(d.amount ?? ''));
        const role = Number(d.buyer_telegram_id) === uid ? 'buyer' : Number(d.seller_telegram_id) === uid ? 'seller' : 'party';
        return `${emoji} <b>#${d.id}</b> — <code>${amount} ${asset}</code> · <i>${role}</i> · <code>${escapeHtml(String(d.status))}</code>`;
      });

      const text = [
        `📋 <b>My Deals — last ${rows.length}</b>`,
        `━━━━━━━━━━━━━━━━━━━━━━━`,
        ``,
        ...lines,
        ``,
        `Use <code>/status &lt;id&gt;</code> for full details, or open in the App.`,
        config.webappUrl ? `\n🌐 <a href="${escapeHtml(config.webappUrl)}">Open Escrow App</a>` : '',
      ].join('\n');

      // Build a keyboard with quick-status buttons for each deal
      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard();
      rows.forEach((d, i) => {
        kb.text(`#${d.id} status`, `deal_status:${d.id}`);
        if (i % 2 === 1 || i === rows.length - 1) kb.row();
      });
      if (config.webappUrl) kb.webApp('🚀 Open App', config.webappUrl).row();
      kb.text('➕ Create Deal', 'menu:create').text('⬅️ Back', 'menu:home');

      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err) {
      console.error('menu:deals failed', err);
      await ctx.reply(
        `⚠️ Could not load deals right now. Try <code>/status &lt;id&gt;</code> or check the Mini App.`,
        { parse_mode: 'HTML', reply_markup: backToMenuKeyboard(config.webappUrl || undefined) }
      );
    }
  });

  // Generic deal_status refresh (used by dealCardKeyboard + My Deals)
  bot.callbackQuery(/^deal_status:(\d+)$/, async (ctx) => {
    const dealId = ctx.match?.[1] || (ctx.callbackQuery.data || '').split(':')[1];
    await ctx.answerCallbackQuery({ text: `Loading #${dealId}…` });
    const idNum = Number(dealId);
    if (!Number.isInteger(idNum)) {
      await ctx.reply('Invalid deal id.');
      return;
    }
    try {
      const deal = await getDealById(idNum);
      if (!deal) {
        await ctx.reply(`Deal <b>#${escapeHtml(String(dealId))}</b> not found.`, { parse_mode: 'HTML' });
        return;
      }
      const conf: Record<string, boolean> = (deal as any).confirmations || {};
      const statusEmoji: Record<string, string> = {
        AWAITING_DEPOSIT: '⏳ Awaiting deposit',
        DEPOSIT_CONFIRMED: '💰 Deposit confirmed — awaiting confirmations',
        BUYER_CONFIRMED: '✅ One side confirmed — waiting for counterparty',
        RELEASED: '🎉 Released',
        REFUNDED: '↩️ Refunded',
      };
      const text = [
        `📊 <b>Deal #${deal.id}</b> — ${statusEmoji[deal.status] || escapeHtml(String(deal.status))}`,
        `━━━━━━━━━━━━━━━━━━━━━━━`,
        `  💎 Asset: <code>${escapeHtml(String(deal.asset))} ${escapeHtml(String(deal.amount))}</code>`,
        `  💰 Fee: <code>${escapeHtml(String((deal as any).fee_bps ?? config.feeBps))} bps</code>`,
        deal.contract_address ? `  ⛓ Contract: <code>${escapeHtml(String(deal.contract_address).slice(0, 28))}…</code>` : `  🗄 Mode: off-chain`,
        deal.payment_address && !deal.contract_address ? `  💳 Pay to: <code>${escapeHtml(String(deal.payment_address).slice(0, 28))}…</code>` : '',
        `  👤 Buyer: <code>${escapeHtml(String(deal.buyer_telegram_id ?? '—'))}</code> ${conf.buyer ? '✅' : '⏳'}`,
        `  👤 Seller: <code>${escapeHtml(String(deal.seller_telegram_id ?? '—'))}</code> ${conf.seller ? '✅' : '⏳'}`,
        `  📅 Created: <code>${escapeHtml(new Date(deal.created_at).toISOString().slice(0, 16).replace('T', ' '))} UTC</code>`,
        deal.deadline ? `  ⏰ Deadline: <code>${escapeHtml(new Date(deal.deadline).toISOString().slice(0, 16).replace('T', ' '))} UTC</code>` : '',
        deal.terms ? `  📝 Terms: <i>${escapeHtml(String(deal.terms).slice(0, 120))}</i>` : '',
        deal.tx_hash ? `  🔗 TX: <code>${escapeHtml(String(deal.tx_hash).slice(0, 32))}…</code>` : '',
        ``,
        `Use <code>/confirm ${deal.id}</code> to confirm, or open in App for full actions.`,
      ]
        .filter(Boolean)
        .join('\n');

      const { InlineKeyboard } = await import('grammy');
      const kb = new InlineKeyboard()
        .text('🔄 Refresh', `deal_status:${deal.id}`)
        .text('📋 My Deals', 'menu:deals')
        .row();
      if (config.webappUrl) {
        const sep = config.webappUrl.includes('?') ? '&' : '?';
        kb.webApp('🚀 Open in App', `${config.webappUrl}${sep}deal=${deal.id}`).row();
      }
      kb.text('⬅️ Back to Menu', 'menu:home');

      // Try to edit the message that held the button; fallback to new message
      try {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
      } catch {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
      }
    } catch (err) {
      console.error('deal_status callback failed', err);
      await ctx.reply('⚠️ Could not load deal status right now. Try <code>/status ' + escapeHtml(String(dealId)) + '</code>', {
        parse_mode: 'HTML',
      });
    }
  });
}
