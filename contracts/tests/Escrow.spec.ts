/**
 * Sandbox tests for Escrow.tact.
 *
 * Dependencies (require network to install the first time):
 *   npm i -D @ton/sandbox @ton/test-utils jest ts-jest @types/jest
 *
 * Requires a compiled contract: `npm run build` writes ./output/*.boc.
 * All tests are SKIPPED when no compiled BOC is present so `npm test` stays
 * green in offline/CI environments before compilation has been performed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { beginCell, Cell, toNano } from '@ton/core';
import { Blockchain } from '@ton/sandbox';
import '@ton/test-utils';
import { deployBody, escrowTextOp, Escrow } from '../wrappers/Escrow';

function loadCompiledCode(): Cell | null {
  const outDir = path.resolve(__dirname, '..', 'output');
  try {
    if (!fs.existsSync(outDir)) return null;
    const bocFile = fs.readdirSync(outDir).find((f) => f.endsWith('.boc'));
    if (!bocFile) return null;
    return Cell.fromBoc(fs.readFileSync(path.join(outDir, bocFile)))[0];
  } catch {
    return null;
  }
}

const code = loadCompiledCode();
const describeIfCompiled = code ? describe : describe.skip;

describeIfCompiled('Escrow (sandbox)', () => {
  const DEAL_ID = 42n;
  const AMOUNT = toNano('10'); // 10 TON
  const FEE_BPS = 100; // 1%

  async function setup() {
    const blockchain = await Blockchain.create();
    const buyer = await blockchain.treasury('buyer');
    const seller = await blockchain.treasury('seller');
    const admin = await blockchain.treasury('admin');
    const feeVault = await blockchain.treasury('feeVault');

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const escrow = blockchain.openContract(
      Escrow.create({
        dealId: DEAL_ID,
        buyer: buyer.address,
        seller: seller.address,
        admin: admin.address,
        feeAddress: feeVault.address,
        assetType: 0, // TON deal
        amount: AMOUNT,
        feeBps: FEE_BPS,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        jettonMaster: null,
        contractJettonWallet: null,
        owner: admin.address, // owner == admin keeps the fixture simple
        code: code!,
      }),
    );
    return { blockchain, buyer, seller, admin, feeVault, escrow };
  }

  it('deploys, accepts a TON deposit, releases after mutual confirmation with fee split', async () => {
    const { blockchain, buyer, seller, admin, feeVault, escrow } = await setup();

    // Deploy via Deployable's Deploy{queryId} body.
    const deployResult = await escrow.send(admin.getSender(), { value: toNano('0.12') }, deployBody());
    expect(deployResult.transactions).toHaveTransaction({ to: escrow.address, op: 0, success: true });
    expect(await escrow.getStatus()).toBe(0);

    // Non-buyer deposit is rejected.
    const stranger = await blockchain.treasury('stranger');
    const strangerTry = await escrow.send(stranger.getSender(), { value: AMOUNT + toNano('0.05') }, beginCell().endCell());
    expect(strangerTry.transactions).toHaveTransaction({ to: escrow.address, success: false });
    expect(await escrow.getStatus()).toBe(0);

    const sellerBefore = await seller.getBalance();
    const feeBefore = await feeVault.getBalance();

    // Buyer deposits amount + gas headroom; excess is kept as storage reserve.
    const deposit = await escrow.send(buyer.getSender(), { value: AMOUNT + toNano('0.05') }, beginCell().endCell());
    expect(deposit.transactions).toHaveTransaction({ to: escrow.address, success: true });
    expect(await escrow.getStatus()).toBe(1);

    // A single confirmation must not release.
    await escrow.send(seller.getSender(), { value: toNano('0.05') }, escrowTextOp('confirm'));
    expect(await escrow.getStatus()).toBe(1);

    // Second party confirms -> release with fee split (SendPayGasSeparately).
    const confirmResult = await escrow.send(buyer.getSender(), { value: toNano('0.05') }, escrowTextOp('confirm'));
    expect(confirmResult.transactions).toHaveTransaction({ to: escrow.address, success: true });
    expect(await escrow.getStatus()).toBe(2);

    const expectedSeller = sellerBefore + (AMOUNT * 9900n) / 10000n;
    expect(await seller.getBalance()).toBeGreaterThan(expectedSeller - toNano('0.02'));
    expect(await feeVault.getBalance()).toBeGreaterThanOrEqual(feeBefore + (AMOUNT * 100n) / 10000n - toNano('0.01'));
  });

  it('admin can refund while still awaiting deposit, closing the deal as REFUNDED', async () => {
    const { admin, escrow } = await setup();

    await escrow.send(admin.getSender(), { value: toNano('0.12') }, deployBody());

    const refundResult = await escrow.send(admin.getSender(), { value: toNano('0.05') }, escrowTextOp('refund'));
    expect(refundResult.transactions).toHaveTransaction({ to: escrow.address, success: true });
    expect(await escrow.getStatus()).toBe(3);
  });

  it('rejects confirmations from parties other than buyer/seller', async () => {
    const { blockchain, buyer, admin, escrow } = await setup();

    await escrow.send(admin.getSender(), { value: toNano('0.12') }, deployBody());
    await escrow.send(buyer.getSender(), { value: AMOUNT + toNano('0.05') }, beginCell().endCell());

    const stranger = await blockchain.treasury('stranger2');
    const strangerConfirm = await escrow.send(stranger.getSender(), { value: toNano('0.05') }, escrowTextOp('confirm'));
    expect(strangerConfirm.transactions).toHaveTransaction({ to: escrow.address, success: false });
    expect(await escrow.getStatus()).toBe(1);
  });
});
