/**
 * Deploys Escrow contracts via the isolated W5 signer microservice.
 *
 * Guards: refuses to run without signer (SIGNER_URL + SIGNER_API_KEY), a
 * compiled code BOC (ESCROW_CONTRACT_CODE_HEX) and admin/fee addresses —
 * every failure mode throws a descriptive `deploy_not_configured: …` error.
 *
 * Deployment body: the Deployable trait expects Deploy{queryId}, i.e.
 * op = 0x00000000 (u32) followed by queryId (u64).
 */
import { Address, Cell, toNano } from '@ton/core';
import { config } from '../config';
import { ESCROW_CODE_HEX, deployBody, Escrow } from '../contracts/wrappers/Escrow';
import { computeJettonWalletAddress } from './jettonUtils';
import { getSignerAddress, deployEscrowViaSigner } from './signerClient';

/**
 * Defensive import of ../utils/money (owned by a parallel workstream; may not
 * exist yet). Falls back to a local identical implementation until it lands.
 * TODO(dedupe): remove fallback once src/utils/money.ts is merged.
 */
type ToBaseUnits = (amount: string | number, decimals?: number) => bigint;

let loadedToBaseUnits: ToBaseUnits | undefined;
try {
  const mod = require('../utils/money') as { toBaseUnits?: ToBaseUnits } | undefined;
  if (mod && typeof mod.toBaseUnits === 'function') {
    loadedToBaseUnits = mod.toBaseUnits;
  }
} catch {
  // module not present yet — fallback below covers us
}

const toBaseUnits: ToBaseUnits =
  loadedToBaseUnits ??
  ((amount: string | number, decimals = 9): bigint => {
    const str = String(amount).trim();
    const neg = str.startsWith('-');
    const unsigned = neg ? str.slice(1) : str;
    const [whole, frac = ''] = unsigned.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const result =
      BigInt(whole === '' ? '0' : whole) * 10n ** BigInt(decimals) + BigInt(fracPadded === '' ? '0' : fracPadded);
    return neg ? -result : result;
  });

/** Human amount -> base units (nanoTON for TON deals, 6dp for USDT-style jettons). */
export function parseDealAmount(amount: string | number, assetType: number): bigint {
  return toBaseUnits(amount, assetType === 0 ? 9 : 6);
}

/**
 * Deploys a new Escrow instance and returns its address.
 *
 * NOTE: `sellerJettonWallet` / `feeJettonWallet` are kept in the signature for
 * API compatibility with existing callers; the current contract version takes
 * only the contract's own jetton wallet (release transfers the full jetton
 * amount to the seller; fee split is handled off-chain).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function deployEscrowContract(
  dealId: bigint,
  buyer: Address,
  seller: Address,
  assetType: number,
  amount: bigint,
  deadline: number,
  sellerJettonWallet?: Address,
  feeJettonWallet?: Address,
): Promise<string> {
  if (!config.signerUrl) {
    throw new Error('deploy_not_configured: SIGNER_URL missing — set SIGNER_URL (e.g. http://signer:3001) and SIGNER_MNEMONIC in signer/.env');
  }
  const codeHex = config.escrowContractCodeHex || ESCROW_CODE_HEX;
  if (!codeHex) {
    throw new Error(
      'deploy_not_configured: ESCROW_CONTRACT_CODE_HEX is empty — compile contracts/Escrow.tact and provide the code BOC hex',
    );
  }
  if (!config.adminAddress || !config.feeAddress) {
    throw new Error('deploy_not_configured: ADMIN_ADDRESS and FEE_ADDRESS are required');
  }

  let code: Cell;
  try {
    code = Cell.fromBoc(Buffer.from(codeHex, 'hex'))[0];
  } catch (err) {
    throw new Error(`deploy_not_configured: invalid ESCROW_CONTRACT_CODE_HEX (${String(err)})`);
  }

  let jettonMaster: Address | null = null;
  let contractJettonWallet: Address | null = null;
  // Resolve deployer (signer) address for jetton wallet derivation + Escrow owner
  let signerAddr: Address;
  try {
    signerAddr = Address.parse(await getSignerAddress());
  } catch (e) {
    throw new Error(`deploy_not_configured: signer unavailable (${String(e)}) — check signer service and SIGNER_API_KEY`);
  }

  if (assetType === 1) {
    const masterStr = config.jettonMasterAddress || config.usdtJettonAddress;
    if (!masterStr) {
      throw new Error('deploy_not_configured: JETTON_MASTER_ADDRESS is required for jetton deals');
    }
    jettonMaster = Address.parse(masterStr);
    try {
      contractJettonWallet = await computeJettonWalletAddress(jettonMaster, signerAddr);
    } catch {
      contractJettonWallet = null;
    }
    if (!contractJettonWallet) {
      throw new Error('deploy_not_configured: could not derive contract jetton wallet address (RPC unreachable?)');
    }
  }

  const escrow = Escrow.create({
    dealId,
    buyer,
    seller,
    admin: Address.parse(config.adminAddress),
    feeAddress: Address.parse(config.feeAddress),
    assetType,
    amount,
    feeBps: config.feeBps,
    deadline,
    jettonMaster,
    contractJettonWallet,
    owner: signerAddr,
    code,
  });

  // Delegate signing/sending to signer microservice
  const deployBodyCell = deployBody(0n);
  const stateInit = escrow.init;
  if (!stateInit) throw new Error('deploy_not_configured: escrow init missing (code?)');

  const codeBoc = stateInit.code.toBoc().toString('base64');
  const dataBoc = stateInit.data.toBoc().toString('base64');
  const bodyBoc = deployBodyCell.toBoc().toString('base64');

  await deployEscrowViaSigner({
    escrowAddress: escrow.address.toString(),
    escrowStateInit: { codeBoc, dataBoc },
    value: '0.12',
    bodyBoc,
  });

  return escrow.address.toString();
}
