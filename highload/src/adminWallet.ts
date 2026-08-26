import { Address, beginCell, Cell, internal as internalRelaxed, MessageRelaxed, SendMode, toNano } from '@ton/core';
import { TonClient, WalletContractV4 } from '@ton/ton';
import { KeyPair, mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getApiKey, getEndpoint, getNetwork, getWalletsDir, Network } from './config';

/**
 * Admin (backup) wallet - a regular WalletContractV4 used when the
 * highload wallet fails to send (RPC errors, external messages dropped,
 * contract stuck, etc). Lives in the same wallets dir as `<name>.admin.json`.
 */

export const DEFAULT_ADMIN_TRANSFER_VALUE_TON = '0.02';

export interface AdminWalletState {
    type: 'admin-v4';
    name: string;
    network: Network;
    mnemonic: string[];
    publicKey: string;
    workchain: number;
    address: string;
    createdAt: number;
}

/** Minimal structural view of a highload wallet needed for deployment */
export interface DeployableContract {
    address: Address;
    init?: { code: Cell; data: Cell };
}

export interface AdminTransferRequest {
    to: Address | string;
    value: bigint | string;
    body?: Cell | null;
    bounce?: boolean;
}

function resolveAddress(src: Address | string): Address {
    return typeof src === 'string' ? Address.parse(src) : src;
}

function resolveValue(src: bigint | string): bigint {
    return typeof src === 'string' ? toNano(src) : src;
}

export class AdminWallet {
    readonly contract: WalletContractV4;
    private client?: TonClient;

    protected constructor(readonly state: AdminWalletState, readonly keyPair: KeyPair) {
        this.contract = WalletContractV4.create({
            workchain: state.workchain,
            publicKey: keyPair.publicKey,
        });
        const derived = this.contract.address.toString({ urlSafe: true });
        if (
            state.address &&
            derived !== Address.parse(state.address).toString({ urlSafe: true })
        ) {
            throw new Error(`Admin wallet address mismatch: file says ${state.address}, derived ${derived}`);
        }
    }

    get publicKey(): Buffer {
        return Buffer.from(this.state.publicKey, 'hex');
    }

    get address(): Address {
        return this.contract.address;
    }

    get secretKey(): Buffer {
        return this.keyPair.secretKey;
    }

    // ------------------------------------------------------------------ //

    static async generate(opts?: { name?: string; network?: Network; mnemonic?: string[] }): Promise<AdminWallet> {
        const mnemonic = opts?.mnemonic ?? (await mnemonicNew(24));
        return AdminWallet.fromMnemonic(mnemonic, opts);
    }

    static async fromMnemonic(
        mnemonic: string[],
        opts?: { name?: string; network?: Network }
    ): Promise<AdminWallet> {
        if (mnemonic.length !== 24 || !mnemonic.every((w) => /^[a-z]+$/.test(w))) {
            throw new Error('Invalid mnemonic phrase (need 24 lowercase words)');
        }
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const state: AdminWalletState = {
            type: 'admin-v4',
            name: opts?.name ?? 'admin',
            network: opts?.network ?? getNetwork(),
            mnemonic,
            publicKey: keyPair.publicKey.toString('hex'),
            workchain: 0,
            address: '',
            createdAt: Math.floor(Date.now() / 1000),
        };
        const probe = new AdminWallet(state, keyPair);
        state.address = probe.address.toString({ urlSafe: true, bounceable: false });
        return probe;
    }

    static filePath(name: string): string {
        return path.join(getWalletsDir(), `${name}.admin.json`);
    }

    static exists(name: string): boolean {
        return fs.existsSync(AdminWallet.filePath(name));
    }

    static async load(name: string): Promise<AdminWallet> {
        const file = AdminWallet.filePath(name);
        if (!fs.existsSync(file)) {
            throw new Error(`Admin wallet file not found: ${file} (create with: npm run admin -- create ${name})`);
        }
        const state = JSON.parse(fs.readFileSync(file, 'utf8')) as AdminWalletState;
        if (state.type !== 'admin-v4') throw new Error(`${file} is not an admin wallet file`);
        const keyPair = await mnemonicToPrivateKey(state.mnemonic);
        return new AdminWallet(state, keyPair);
    }

    filePath(): string {
        return AdminWallet.filePath(this.state.name);
    }

    save(): this {
        const dir = getWalletsDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.filePath(), JSON.stringify(this.state, null, 2), 'utf8');
        return this;
    }

    // ------------------------------------------------------------------ //

    getClient(): TonClient {
        if (!this.client) {
            this.client = new TonClient({ endpoint: getEndpoint(), apiKey: getApiKey() });
        }
        return this.client;
    }

    open() {
        return this.getClient().open(this.contract);
    }

    async isDeployed(): Promise<boolean> {
        return (await this.getClient().getContractState(this.address)).state === 'active';
    }

    async getBalance(): Promise<bigint> {
        return (await this.getClient().getContractState(this.address)).balance;
    }

    /**
     * Self-transfer to initialize the admin wallet itself.
     */
    async deploy(value: bigint | string = '0.1'): Promise<void> {
        if (await this.isDeployed()) return;
        const opened = this.open();
        await opened.sendTransfer({
            secretKey: this.secretKey,
            seqno: await opened.getSeqno(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [
                internalRelaxed({
                    to: this.address,
                    value: resolveValue(value),
                    bounce: false,
                    body: beginCell().storeUint(0, 32).endCell(),
                }),
            ],
        });
    }

    /**
     * Send one or more transfers from the admin wallet.
     */
    async send(
        req: AdminTransferRequest | AdminTransferRequest[],
        opts?: { sendMode?: number }
    ): Promise<{ seqno: number; count: number }> {
        const list = Array.isArray(req) ? req : [req];
        if (list.length === 0) return { seqno: await this.openedSeqno(), count: 0 };

        const opened = this.open();
        const seqno = await opened.getSeqno();

        const messages: MessageRelaxed[] = list.map((r) =>
            internalRelaxed({
                to: resolveAddress(r.to),
                value: resolveValue(r.value),
                bounce: r.bounce ?? false,
                body: r.body ?? null,
            })
        );

        await opened.sendTransfer({
            secretKey: this.secretKey,
            seqno,
            sendMode: opts?.sendMode ?? SendMode.PAY_GAS_SEPARATELY,
            messages,
        });
        return { seqno, count: messages.length };
    }

    private async openedSeqno(): Promise<number> {
        try {
            return await this.open().getSeqno();
        } catch {
            return 0;
        }
    }

    /**
     * Deploy the highload wallet via an internal message with StateInit
     * attached - a reliable alternative to external-StateInit deployment.
     */
    async deployHighload(target: DeployableContract, value: bigint | string = '0.05'): Promise<void> {
        if (!target.init) throw new Error('Target contract has no init (already deployed?)');
        const opened = this.open();
        await opened.sendTransfer({
            secretKey: this.secretKey,
            seqno: await opened.getSeqno(),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            messages: [
                internalRelaxed({
                    to: target.address,
                    value: resolveValue(value),
                    bounce: false,
                    init: { code: target.init.code, data: target.init.data },
                    body: beginCell().endCell(),
                }),
            ],
        });
    }
}
