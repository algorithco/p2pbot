import { Address, Cell, beginCell, toNano, SendMode } from '@ton/core';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey, KeyPair } from '@ton/crypto';
import { config } from './config';
import logger from './logger';

const TONCENTER_MAINNET = 'https://toncenter.com/api/v2/jsonRPC';
const TONCENTER_TESTNET = 'https://testnet.toncenter.com/api/v2/jsonRPC';

function resolveEndpoint(): string {
  if (config.tonApiEndpoint && config.tonApiEndpoint.trim() !== '') {
    return config.tonApiEndpoint.trim();
  }
  return config.network === 'testnet' ? TONCENTER_TESTNET : TONCENTER_MAINNET;
}

export class W5Signer {
  private client: TonClient;
  private wallet: WalletContractV5R1 | null = null;
  private keyPair: KeyPair | null = null;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.client = new TonClient({
      endpoint: resolveEndpoint(),
      apiKey: config.toncenterApiKey || undefined,
    });
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (!config.mnemonic || config.mnemonic.length !== 24) {
        logger.warn('SIGNER_MNEMONIC not configured (need 24 words) — signer in no-wallet mode');
        return;
      }
      try {
        const kp = await mnemonicToPrivateKey(config.mnemonic);
        this.keyPair = kp;
        this.wallet = WalletContractV5R1.create({
          publicKey: kp.publicKey,
          workchain: config.workchain,
        });
        logger.info(`W5 wallet initialized: ${this.wallet.address.toString({ urlSafe: true, bounceable: false })} (workchain ${config.workchain})`);
      } catch (e) {
        logger.error('Failed to init W5 wallet', e);
        throw e;
      }
    })();
    return this.initPromise;
  }

  getAddress(): Address | null {
    return this.wallet ? this.wallet.address : null;
  }

  getAddressString(): string | null {
    const addr = this.getAddress();
    return addr ? addr.toString({ urlSafe: true, bounceable: false }) : null;
  }

  isConfigured(): boolean {
    return this.wallet !== null && this.keyPair !== null;
  }

  private assertConfigured(): { wallet: WalletContractV5R1; keyPair: KeyPair } {
    if (!this.wallet || !this.keyPair) {
      throw new Error('wallet_not_configured: SIGNER_MNEMONIC missing or invalid (need 24 words)');
    }
    return { wallet: this.wallet, keyPair: this.keyPair };
  }

  getClient(): TonClient {
    return this.client;
  }

  async getState(): Promise<{ deployed: boolean; balance: bigint; address: string | null }> {
    const addr = this.getAddress();
    if (!addr) return { deployed: false, balance: 0n, address: null };
    const st = await this.client.getContractState(addr);
    return {
      deployed: st.state === 'active',
      balance: st.balance,
      address: this.getAddressString(),
    };
  }

  async getSeqno(): Promise<number> {
    const { wallet } = this.assertConfigured();
    const provider = this.client.provider(wallet.address, null);
    return wallet.getSeqno(provider);
  }

  async getBalance(): Promise<bigint> {
    const addr = this.getAddress();
    if (!addr) return 0n;
    return (await this.client.getContractState(addr)).balance;
  }

  async isDeployed(): Promise<boolean> {
    const addr = this.getAddress();
    if (!addr) return false;
    return (await this.client.getContractState(addr)).state === 'active';
  }

  async deploy(value: string = '0.05'): Promise<{ seqno: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    if (await this.isDeployed()) {
      throw new Error('already_deployed');
    }
    const balance = await this.getBalance();
    const needed = toNano(value);
    // W5 deploy needs enough for self-transfer + fees (~0.02 TON)
    if (balance < needed + toNano('0.02')) {
      throw new Error(
        `insufficient_balance: have ${balance} nano, need ${needed + toNano('0.02')} (send TON to ${wallet.address.toString({ urlSafe: true, bounceable: false })})`
      );
    }
    const provider = this.client.provider(wallet.address, null);
    const seqno = await wallet.getSeqno(provider);
    // Try simple deploy via empty transfer with sendMode; many W5 implementations deploy via seqno tx even with no messages.
    // Fallback is self-transfer if seqno didn't advance.
    const { internal } = await import('@ton/ton');
    try {
      await wallet.sendTransfer(provider, {
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        messages: [
          internal({
            to: wallet.address,
            value: toNano(value),
            bounce: false,
            body: beginCell().endCell(),
          }),
        ],
      });
    } catch (e) {
      // If custom deploy fails, propagate
      throw e;
    }
    return { seqno };
  }

  async send(req: { to: string; value: string; body?: string | null; bounce?: boolean; comment?: string }): Promise<{ seqno: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    const toAddr = Address.parse(req.to);
    const value = toNano(req.value);
    if (value <= 0n) throw new Error('value must be > 0');

    let body: Cell | undefined;
    if (req.body) {
      try {
        body = Cell.fromBoc(Buffer.from(req.body, 'base64'))[0];
      } catch {
        // treat as comment
        body = beginCell().storeUint(0, 32).storeStringTail(req.body).endCell();
      }
    } else if (req.comment) {
      body = beginCell().storeUint(0, 32).storeStringTail(req.comment).endCell();
    }

    const { internal } = await import('@ton/ton');
    const provider = this.client.provider(wallet.address, null);
    const seqno = await wallet.getSeqno(provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: toAddr,
          value,
          bounce: req.bounce ?? false,
          body,
        }),
      ],
    });

    return { seqno };
  }

  async sendBatch(requests: Array<{ to: string; value: string; comment?: string }>): Promise<{ seqno: number; count: number }> {
    const { wallet, keyPair } = this.assertConfigured();
    if (requests.length === 0) throw new Error('empty batch');
    if (requests.length > 255) throw new Error('batch too large (max 255)');

    const { internal } = await import('@ton/ton');

    const messages = requests.map((r) => {
      const addr = Address.parse(r.to);
      const val = toNano(r.value);
      let body: Cell | undefined;
      if (r.comment) body = beginCell().storeUint(0, 32).storeStringTail(r.comment).endCell();
      return internal({
        to: addr,
        value: val,
        bounce: false,
        body,
      });
    });

    const provider = this.client.provider(wallet.address, null);
    const seqno = await wallet.getSeqno(provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages,
    });

    return { seqno, count: messages.length };
  }

  /**
   * Sign and send a custom internal message carrying StateInit + body.
   * Used by backend's Escrow deployer: needs to send Deploy{queryId} body to escrow address with StateInit.
   */
  async sendEscrowDeploy(params: {
    escrowAddress: string;
    escrowStateInit: { codeBoc: string; dataBoc: string }; // base64 BOCs
    value?: string; // default 0.12 TON
    bodyBoc?: string | null; // optional body cell boc base64 (Deploy{queryId})
  }): Promise<{ seqno: number; escrowAddress: string }> {
    const { wallet, keyPair } = this.assertConfigured();
    const toAddr = Address.parse(params.escrowAddress);
    const code = Cell.fromBoc(Buffer.from(params.escrowStateInit.codeBoc, 'base64'))[0];
    const data = Cell.fromBoc(Buffer.from(params.escrowStateInit.dataBoc, 'base64'))[0];
    const value = toNano(params.value || '0.12');
    let body: Cell | undefined;
    if (params.bodyBoc) {
      try {
        body = Cell.fromBoc(Buffer.from(params.bodyBoc, 'base64'))[0];
      } catch (e) {
        throw new Error(`invalid bodyBoc: ${String(e)}`);
      }
    } else {
      body = beginCell().storeUint(0, 32).storeUint(0, 64).endCell(); // Deploy{queryId=0}
    }

    const { internal } = await import('@ton/ton');
    const provider = this.client.provider(wallet.address, null);
    const seqno = await wallet.getSeqno(provider);

    await wallet.sendTransfer(provider, {
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: toAddr,
          value,
          bounce: false,
          init: { code, data },
          body,
        }),
      ],
    });

    return { seqno, escrowAddress: toAddr.toString() };
  }
}

export const signer = new W5Signer();
