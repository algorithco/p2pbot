/**
 * Send an NFT (or a batch from a JSON file) from the highload wallet.
 * Also verifies ownership before sending.
 *
 * Single:
 *   npm run send-nft -- [name] <nft-item-address> <new-owner-address> [--forward 0.01] [--comment "text"]
 * Batch (file: [{"nft":"EQ..item","to":"UQ..owner"}, ...]):
 *   npm run send-nft -- [name] --file nfts.json
 */
import * as fs from 'fs';
import { beginCell } from '@ton/core';
import { HighloadWallet } from '../src/wallet';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const name = args[0] ?? 'wallet';
    const wallet = await HighloadWallet.load(name);

    if (!(await wallet.isDeployed())) throw new Error('Wallet is not deployed - run: npm run deploy');

    const comment = arg('--comment');
    const forwardPayload = comment
        ? beginCell().storeUint(0, 32).storeStringTail(comment).endCell()
        : undefined;
    const forwardAmount = arg('--forward') ?? '0.01';

    if (arg('--file')) {
        const list = JSON.parse(fs.readFileSync(arg('--file')!, 'utf8')) as Array<{ nft: string; to: string }>;
        console.log(`Sending ${list.length} NFTs ...`);
        for (const e of list) {
            await wallet.sendNft({ nftAddress: e.nft, newOwner: e.to, forwardAmount, forwardPayload });
            console.log(`  sent ${e.nft} -> ${e.to}`);
        }
        return;
    }

    const nft = args[1];
    const newOwner = args[2];
    if (!nft || !newOwner) {
        console.error('Usage: npm run send-nft -- [name] <nft-item> <new-owner> | --file nfts.json');
        process.exit(1);
    }

    // verify ownership ("storing") state first
    const info = await wallet.getNftInfo(nft);
    if (!info.deployed) {
        console.warn('WARNING: NFT item contract is not deployed/active.');
    } else {
        console.log(`NFT owner on-chain : ${info.owner?.toString() ?? 'none'}`);
        console.log(`This wallet address: ${wallet.address.toString()}`);
    }

    const res = await wallet.sendNft({ nftAddress: nft, newOwner, forwardAmount, forwardPayload });
    console.log(`NFT transfer sent (query_id=${res.queryId.getQueryId()}).`);

    const okDone = await wallet.waitForProcessed(res.queryId);
    console.log(okDone ? 'Processed. New owner should see the NFT shortly.' : 'Not confirmed yet - check with npm run info.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
