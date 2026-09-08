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
  let fd: number | null = null;
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    // Open once and read+write through the same fd — avoids read-then-reopen TOCTOU race
    fd = fs.openSync(envPath, 'r+');
    let content = fs.readFileSync(fd, 'utf8');
    const hasKey = /^UBOT_SESSION_STRING=.*$/m.test(content);
    if (hasKey) content = content.replace(/^UBOT_SESSION_STRING=.*$/m, `UBOT_SESSION_STRING=${enc}`);
    else {
      if (!content.endsWith('\n')) content += '\n';
      content += `UBOT_SESSION_STRING=${enc}\n`;
    }
    fs.writeSync(fd, content, 0, 'utf8');
    fs.ftruncateSync(fd, Buffer.byteLength(content, 'utf8'));
    console.log(`✔ Auto-updated .env UBOT_SESSION_STRING (${enc.slice(0, 12)}...${enc.slice(-12)})`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`⚠ .env not found — add manually: UBOT_SESSION_STRING=${enc.slice(0, 16)}...`);
    } else {
      console.warn('⚠ Could not auto-update .env:', (e as Error).message);
      console.log(`Add manually: UBOT_SESSION_STRING=${enc}`);
    }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
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
    console.log('\nℹ Agar "Incomplete login attempt" (to\'liq bo\'lmagan kirish) deb qolsa, demak 2FA parol kiritilmagan yoki xato.');
    console.log('  Telegram sizga 42777 emas, aynan QR skan qilingan device da 2FA hint ko\'rsatadi.\n');
    const user = await (client as unknown as {
      signInUserWithQrCode: (creds: { apiId: number; apiHash: string }, params: unknown) => Promise<unknown>;
    }).signInUserWithQrCode(
      { apiId: config.apiId, apiHash: config.apiHash },
      {
        qrCode: async (qr: { token: Buffer; expires: number }) => {
          printQrUrl(qr.token);
        },
        password: async (hint?: string) => {
          console.log(`\n🔐 2FA Cloud Password so'raldi${hint ? ` (hint: "${hint}")` : ' (hint yo\'q)'}`);
          if (hint) console.log(`   Hint: ${hint} — shu so'zga mos parolni kiriting!`);
          console.log(`   .env TWO_FA_PASSWORD=${config.twoFaPassword ? '(set)' : '(bo\'sh)'}`);
          let pwd = config.twoFaPassword;
          if (pwd) {
            console.log(`   → Avtomatik .env dagi TWO_FA_PASSWORD ishlatilmoqda...`);
            // verify if empty or wrong, still prompt
            if (!pwd) pwd = await ask('2FA password (cloud password, 777000 emas): ');
          } else {
            pwd = await ask('2FA password (Telegram → Settings → Privacy → Two-Step Verification → password): ');
          }
          if (!pwd) {
            console.warn('   ⚠ Parol bo\'sh — Incomplete bo\'lib qoladi! Qayta urinib ko\'ring.');
          }
          return pwd;
        },
        onError: async (err: Error) => {
          const msg = String(err.message || err);
          console.error('QR error:', msg);
          if (msg.includes('FLOOD_WAIT')) {
            const sec = msg.match(/\d+/)?.[0];
            console.error(`→ FloodWait ${sec || ''}s — ${sec ? sec + 's kuting' : 'kuting'}`);
            return true; // stop polling, let outer catch handle
          }
          if (msg.includes('AUTH_TOKEN_EXPIRED') || msg.includes('AUTH_TOKEN_INVALID') || msg.includes('AUTH_TOKEN_ALREADY_ACCEPTED')) {
            console.log('→ Token expired/invalid — yangi QR generatsiya qilinmoqda...');
            return false; // retry
          }
          if (msg.includes('SESSION_PASSWORD_NEEDED') || msg.includes('2FA') || msg.includes('PASSWORD_HASH_INVALID')) {
            console.error('→ 2FA xatosi — parol noto\'g\'ri yoki kiritilmagan. Incomplete sababi shu!');
            console.error('   → Telegram → Settings → Devices → Incomplete login attempts → Terminate, keyin qayta QR');
            return true;
          }
          if (msg.toLowerCase().includes('incomplete')) {
            console.error('→ Incomplete login — 2FA/email tasdiqlanmagan. Password/email ni to\'liq kiriting.');
            return true;
          }
          return false;
        },
      }
    );

    console.log('\n✔ QR login success! User:', (user as unknown as { username?: string })?.username || user);
    // critical: verify not incomplete (password_pending)
    let verified = false;
    try {
      const me = await client.getMe();
      console.log(`  verified as: ${(me as unknown as { username?: string })?.username || (me as unknown as { firstName?: string })?.firstName || 'unknown'}`);
      const isAuth = await client.checkAuthorization();
      console.log(`  checkAuthorization: ${isAuth} (true bo'lishi kerak, false → Incomplete)`);
      if (!isAuth) {
        console.error('\n❌ INCOMPLETE: Telegram sessiyani tasdiqlamadi (password_pending).');
        console.error('   → Sabab: 2FA parol xato yoki kiritilmadi. Telegram 42777 da "Incomplete login attempt" xabari keladi.');
        console.error('   → Yechim: Settings → Devices → Incomplete login attempts → Terminate → qayta npm run login:qr → 2FA ni to\'g\'ri kiriting.');
        throw new Error('INCOMPLETE: checkAuthorization false — 2FA password missing/invalid');
      }
      verified = true;
    } catch (e) {
      if (!verified) throw e;
      console.warn('  warmup warning:', (e as Error).message);
    }
    // warmup to ensure Active Sessions propagation only if verified
    try {
      const iter = (client as unknown as { iterDialogs: (p: unknown) => AsyncIterable<unknown> }).iterDialogs({ limit: 5 });
      let c = 0;
      for await (const _ of iter) {
        c++;
        if (c >= 1) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
      console.log('  warmup done — sessiya Active Sessions ga propagatsiya qilindi');
      // final check via account.GetAuthorizations to see if really listed
      try {
        const { Api } = await import('teleproto');
        const auths = (await client.invoke(new Api.account.GetAuthorizations())) as unknown as {
          authorizations: Array<{ hash: unknown; deviceModel: string; appName: string; passwordPending?: boolean; unconfirmed?: boolean }>;
        };
        const pending = auths.authorizations.filter((a) => (a as unknown as { passwordPending?: boolean }).passwordPending);
        if (pending.length) {
          console.warn(`  ⚠ Hali ${pending.length} ta Incomplete sessiya bor (password_pending). Ularni terminate qiling.`);
        } else {
          console.log(`  ✓ Active Sessions da ${auths.authorizations.length} ta sessiya, hammasi tasdiqlangan.`);
        }
      } catch {}
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
