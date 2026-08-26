/**
 * Admin wallet operations - backup sender when the highload path fails.
 *
 *   npm run admin -- create <name>              generate admin wallet
 *   npm run admin -- info <name>                show address/balance/deployed
 *   npm run admin -- deploy <name>              self-deploy (needs balance)
 *   npm run admin -- deploy-highload <adminName> <highloadName> [--value 0.05]
 *                                               deploy highload via internal StateInit
 *   npm run admin -- rescue <highloadName> <adminOrAddr>
 *                                               sweep ENTIRE highload balance out
 *                                               (emergency exit)
 */
import { Address, fromNano } from '@ton/core';
import { AdminWallet } from '../src/adminWallet';
import { HighloadWallet } from '../src/wallet';

async function main() {
    const cmd = process.argv[2];

    if (cmd === 'create') {
        const name = process.argv[3] ?? 'admin';
        if (AdminWallet.exists(name)) throw new Error(`Admin wallet "${name}" already exists`);
        const w = await AdminWallet.generate({ name });
        w.save();
        console.log('='.repeat(62));
        console.log(` Admin wallet created: ${name}`);
        console.log(` Address : ${w.address.toString({ urlSafe: true, bounceable: false })}`);
        console.log('');
        console.log(' MNEMONIC (write it down, keep secret!):');
        console.log(' ' + w.state.mnemonic.join(' '));
        console.log('');
        console.log(` Saved to: ${w.filePath()}`);
        console.log('='.repeat(62));
        return;
    }

    if (cmd === 'info') {
        const name = process.argv[3] ?? 'admin';
        const w = await AdminWallet.load(name);
        const bal = await w.getBalance();
        console.log('='.repeat(62));
        console.log(` Admin wallet: ${name} (${w.state.network})`);
        console.log(` Address : ${w.address.toString({ urlSafe: true, bounceable: false })}`);
        console.log(` Deployed: ${await w.isDeployed() ? 'yes' : 'no'}`);
        console.log(` Balance : ${fromNano(bal)} TON`);
        console.log('='.repeat(62));
        return;
    }

    if (cmd === 'deploy') {
        const name = process.argv[3] ?? 'admin';
        const w = await AdminWallet.load(name);
        console.log('Deploying admin wallet (self-transfer) ...');
        await w.deploy();
        console.log('Deploy message sent.');
        return;
    }

    if (cmd === 'deploy-highload') {
        const adminName = process.argv[3];
        const hlName = process.argv[4];
        if (!adminName || !hlName) throw new Error('Usage: npm run admin -- deploy-highload <adminName> <highloadName>');
        const admin = await AdminWallet.load(adminName);
        const hw = await HighloadWallet.load(hlName);
        if (await hw.isDeployed()) {
            console.log('Highload wallet already deployed.');
            return;
        }
        console.log(`Deploying highload ${hw.address.toString()} via internal StateInit from admin wallet ...`);
        await admin.deployHighload(hw);
        console.log('Internal deploy message sent (more reliable than external-StateInit).');
        return;
    }

    if (cmd === 'rescue') {
        const hlName = process.argv[3];
        const destArg = process.argv[4];
        if (!hlName || !destArg) {
            throw new Error('Usage: npm run admin -- rescue <highloadName> <destination-address-or-adminName>');
        }
        const hw = await HighloadWallet.load(hlName);
        const dest =
            destArg.includes('.') || destArg.startsWith('UQ') || destArg.startsWith('EQ')
                ? Address.parse(destArg)
                : (await AdminWallet.load(destArg)).address;

        const bal = await hw.getBalance();
        console.log(`Sweeping ALL ${fromNano(bal)} TON from highload ${hw.address.toString()}`);
        console.log(`to ${dest.toString()} ...`);
        const res = await hw.sweepAllTo(dest);
        console.log(`Sweep sent (query_id=${res.queryId.getQueryId()}).`);
        const okDone = await hw.waitForProcessed(res.queryId);
        console.log(okDone ? 'Swept.' : 'Not confirmed yet - re-check balance.');
        return;
    }

    console.error(
        'Commands: create <name> | info <name> | deploy <name> | deploy-highload <admin> <highload> | rescue <highload> <dest>'
    );
    process.exit(1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
