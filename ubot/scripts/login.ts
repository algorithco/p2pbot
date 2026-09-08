/**
 * Interactive login to generate StringSession for ubot.
 * Usage: npm run login
 * Will prompt phone -> code -> 2FA if needed -> prints encrypted session.
 * Handles Telegram's new flows: App (777000), SMS, Email, and QR fallback.
 *
 * Requires API_ID, API_HASH in env or .env
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from '../src/config';
import { encryptSession, saveEncryptedSession } from '../src/sessionManager';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function syncEnvFile(enc: string): void {
  let fd: number | null = null;
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    // Open once and read+write through the same fd — avoids read-then-reopen TOCTOU race
    fd = fs.openSync(envPath, 'r+');
    let content = fs.readFileSync(fd, 'utf8');
    const hasKey = /^UBOT_SESSION_STRING=.*$/m.test(content);
    if (hasKey) {
      content = content.replace(/^UBOT_SESSION_STRING=.*$/m, `UBOT_SESSION_STRING=${enc}`);
    } else {
      if (!content.endsWith('\n')) content += '\n';
      content += `UBOT_SESSION_STRING=${enc}\n`;
    }
    fs.writeSync(fd, content, 0, 'utf8');
    fs.ftruncateSync(fd, Buffer.byteLength(content, 'utf8'));
    console.log(`✔ Auto-updated .env UBOT_SESSION_STRING (${enc.slice(0, 12)}...${enc.slice(-12)})`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`⚠ .env not found — skip auto-update. Add manually: UBOT_SESSION_STRING=${enc.slice(0, 16)}...`);
    } else {
      console.warn('⚠ Could not auto-update .env:', (e as Error).message);
      console.log(`Add manually: UBOT_SESSION_STRING=${enc}`);
    }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    console.error('Set API_ID and API_HASH in ubot/.env (get at https://my.telegram.org)');
    process.exit(1);
  }

  const phone = config.phone || (await ask('Phone (E.164, e.g. +998776520524): '));
  if (!phone) {
    console.error('Phone required');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    connectionRetries: 5,
    deviceModel: config.deviceModel,
    systemVersion: config.systemVersion,
    appVersion: config.appVersion,
    langCode: 'en',
    systemLangCode: 'en-US',
    useWSS: false,
  });

  console.log(`\nAPI_ID=${config.apiId}  phone=${phone.slice(0, 4)}**** device=${config.deviceModel}/${config.systemVersion}`);
  console.log('┌─ MUHIM: Kod telefon SMS emas, balki TELEGRAM ICHIGA keladi! ─┐');
  console.log('│ 1) Agar akkaunt boshqa joyda aktiv bo\'lsa, kod 777000 (Telegram) chatiga keladi │');
  console.log('│    → Telegram app → Qidiruv → "Telegram" (777000, ko\'k tasdiq) → code: 12345      │');
  console.log('│ 2) Agar hech qanday aktiv sessiya yo\'q bo\'lsa, SMS keladi (60-120s kuting)       │');
  console.log('│ 3) Email ulangan bo\'lsa, nextType=Email bo\'lishi mumkin → pochta inbox tekshiring │');
  console.log('│ 4) 18.02.2023 dan beri third-party app SMS ololmaydi — faqat official app oladi     │');
  console.log('│ 5) Kod kelmasa: 60-120s kuting, keyin "resend" deb yozing → call/email fallback      │');
  console.log('└──────────────────────────────────────────────────────────────────────┘\n');

  await client.start({
    phoneNumber: async () => phone,
    password: async () => config.twoFaPassword || (await ask('2FA password (if enabled, else Enter): ')),
    phoneCode: async (isCodeViaApp?: boolean) => {
      if (isCodeViaApp) {
        console.log('\n📱 Kod TELEGRAM APP (777000) ga yuborildi — SMS kutmang!');
        console.log('   → Telegram app → "Telegram" (777000) chatini oching → 5-6 raqamli kodni kiriting');
        console.log('   → Agar pochta ulangan bo\'lsa, inbox ham tekshiring (Spam papkasigacha)');
      } else {
        console.log('\n📱 Kod SMS orqali yuborildi — telefon SMS inbox tekshiring (60-120s)');
      }
      console.log('   Agar 60-120s da kelmasa "resend" deb yozing → keyingi usul (call/email) sinanadi.\n');
      const c = await ask('Login code (Telegram 777000 / SMS / Email) — 5-6 digits (or type "resend" to request again): ');
      if (c.toLowerCase() === 'resend') {
        console.log('→ Resend so\'raldi — Telegram keyingi usulni (call/email) sinaydi...');
        return '';
      }
      return c.replace(/\s+/g, '');
    },
    emailAddress: async () => {
      console.log('\n📧 Telegram email verification so\'radi (login email). Rasmiy app da ham shu email ko\'rinadi.');
      const email = await ask('Email address (pochta manzilingiz, masalan gmail): ');
      return email;
    },
    emailVerification: async (opts?: unknown) => {
      const o = opts as { emailPattern?: string; codeLength?: number } | undefined;
      if (o?.emailPattern) console.log(`   Email pattern: ${o.emailPattern}, code length: ${o.codeLength ?? 6}`);
      console.log('   → Pochta inbox (Spam papkasi ham) tekshiring — Telegram dan 6-8 raqamli kod');
      const ec = await ask('Email code (pochtadan kod): ');
      return { code: ec.replace(/\s+/g, '') };
    },
    onError: (err) => {
      console.error('Login error:', (err as Error).message || err);
      const msg = String((err as Error).message || '');
      if (msg.includes('FLOOD_WAIT')) {
        const sec = msg.match(/\d+/)?.[0];
        console.error(`→ FloodWait ${sec || ''}s: Telegram limit — ${sec ? sec + 's kuting' : 'biroz kuting'} va qayta urining. 5 urinish/24h limit!`);
      }
      if (msg.includes('PHONE_NUMBER_INVALID')) console.error('→ Phone format must be +998... (E.164, no spaces/dashes)');
      if (msg.includes('PHONE_NUMBER_UNOCCUPIED')) console.error('→ Phone not registered — official Telegram app da avval ro\'yxatdan o\'ting.');
      if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) console.error('→ Kod noto\'g\'ri yoki eskirgan — 777000 da yangisini kuting, resend qiling.');
      if (msg.includes('SESSION_PASSWORD_NEEDED')) console.error('→ 2FA keyin email ham so\'ralishi mumkin — emailCode kiriting.');
      if (msg.includes('EMAIL_NOT_SETUP') || msg.includes('EMAIL_CODE')) console.error('→ Pochtadagi kodni kiriting, Spam papkasini ham tekshiring.');
      if (msg.includes('AUTH_RESTART') || msg.includes('SEND_CODE_UNAVAILABLE')) console.error('→ Kod yuborib bo\'lmaydi — QR login sinab ko\'ring: npm run login:qr (isCodeViaApp muammosi)');
    },
  });

  console.log('✔ Logged in!');
  try {
    const me = await client.getMe();
    console.log(`  as: ${(me as unknown as { username?: string })?.username || (me as unknown as { firstName?: string })?.firstName || 'unknown'} id=${(me as unknown as { id?: number })?.id}`);
  } catch {}
  // warmup to ensure session propagates to Active Sessions
  try {
    const iter = (client as unknown as { iterDialogs: (p: unknown) => AsyncIterable<unknown> }).iterDialogs({ limit: 5 });
    let c = 0;
    for await (const _ of iter) {
      c++;
      if (c >= 1) break;
    }
    await new Promise((r) => setTimeout(r, 800));
  } catch {}
  const session = (client.session as StringSession).save() as unknown as string;
  console.log('\nStringSession (plain, keep secret):');
  console.log(session);
  console.log('\nEncrypted (for .env UBOT_SESSION_STRING):');
  const enc = encryptSession(session);
  console.log(enc);

  saveEncryptedSession(session);
  console.log('✔ Saved to sessions/ubot.session.enc (600)');
  syncEnvFile(enc);
  console.log('\nℹ .env UBOT_SESSION_STRING avtomatik yangilandi. Docker bo\'lsa: docker compose restart ubot');

  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
