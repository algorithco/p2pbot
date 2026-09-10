/**
 * Verbose login — shows exactly where Telegram sent the code (sms/app/call/email/firebase)
 * Usage: npx ts-node scripts/login-verbose.ts  (or npm run login:verbose)
 * Handles Email and ResendCode diagnostics for when code does not arrive via Telegram app.
 */
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto';
import { config } from '../src/config';
import { encryptSession, saveEncryptedSession } from '../src/sessionManager';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) =>
    rl.question(q, (a) => {
      rl.close();
      res(a.trim());
    }),
  );
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
    console.warn('⚠ Could not auto-update .env:', (e as Error).message);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    console.error('Set API_ID / API_HASH in ubot/.env');
    process.exit(1);
  }
  const phone = config.phone || (await ask('Phone E.164 (+998776520524): '));
  console.log(
    `\nAPI_ID=${config.apiId} API_HASH=${config.apiHash.slice(0, 6)}**** phone=${phone.slice(0, 4)}**** device=${config.deviceModel}`,
  );
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    connectionRetries: 5,
    deviceModel: config.deviceModel,
    systemVersion: config.systemVersion,
    appVersion: config.appVersion,
    langCode: 'en',
    systemLangCode: 'en-US',
  });
  await client.connect();
  console.log('Connected, calling auth.sendCode with CodeSettings{allowAppHash:true}...');

  try {
    const sent = (await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: config.apiId,
        apiHash: config.apiHash,
        settings: new Api.CodeSettings({ allowAppHash: true }),
      }),
    )) as unknown as {
      phoneCodeHash: string;
      type: { className: string; length?: number; pattern?: string };
      nextType?: { className: string };
      timeout?: number;
    };

    console.log('\n=== auth.SendCode result ===');
    console.log('phoneCodeHash:', sent.phoneCodeHash);
    console.log('type:', sent.type?.className, JSON.stringify(sent.type));
    console.log('nextType:', sent.nextType?.className ?? 'none');
    console.log('timeout:', sent.timeout ?? 'none');
    console.log('Full:', JSON.stringify(sent, null, 2));
    console.log('\n--- Interpretation (official Telegram docs https://core.telegram.org/api/auth) ---');
    const t = sent.type?.className || '';
    if (t.includes('App')) {
      console.log('→ Code sent to TELEGRAM APP (NOT SMS) — open Telegram app → chat "Telegram" (777000) → code');
      console.log(
        "  18.02.2023 dan beri third-party SMS ololmaydi — faqat app. Agar hech qaerda sessiyangiz yo'q bo'lsa ham shunday bo'ladi.",
      );
      console.log("  Hech qanday kod kelmasa: (a) 777000 + Spam + Email inbox ham tekshiring (b) VPN o'chiring");
    } else if (t.includes('EmailCode')) console.log('→ Code sent to EMAIL — inbox (Spam ham) tekshiring');
    else if (t.includes('Sms'))
      console.log('→ Code sent via SMS (check SMS inbox, wait 60-120s, Firebase SMS faqat official app da)');
    else if (t.includes('FragmentSms')) console.log('→ Fragment SMS (fragment.com) — wallet login');
    else if (t.includes('Call')) console.log('→ Code via phone call (voice)');
    else if (t.includes('FlashCall'))
      console.log('→ FlashCall — pattern:', (sent.type as unknown as { pattern?: string })?.pattern);
    else if (t.includes('SetUpEmailRequired'))
      console.log("→ Telegram login EMAIL so'radi — avval email o'rnating (official app da)");
    else console.log('→ Unknown type, check full above — likely App');

    if (sent.nextType)
      console.log(`Next fallback (after timeout): ${sent.nextType.className} — use auth.ResendCode with phoneCodeHash`);
    if (sent.timeout) console.log(`Resend allowed after ${sent.timeout}s — wait then try resend`);
    else
      console.log(
        'Note: timeout=null → code often never arrives (flagged IP or 2025-2026 Telegram bug) — try QR: npm run login:qr',
      );

    if (!sent.timeout && t.includes('App')) {
      console.log(
        "\n⚠ timeout=null va App type — 2025-2026 da ko'p uchraydi: kod Telegram app ga ham kelmasligi mumkin (VPN/datacenter, FloodWait).",
      );
      console.log("  → 8-12 soat kutib, boshqa api_id/phone/IP sinab ko'ring yoki darhol QR: npm run login:qr");
      const tryResend = await ask('Try auth.ResendCode now? (y/n): ');
      if (tryResend.toLowerCase().startsWith('y')) {
        try {
          console.log('Calling auth.ResendCode...');
          const resent = (await client.invoke(
            new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash }),
          )) as unknown as typeof sent;
          console.log('Resend result:', JSON.stringify(resent, null, 2));
          console.log(`→ New type: ${resent.type?.className ?? 'unknown'}`);
        } catch (re) {
          console.error('Resend failed:', (re as Error).message || re);
          const rm = String((re as Error).message || '');
          if (rm.includes('PHONE_CODE_EXPIRED')) console.error('→ Old code expired before resend — normal');
          if (rm.includes('SEND_CODE_UNAVAILABLE')) console.error('→ Barcha usullar tugadi — QR ishlating');
        }
      }
    }

    const code = await ask('\nEnter login code (777000 / SMS / Email) — 5-6 digits, or empty to cancel: ');
    if (!code) {
      console.log('Cancelled');
      await client.disconnect();
      return;
    }
    console.log('Trying auth.signIn...');
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: sent.phoneCodeHash,
          phoneCode: code.replace(/\s+/g, ''),
        }),
      );
      console.log('✓ signIn OK');
    } catch (e) {
      const msg = String((e as Error).message || e);
      console.error('signIn error:', msg);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        console.log('→ 2FA needed, then possibly Email');
        const pwd = config.twoFaPassword || (await ask('2FA password: '));
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import('teleproto/Password');
        const check = await (computeCheck as unknown as (a: unknown, b: string) => Promise<unknown>)(pwdInfo, pwd);
        try {
          await client.invoke(new Api.auth.CheckPassword({ password: check as Api.InputCheckPasswordSRP }));
          console.log('✓ 2FA OK');
        } catch (e2) {
          const m2 = String((e2 as Error).message || e2);
          if (m2.includes('EMAIL_UNCONFIRMED') || m2.includes('EMAIL')) {
            console.log('→ Email verification after 2FA — check inbox');
            await ask('Email code (pochtadan): ');
            // teleproto may require emailVerification param
            // Try next step if needed; fallback is manual via official app
            console.error(
              'Email after 2FA not fully automated in this script — please use official app to confirm email, then retry QR',
            );
            throw e2;
          } else throw e2;
        }
      } else if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
        console.error('→ Invalid/expired code — request new code via ResendCode or QR.');
        const rr = await ask('Try ResendCode now? (y/n): ');
        if (rr.toLowerCase().startsWith('y')) {
          try {
            const resent2 = (await client.invoke(
              new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash }),
            )) as unknown as typeof sent;
            console.log('Resent:', JSON.stringify(resent2, null, 2));
          } catch (re2) {
            console.error('ResendCode failed:', (re2 as Error).message);
          }
        }
        await client.disconnect();
        return;
      } else if (msg.includes('PHONE_NUMBER_UNOCCUPIED')) {
        console.error('→ Phone not registered — create account in official app first.');
        await client.disconnect();
        return;
      } else throw e;
    }

    try {
      const me = await client.getMe();
      console.log(`  verified as: ${(me as unknown as { username?: string })?.username || 'ok'}`);
      const iter = (client as unknown as { iterDialogs: (p: unknown) => AsyncIterable<unknown> }).iterDialogs({
        limit: 5,
      });
      let c = 0;
      for await (const _ of iter) {
        c++;
        if (c >= 1) break;
      }
      await new Promise((r) => setTimeout(r, 800));
    } catch {}
    const session = (client.session as StringSession).save() as unknown as string;
    console.log('\n✔ Logged in! StringSession:');
    console.log(session);
    console.log('\nEncrypted:');
    const enc = encryptSession(session);
    console.log(enc);
    saveEncryptedSession(session);
    console.log('✔ Saved to sessions/ubot.session.enc (600)');
    syncEnvFile(enc);
    console.log(`\nAdd to ubot/.env:\nUBOT_SESSION_STRING=${enc}`);
  } catch (e) {
    console.error('\nSendCode failed:', (e as Error).message || e);
    const m = String((e as Error).message || '');
    if (m.includes('FLOOD_WAIT')) {
      const sec = m.match(/\d+/)?.[0];
      console.error(`→ FloodWait ${sec || ''}s — ${sec ? sec + 's kuting' : 'kuting'}, 5 urinish/24h limit!`);
    }
    if (m.includes('PHONE_NUMBER_INVALID')) console.error('→ Invalid phone format (must be +998..., no spaces)');
    if (m.includes('PHONE_NUMBER_BANNED')) console.error('→ Number banned — @SpamBot tekshiring');
    if (m.includes('API_ID_INVALID')) console.error('→ API_ID/HASH invalid — my.telegram.org dan qayta oling');
    if (m.includes('SEND_CODE_UNAVAILABLE'))
      console.error('→ Barcha kod yuborish usullari tugadi — QR ishlating: npm run login:qr');
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
