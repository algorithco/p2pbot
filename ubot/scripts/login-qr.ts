/**
 * QR login — no SMS/phone code needed. Scan QR with your Telegram app.
 *
 * Usage: npm run login:qr
 * Steps:
 *   1. Run script — it prints a QR code in terminal + tg://login?token=...
 *   2. On your phone, open Telegram → Settings → Devices → Link Desktop Device → Scan QR
 *   3. Approve. Script will save StringSession (encrypted).
 *
 * This bypasses SMS (Telegram's new anti-spam often blocks in-app codes for API logins).
 * See https://github.com/gram-js/gramjs/issues/834 — QR still works.
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
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

function syncEnvFile(enc: string): void {
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) {
      console.log(`⚠ .env not found at ${envPath} — add manually: UBOT_SESSION_STRING=${enc.slice(0, 16)}...`);
      return;
    }
    let content = fs.readFileSync(envPath, 'utf8');
    const hasKey = /^UBOT_SESSION_STRING=.*$/m.test(content);
    if (hasKey) content = content.replace(/^UBOT_SESSION_STRING=.*$/m, `UBOT_SESSION_STRING=${enc}`);
    else {
      if (!content.endsWith('\n')) content += '\n';
      content += `UBOT_SESSION_STRING=${enc}\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    console.log(`✔ Auto-updated .env UBOT_SESSION_STRING (${enc.slice(0, 12)}...${enc.slice(-12)})`);
  } catch (e) {
    console.warn('⚠ Could not auto-update .env:', (e as Error).message);
    console.log(`Add manually: UBOT_SESSION_STRING=${enc}`);
  }
}

// Minimal QR terminal renderer (avoids extra dep); also prints URL for online QR generator
function printQrUrl(token: Buffer) {
  const b64url = token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `tg://login?token=${b64url}`;
  console.log('\n=== QR ===');
  console.log('1) On phone: Telegram → Settings → Devices → Link Desktop Device → Scan QR');
  console.log('   (Sozlamalar → Qurilmalar → Ish stolini ulash → QR skan)');
  console.log('2) URL (if terminal QR not visible, paste into https://api.qrserver.com/v1/create-qr-code/?data=):');
  console.log(url);
  console.log('3) Or generate QR image: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url));
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const qr = require('qrcode-terminal');
    qr.generate(url, { small: true });
  } catch {
    console.log('(Install qrcode-terminal for inline QR: npm i qrcode-terminal)');
  }
  console.log('Waiting for scan (30s per QR, auto-refreshes)...\n');
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    console.error('Set API_ID / API_HASH in ubot/.env (https://my.telegram.org)');
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
  await client.connect();
  console.log(`API_ID=${config.apiId} device=${config.deviceModel}/${config.systemVersion} — starting QR login (no phone needed)...`);
  console.log('Eslatma: 42777 emas, aynan Telegram → Sozlamalar → Qurilmalar → Link Desktop Device dan skan qiling.\n');

  try {
    const user = await (client as unknown as {
      signInUserWithQrCode: (creds: { apiId: number; apiHash: string }, params: unknown) => Promise<unknown>;
    }).signInUserWithQrCode(
      { apiId: config.apiId, apiHash: config.apiHash },
      {
        qrCode: async (qr: { token: Buffer; expires: number }) => {
          printQrUrl(qr.token);
        },
        password: async (hint?: string) => {
          console.log(`\n2FA required${hint ? ` (hint: ${hint})` : ''}`);
          const pwd = config.twoFaPassword || (await ask('2FA password: '));
          return pwd;
        },
        emailAddress: async () => {
          console.log('\n📧 Telegram email verification so\'radi (login email).');
          const email = await ask('Email address: ');
          return email;
        },
        emailVerification: async (opts?: unknown) => {
          const o = opts as { emailPattern?: string; codeLength?: number } | undefined;
          if (o?.emailPattern) console.log(`   Email pattern: ${o.emailPattern}, code length: ${o.codeLength ?? 6}`);
          console.log('   → Pochta inbox + Spam ham tekshiring');
          const ec = await ask('Email code (pochtadan): ');
          return { code: ec.replace(/\s+/g, '') };
        },
        onError: async (err: Error) => {
          console.error('QR error:', err.message || err);
          if (String(err.message).includes('FLOOD_WAIT')) {
            const sec = String(err.message).match(/\d+/)?.[0];
            console.error(`→ FloodWait ${sec || ''}s — ${sec ? sec + 's kuting' : 'kuting'}`);
            return true;
          }
          if (String(err.message).includes('AUTH_TOKEN_EXPIRED') || String(err.message).includes('AUTH_TOKEN_INVALID')) {
            console.log('→ Token expired — yangi QR generatsiya qilinmoqda...');
            return false;
          }
          return false;
        },
      }
    );

    console.log('\n✔ QR login success! User:', (user as unknown as { username?: string })?.username || user);
    // warmup to ensure Active Sessions propagation
    try {
      const me = await client.getMe();
      console.log(`  verified as: ${(me as unknown as { username?: string })?.username || (me as unknown as { firstName?: string })?.firstName || 'unknown'}`);
      const iter = (client as unknown as { iterDialogs: (p: unknown) => AsyncIterable<unknown> }).iterDialogs({ limit: 5 });
      let c = 0;
      for await (const _ of iter) {
        c++;
        if (c >= 1) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
      console.log('  warmup done — sessiya Active Sessions ga propagatsiya qilindi');
    } catch (e) {
      console.warn('  warmup warning:', (e as Error).message);
    }
    const session = (client.session as StringSession).save() as unknown as string;
    console.log('\nStringSession (plain, keep secret):');
    console.log(session);
    const enc = encryptSession(session);
    console.log('\nEncrypted (for UBOT_SESSION_STRING):');
    console.log(enc);

    saveEncryptedSession(session);
    console.log('✔ Saved to sessions/ubot.session.enc (600)');
    syncEnvFile(enc);
    console.log('\nℹ .env avtomatik yangilandi. Docker: docker compose restart ubot');
    console.log('  Tekshirish: curl.exe http://localhost:3002/health/verified -H "x-api-key: ..."');

    await client.disconnect();
  } catch (e) {
    console.error('\nQR login failed:', (e as Error).message || e);
    const m = String((e as Error).message || '');
    if (m.includes('EMAIL')) console.error('→ Email verify xatosi — pochta inbox/Spam ni tekshiring, emailAddress/emailCode kiriting');
    console.error('Try again: npm run login:qr');
    try { await client.disconnect(); } catch {}
    process.exit(1);
  }
}

main();
