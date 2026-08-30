/**
 * Verbose login — shows exactly where Telegram sent the code (sms/app/call)
 * Usage: npx ts-node scripts/login-verbose.ts  (or npm run login:verbose)
 */
import * as readline from 'readline';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto';
import { config } from '../src/config';
import { encryptSession, saveEncryptedSession } from '../src/sessionManager';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    console.error('Set API_ID / API_HASH in ubot/.env');
    process.exit(1);
  }
  const phone = config.phone || (await ask('Phone E.164 (+998776520524): '));
  console.log(`\nAPI_ID=${config.apiId} API_HASH=${config.apiHash.slice(0, 6)}**** phone=${phone.slice(0, 4)}****`);
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, { connectionRetries: 5 });
  await client.connect();
  console.log('Connected, calling auth.sendCode...');

  try {
    const sent = (await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: config.apiId,
        apiHash: config.apiHash,
        settings: new Api.CodeSettings({}),
      })
    )) as unknown as { phoneCodeHash: string; type: { className: string; length?: number }; nextType?: { className: string }; timeout?: number };

    console.log('\n=== auth.SendCode result ===');
    console.log('phoneCodeHash:', sent.phoneCodeHash);
    console.log('type:', sent.type?.className, JSON.stringify(sent.type));
    console.log('nextType:', sent.nextType?.className ?? 'none');
    console.log('timeout:', sent.timeout ?? 'none');
    console.log('Full:', JSON.stringify(sent, null, 2));
    console.log('\n--- Interpretation ---');
    const t = sent.type?.className || '';
    if (t.includes('App')) console.log('→ Code sent to TELEGRAM APP (open Telegram on that phone → message from Telegram/777000 with 5-digit code, NOT SMS)');
    else if (t.includes('Sms')) console.log('→ Code sent via SMS (check SMS inbox, wait 60-120s)');
    else if (t.includes('Call')) console.log('→ Code via phone call');
    else if (t.includes('FlashCall')) console.log('→ FlashCall');
    else console.log('→ Unknown type, check full above');

    if (sent.nextType) console.log(`Next fallback type: ${sent.nextType.className}`);
    if (sent.timeout) console.log(`Retry after ${sent.timeout}s`);

    const code = await ask('\nEnter login code (5 digits, or empty to cancel): ');
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
        })
      );
      console.log('✓ signIn OK');
    } catch (e) {
      const msg = String((e as Error).message || e);
      console.error('signIn error:', msg);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        const pwd = config.twoFaPassword || (await ask('2FA password: '));
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import('teleproto/Password');
        // @ts-ignore
        const check = await (computeCheck as unknown as (a: unknown, b: string) => Promise<unknown>)(pwdInfo, pwd);
        await client.invoke(new Api.auth.CheckPassword({ password: check as Api.InputCheckPasswordSRP }));
        console.log('✓ 2FA OK');
      } else if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
        console.error('→ Invalid/expired code. Request new code.');
        await client.disconnect();
        return;
      } else if (msg.includes('PHONE_NUMBER_UNOCCUPIED')) {
        console.error('→ Phone not registered on Telegram — need signUp. Create account in official app first.');
        await client.disconnect();
        return;
      } else throw e;
    }

    const session = (client.session as StringSession).save() as unknown as string;
    console.log('\n✔ Logged in! StringSession:');
    console.log(session);
    console.log('\nEncrypted:');
    const enc = encryptSession(session);
    console.log(enc);
    const save = await ask('\nSave to sessions/ubot.session.enc? (y/n): ');
    if (save.toLowerCase().startsWith('y')) {
      saveEncryptedSession(session);
      console.log('Saved');
    }
    console.log(`\nAdd to ubot/.env:\nUBOT_SESSION_STRING=${enc}`);
  } catch (e) {
    console.error('\nSendCode failed:', (e as Error).message || e);
    const m = String((e as Error).message || '');
    if (m.includes('FLOOD_WAIT')) {
      const sec = m.match(/\d+/)?.[0];
      console.error(`→ FloodWait ${sec}s — wait before retry`);
    }
    if (m.includes('PHONE_NUMBER_INVALID')) console.error('→ Invalid phone format (must be +998..., no spaces)');
    if (m.includes('PHONE_NUMBER_BANNED')) console.error('→ Number banned');
    if (m.includes('API_ID_INVALID')) console.error('→ API_ID/HASH invalid or not approved');
  } finally {
    try { await client.disconnect(); } catch {}
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
