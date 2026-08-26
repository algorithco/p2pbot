/**
 * Deploy the highload wallet (external message carrying StateInit + self transfer).
 * The wallet must hold no funds before deploy; after deploy send TON to its address.
 *
 * Usage:
 *   npm run deploy -- [name] [--value 0.05]
 */
import { fromNano } from '@ton/core';
import { HighloadWallet } from '../src/wallet';
import { toNano } from '@ton/core';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'wallet';
    const value = toNano(arg('--value') ?? '0.05');

    const wallet = await HighloadWallet.load(name);

    console.log(`Address : ${wallet.address.toString({ urlSafe: true })}`);

    if (await wallet.isDeployed()) {
        console.log('Wallet is already deployed.');
        return;
    }
    if ((await wallet.getBalance()) === 0n) {
        console.log('WARNING: wallet has zero balance. Deployment external message may be rejected by validators.');
        console.log('         Send a little TON to the address first, then re-run deploy.');
    }

    console.log(`Deploying with self-transfer of ${fromNano(value)} TON ...`);
    const res = await wallet.deploy(value);
    console.log(`External message sent (query_id=${res.queryId.getQueryId()}, createdAt=${res.createdAt}).`);

    const ok = await wallet.waitForProcessed(res.queryId, { timeoutMs: 120_000 });
    console.log(ok ? 'Deployed & processed on-chain.' : 'Not confirmed yet - check later with: npm run info');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
