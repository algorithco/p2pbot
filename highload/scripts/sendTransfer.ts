/**
 * Send a single TON transfer from the highload wallet.
 *
 * Usage:
 *   npm run send -- [name] <to-address> <amount-TON> [--comment "text"] [--bounceable]
 *
 * Examples:
 *   npm run send -- hot-wallet UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM 1.5
 *   npm run send -- hot-wallet EQ... 0.01 --comment "withdrawal #123"
 */
import { beginCell, toNano } from '@ton/core';
import { HighloadWallet } from '../src/wallet';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const name = args[0] ?? 'wallet';
    const to = args[1];
    const amount = args[2];

    if (!to || !amount) {
        console.error('Usage: npm run send -- [name] <to-address> <amount-TON> [--comment "text"] [--bounceable]');
        process.exit(1);
    }

    const wallet = await HighloadWallet.load(name);
    if (!(await wallet.isDeployed())) throw new Error('Wallet is not deployed - run: npm run deploy');

    const comment = arg('--comment');
    const body = comment
        ? beginCell().storeUint(0, 32).storeStringTail(comment).endCell()
        : undefined;

    console.log(`Sending ${amount} TON to ${to} ...`);
    const res = await wallet.send({
        to,
        value: toNano(amount),
        body,
        bounce: process.argv.includes('--bounceable'),
    });

    console.log(`External message sent (query_id=${res.queryId.getQueryId()}, createdAt=${res.createdAt}).`);
    const ok = await wallet.waitForProcessed(res.queryId);
    console.log(ok ? 'Transfer processed on-chain.' : 'Not confirmed yet - retry check with: npm run info');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
