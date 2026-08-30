/**
 * Interactive login to generate StringSession for ubot.
 * Usage: npm run login
 * Will prompt phone -> code -> 2FA if needed -> prints encrypted session.
 *
 * Requires API_ID, API_HASH in env or .env
 */
import * as readline from 'readline';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config } from '../src/config';
import { encryptSession, saveEncryptedSession } from '../src/sessionManager';

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  if (!config.apiId || !config.apiHash) {
    console.error('Set API_ID and API_HASH in ubot/.env (get at https://my.telegram.org)');
    process.exit(1);
  }

  const phone = config.phone || (await ask('Phone (E.164, e.g. +1234567890): '));
  if (!phone) {
    console.error('Phone required');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => phone,
    password: async () => config.twoFaPassword || (await ask('2FA password (if enabled, else Enter): ')),
    phoneCode: async () => await ask('Login code (Telegram/SMS): '),
    onError: (err) => console.error('Login error', err),
  });

  console.log('✔ Logged in!');
  const session = (client.session as StringSession).save() as unknown as string;
  console.log('\nStringSession (plain, keep secret):');
  console.log(session);
  console.log('\nEncrypted (for .env UBOT_SESSION_STRING):');
  const enc = encryptSession(session);
  console.log(enc);

  const save = await ask('\nSave encrypted session to sessions/ubot.session.enc? (y/n): ');
  if (save.toLowerCase().startsWith('y')) {
    saveEncryptedSession(session);
    console.log('Saved.');
  }

  console.log('\nAdd to ubot/.env:');
  console.log(`UBOT_SESSION_STRING=${enc}`);
  if (!config.encryptionKey) console.log('(Set ENCRYPTION_KEY to 32-byte hex to enable encryption)');

  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
