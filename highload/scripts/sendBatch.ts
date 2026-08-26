/**
 * Send many transfers in batches (up to 254 recipients per external message).
 *
 * Transfers file format (JSON array):
 * [
 *   { "to": "UQ...", "amount": "0.5", "comment": "payout #1" },
 *   { "to": "EQ...", "amount": "1.25" }
 * ]
 *
 * Usage:
 *   npm run send-batch -- [name] <transfers.json>
 */
import * as fs from 'fs';
import { Address, beginCell } from '@ton/core';
import { HighloadWallet, TransferRequest } from '../src/wallet';

interface BatchEntry {
    to: string;
    amount: string;
    comment?: string;
}

async function main() {
    const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const name = args[0] ?? 'wallet';
    const listFile = args[1];

    if (!listFile) {
        console.error('Usage: npm run send-batch -- [name] <transfers.json>');
        process.exit(1);
    }

    const entries: BatchEntry[] = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('transfers.json must be a non-empty array');

    const wallet = await HighloadWallet.load(name);
    if (!(await wallet.isDeployed())) throw new Error('Wallet is not deployed - run: npm run deploy');

    const requests: TransferRequest[] = entries.map((e) => ({
        to: Address.parse(e.to),
        value: e.amount,
        body: e.comment ? beginCell().storeUint(0, 32).storeStringTail(e.comment).endCell() : null,
        bounce: false,
    }));

    console.log(`Sending ${requests.length} transfers in batches of <=254 ...`);
    const results = await wallet.sendBatch(requests);

    for (const r of results) {
        console.log(`  batch sent: ${r.count} msgs, query_id=${r.queryId.getQueryId()}`);
    }
    console.log('All external messages sent. Confirmations:');
    for (const r of results) {
        const ok = await wallet.waitForProcessed(r.queryId);
        console.log(`  query_id=${r.queryId.getQueryId()} -> ${ok ? 'processed' : 'PENDING'}`);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
