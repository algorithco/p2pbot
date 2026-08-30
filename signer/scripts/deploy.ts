import '../src/config';
import { signer } from '../src/wallet';

async function main() {
  await signer.init();
  if (!signer.isConfigured()) {
    console.error('SIGNER_MNEMONIC not set — cannot deploy');
    process.exit(1);
  }
  const value = process.argv[2] || '0.05';
  console.log('Deploying W5 wallet with value', value);
  console.log('Address:', signer.getAddressString());
  const res = await signer.deploy(value);
  console.log('Deployed, seqno', res.seqno);
}

main().catch((e) => {
  console.error('Deploy failed:', e.message || e);
  process.exit(1);
});
