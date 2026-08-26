/**
 * Create a new Highload Wallet v3.
 *
 * Usage:
 *   npm run create-wallet -- [name] [--timeout <seconds>] [--subwallet <id>] [--network mainnet]
 *
 * Example:
 *   npm run create-wallet -- hot-wallet --timeout 3600
 */
import { HighloadWallet } from '../src/wallet';
import { getNetwork } from '../src/config';

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const name = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'wallet';
    const timeout = Number(arg('--timeout') ?? 60 * 60);
    const subwalletId = Number(arg('--subwallet') ?? 0x10ad);
    let network = (arg('--network') as any) ?? undefined;

    if (HighloadWallet.exists(name)) {
        console.error(`Wallet "${name}" already exists at ${HighloadWallet.filePath(name)}`);
        process.exit(1);
    }

    if (!timeout || timeout <= 0) throw new Error('--timeout must be > 0');
    if (!Number.isFinite(subwalletId)) throw new Error('bad --subwallet');

    const wallet = await HighloadWallet.generate({
        name,
        timeout,
        subwalletId,
        network: network ?? getNetwork(),
    });
    wallet.save();

    console.log('='.repeat(62));
    console.log(` Highload Wallet v3 created: ${name}`);
    console.log('='.repeat(62));
    console.log(` Network     : ${wallet.state.network}`);
    console.log(` Address     : ${wallet.address.toString({ urlSafe: true, bounceable: false })}`);
    console.log(` Public key  : ${wallet.state.publicKey}`);
    console.log(` Subwallet ID: 0x${subwalletId.toString(16)} (${subwalletId})`);
    console.log(` Timeout     : ${timeout}s`);
    console.log('');
    console.log(' MNEMONIC (write it down, keep secret!):');
    console.log(' ' + wallet.state.mnemonic.join(' '));
    console.log('');
    console.log(` Saved to: ${wallet.filePath()}`);
    console.log('='.repeat(62));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
