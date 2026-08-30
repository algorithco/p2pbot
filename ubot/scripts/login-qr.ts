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
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { config } from '../src/config';
import { encryptSession, saveEncryptedSession } from '../src/sessionManager';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// Minimal QR terminal renderer (avoids extra dep); also prints URL for online QR generator
function printQrUrl(token: Buffer) {
  const b64url = token.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `tg://login?token=${b64url}`;
  console.log('\n=== QR ===');
  console.log('1) On phone: Telegram → Settings → Devices → Link Desktop Device → Scan QR');
  console.log('2) URL (if terminal QR not visible, paste into https://api.qrserver.com/v1/create-qr-code/?data=):');
  console.log(url);
  console.log('3) Or generate QR image: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(url));
  // Try qrcode-terminal if installed
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
  });
  await client.connect();
  console.log(`API_ID=${config.apiId} — starting QR login (no phone needed)...`);

  try {
    // GramJS QR helper — generates token, calls qrCode callback each refresh
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
        onError: async (err: Error) => {
          console.error('QR error:', err.message || err);
          // false = retry, true = stop
          if (String(err.message).includes('FLOOD_WAIT')) {
            console.error('→ FloodWait, wait before retry');
            return true;
          }
          return false;
        },
      }
    );

    console.log('\n✔ QR login success!', user);
    const session = (client.session as StringSession).save() as unknown as string;
    console.log('\nStringSession (plain, keep secret):');
    console.log(session);
    const enc = encryptSession(session);
    console.log('\nEncrypted (for UBOT_SESSION_STRING):');
    console.log(enc);

    const save = await ask('\nSave to sessions/ubot.session.enc? (y/n): ');
    if (save.toLowerCase().startsWith('y')) {
      saveEncryptedSession(session);
      console.log('Saved to sessions/ubot.session.enc (600)');
    }
    console.log(`\nAdd to ubot/.env:\nUBOT_SESSION_STRING=${enc}`);
    if (!config.encryptionKey) console.log('Tip: set ENCRYPTION_KEY=64 hex to enable encryption');

    await client.disconnect();
  } catch (e) {
    console.error('\nQR login failed:', (e as Error).message || e);
    console.error('Try again: npm run login:qr');
    try { await client.disconnect(); } catch {}
    process.exit(1);
  }
}

main();
