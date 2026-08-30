import '../src/config';
import { signer } from '../src/wallet';

async function main() {
  await signer.init();
  const addr = signer.getAddressString();
  console.log('Address:', addr ?? 'NOT CONFIGURED (set SIGNER_MNEMONIC)');
  console.log('Configured:', signer.isConfigured());
  if (addr) {
    const state = await signer.getState();
    console.log('Deployed:', state.deployed);
    console.log('Balance:', state.balance.toString(), 'nanoTON');
    try {
      const seqno = await signer.getSeqno();
      console.log('Seqno:', seqno);
    } catch (e) {
      console.log('Seqno: (error)', String(e));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
