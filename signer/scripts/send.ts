import '../src/config';
import { signer } from '../src/wallet';

async function main() {
  await signer.init();
  if (!signer.isConfigured()) {
    console.error('SIGNER_MNEMONIC not set — cannot send');
    process.exit(1);
  }
  const to = process.argv[2];
  const value = process.argv[3];
  const comment = process.argv[4];
  if (!to || !value) {
    console.error('Usage: npm run send -- <toAddress> <valueTON> [comment]');
    process.exit(1);
  }
  console.log(`Sending ${value} TON to ${to}${comment ? ` (comment: ${comment})` : ''}`);
  const res = await signer.send({ to, value, comment });
  console.log('Sent, seqno', res.seqno);
}

main().catch((e) => {
  console.error('Send failed:', e.message || e);
  process.exit(1);
});
