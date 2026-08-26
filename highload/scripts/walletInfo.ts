/**
 * Show wallet info (address, balance, on-chain state).
 *
 * Usage:
 *   npm run info -- [name]
 */
import { Address, fromNano } from '@ton/core';
import { HighloadWallet } from '../src/wallet';

async function main() {
    const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'wallet';
    const wallet = await HighloadWallet.load(name);

    const info = await wallet.getOnChainInfo();

    console.log('='.repeat(62));
    console.log(` Highload Wallet v3: ${name} (${wallet.state.network})`);
    console.log('='.repeat(62));
    console.log(` Address      : ${wallet.address.toString({ urlSafe: true, bounceable: false })}`);
    console.log(`   bounceable : ${wallet.address.toString({ urlSafe: true, bounceable: true })}`);
    console.log(`   raw        : ${wallet.address.toRawString()}`);
    console.log(` Deployed     : ${info.deployed ? 'yes' : 'NO - run deploy script / send TON'}`);
    console.log(` Balance      : ${fromNano(info.balance)} TON`);
    console.log(` Next query id: seqno=${wallet.state.nextSeqno}`);
    if (info.deployed) {
        console.log(` Pubkey (chain): ${info.publicKey?.toString('hex')}`);
        console.log(` Subwallet     : 0x${info.subwalletId?.toString(16)}`);
        console.log(` Timeout       : ${info.timeout}s`);
        console.log(` Last cleaned  : ${info.lastCleaned ? new Date(info.lastCleaned * 1000).toISOString() : '-'}`);
    }
    console.log('='.repeat(62));

    void Address;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
