import * as fs from 'fs';
import * as path from 'path';
import {
    Address,
    beginCell,
    Cell,
    internal as internalRelaxed,
    MessageRelaxed,
    OutActionSendMsg,
    SendMode,
    storeMessage,
    storeMessageRelaxed,
    toNano,
} from '@ton/core';
import { TonClient } from '@ton/ton';
import { KeyPair, mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { HighloadWalletV3, RECOMMENDED_SUBWALLET_ID, HighloadWalletV3Code } from './HighloadWalletV3';
import { HighloadQueryId } from './HighloadQueryId';
import { buildNftTransferBody, DEFAULT_NFT_FORWARD_TON, DEFAULT_NFT_VALUE_TON, NftTransferOptions, parseNftData, NftInfo } from './nft';
import { AdminWallet } from './adminWallet';
import { getEndpoint, getApiKey, getNetwork, getWalletsDir, Network } from './config';

/** Max actions per single external message (deeper batches are packed recursively by the wrapper) */
export const MAX_ACTIONS_PER_MSG = 254;

/** Default timeout: 1 hour (official README recommends 1h..24h) */
export const DEFAULT_TIMEOUT = 60 * 60;

/**
 * Safety margin subtracted from local unixtime when building created_at.
 * The contract REJECTS created_at > chain-now (error 35) - validators then
 * silently drop the external message. A small backward margin makes us
 * tolerant to local clock skew ahead of chain time; being slightly "old"
 * is harmless because the validity window is >= timeout (>= 1 hour).
 */
export const CREATED_AT_MARGIN_S = 15;

/** Minimum extra TON needed on top of a deploy self-transfer (gas + storage) */
export const DEPLOY_MIN_EXTRA_TON = '0.02';

export interface HighloadWalletState {
    name: string;
    network: Network;
    mnemonic: string[];
    publicKey: string;
    workchain: number;
    subwalletId: number;
    timeout: number;
    /** user-friendly non-bounceable urlSafe form */
    address: string;
    createdAt: number;
    /** Next unused query id, stored as seqno [0..8380415] */
    nextSeqno: number;
}

export interface TransferRequest {
    to: Address | string;
    value: bigint | string;
    body?: Cell | null;
    bounce?: boolean;
}

interface SendOptions {
    createdAt?: number;
    queryId?: HighloadQueryId;
    /** override send mode (e.g. CARRY_ALL_REMAINING_BALANCE for sweeps) */
    mode?: number;
}

export interface SendResult {
    queryId: HighloadQueryId;
    createdAt: number;
}

export type SendRoute = 'highload' | 'admin';

export interface SmartSendResult extends SendResult {
    route: SendRoute;
    /** true when highload attempts all failed and admin wallet was used */
    fellBack: boolean;
    error?: string;
}

function resolveAddress(src: Address | string): Address {
    return typeof src === 'string' ? Address.parse(src) : src;
}

function resolveValue(src: bigint | string): bigint {
    return typeof src === 'string' ? toNano(src) : src;
}

/**
 * High-level TON Highload Wallet v3 manager.
 * Handles creation, persistence, deployment, single & batch transfers.
 *
 * Contract: https://github.com/ton-blockchain/highload-wallet-contract-v3
 *
 * Receiving: recv_internal accepts ANY incoming TON unconditionally
 * (only self-sent op::internal_transfer messages trigger logic),
 * so the contract can safely hold arbitrarily large balances.
 */
export class HighloadWallet {
    readonly contract: HighloadWalletV3;
    private client?: TonClient;

    protected constructor(readonly state: HighloadWalletState, readonly keyPair: KeyPair) {
        this.contract = HighloadWalletV3.createFromConfig(
            {
                publicKey: this.publicKey,
                subwalletId: state.subwalletId,
                timeout: state.timeout,
            },
            HighloadWalletV3Code,
            state.workchain
        );
        const derived = this.contract.address.toString({ urlSafe: true });
        if (
            state.address &&
            derived !== Address.parse(state.address).toString({ urlSafe: true })
        ) {
            throw new Error(
                `Address mismatch: file says ${state.address}, derived ${derived}. ` +
                    `Did publicKey/subwalletId/timeout change after deployment?`
            );
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
    //  Creation & persistence                                            //
    // ------------------------------------------------------------------ //

    /**
     * Create a brand-new wallet (generates a fresh 24-word mnemonic).
     */
    static async generate(opts?: {
        name?: string;
        timeout?: number;
        subwalletId?: number;
        workchain?: number;
        network?: Network;
        mnemonic?: string[];
    }): Promise<HighloadWallet> {
        const mnemonic = opts?.mnemonic ?? (await mnemonicNew(24));
        return HighloadWallet.fromMnemonic(mnemonic, opts);
    }

    /**
     * Build a wallet from an existing 24-word mnemonic.
     */
    static async fromMnemonic(
        mnemonic: string[],
        opts?: {
            name?: string;
            timeout?: number;
            subwalletId?: number;
            workchain?: number;
            network?: Network;
        }
    ): Promise<HighloadWallet> {
        if (!(await HighloadWallet.isValidMnemonic(mnemonic))) {
            throw new Error('Invalid mnemonic phrase (need 24 lowercase words)');
        }
        const keyPair = await mnemonicToPrivateKey(mnemonic);
        const state: HighloadWalletState = {
            name: opts?.name ?? 'wallet',
            network: opts?.network ?? getNetwork(),
            mnemonic,
            publicKey: keyPair.publicKey.toString('hex'),
            workchain: opts?.workchain ?? 0,
            subwalletId: opts?.subwalletId ?? RECOMMENDED_SUBWALLET_ID,
            timeout: opts?.timeout ?? DEFAULT_TIMEOUT,
            address: '',
            createdAt: Math.floor(Date.now() / 1000),
            nextSeqno: 0,
        };
        const probe = new HighloadWallet(state, keyPair);
        state.address = probe.address.toString({ urlSafe: true, bounceable: false });
        return probe;
    }

    /**
     * Fresh created_at with clock-skew safety margin applied.
     */
    static freshCreatedAt(nowMs: number = Date.now()): number {
        return Math.floor(nowMs / 1000) - CREATED_AT_MARGIN_S;
    }

    static async isValidMnemonic(mnemonic: string[]): Promise<boolean> {
        return mnemonic.length === 24 && mnemonic.every((w) => /^[a-z]+$/.test(w));
    }

    static filePath(name: string): string {
        return path.join(getWalletsDir(), `${name}.json`);
    }

    static exists(name: string): boolean {
        return fs.existsSync(HighloadWallet.filePath(name));
    }

    /**
     * Load a previously created wallet from wallets/<name>.json
     */
    static async load(name: string): Promise<HighloadWallet> {
        const file = HighloadWallet.filePath(name);
        if (!fs.existsSync(file)) {
            throw new Error(`Wallet file not found: ${file}`);
        }
        const state = JSON.parse(fs.readFileSync(file, 'utf8')) as HighloadWalletState;
        const keyPair = await mnemonicToPrivateKey(state.mnemonic);
        return new HighloadWallet(state, keyPair);
    }

    filePath(): string {
        return HighloadWallet.filePath(this.state.name);
    }

    save(): this {
        const dir = getWalletsDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.filePath(), JSON.stringify(this.state, null, 2), 'utf8');
        return this;
    }

    // ------------------------------------------------------------------ //
    //  Network                                                           //
    // ------------------------------------------------------------------ //

    getClient(): TonClient {
        if (!this.client) {
            this.client = new TonClient({
                endpoint: getEndpoint(),
                apiKey: getApiKey(),
            });
        }
        return this.client;
    }

    async isDeployed(): Promise<boolean> {
        return (await this.getClient().getContractState(this.address)).state === 'active';
    }

    async getBalance(): Promise<bigint> {
        return (await this.getClient().getContractState(this.address)).balance;
    }

    async getOnChainInfo(): Promise<{
        deployed: boolean;
        balance: bigint;
        publicKey?: Buffer;
        subwalletId?: number;
        timeout?: number;
        lastCleaned?: number;
    }> {
        const client = this.getClient();
        const st = await client.getContractState(this.address);
        const base = { deployed: st.state === 'active', balance: st.balance };
        if (!base.deployed) return base;
        const provider = client.provider(this.contract.address, null);
        return {
            ...base,
            publicKey: await this.contract.getPublicKey(provider),
            subwalletId: await this.contract.getSubwalletId(provider),
            timeout: await this.contract.getTimeout(provider),
            lastCleaned: await this.contract.getLastCleaned(provider),
        };
    }

    /**
     * Reserve the next unique query id and persist it BEFORE sending.
     * This guarantees a crashed/restarted service can never reuse a query id
     * inside the current timeout window (replay protection).
     *
     * NOTE: run a single sender process per wallet - concurrent processes
     * would race on nextSeqno.
     */
    takeNextQueryId(): HighloadQueryId {
        const seqno = BigInt(Math.max(0, this.state.nextSeqno));
        const qid = HighloadQueryId.fromSeqno(seqno);
        if (qid.hasNext()) {
            this.state.nextSeqno = Number(qid.getNext().toSeqno());
        } else {
            this.state.nextSeqno = 0; // wrap around (dictionary rotates after `timeout`)
        }
        fs.writeFileSync(this.filePath(), JSON.stringify(this.state, null, 2), 'utf8');
        return qid;
    }

    // ------------------------------------------------------------------ //
    //  Signed external messages                                          //
    // ------------------------------------------------------------------ //

    /**
     * Build the signed inner cell of an external message:
     *   subwallet_id(32) ref(message) mode(8) query_id(23) created_at(64) timeout(22)
     *
     * Layout verified against contracts/highload-wallet-v3.func recv_external:
     * uint32 subwallet -> ref -> uint8 mode -> uint13 shift -> uint10 bitnumber
     * -> uint64 created_at -> uint22 timeout.
     */
    buildSignedInner(opts: {
        message: MessageRelaxed | Cell;
        mode: number;
        queryId: bigint | HighloadQueryId;
        createdAt: number;
    }): Cell {
        let messageCell: Cell;
        if (opts.message instanceof Cell) {
            messageCell = opts.message;
        } else {
            messageCell = beginCell().store(storeMessageRelaxed(opts.message)).endCell();
        }
        const queryId = opts.queryId instanceof HighloadQueryId ? opts.queryId.getQueryId() : opts.queryId;
        if (queryId < 0n || queryId >= 2n ** 23n) throw new Error('query_id must fit in 23 bits');

        return beginCell()
            .storeUint(this.state.subwalletId, 32)
            .storeRef(messageCell)
            .storeUint(opts.mode, 8)
            .storeUint(queryId, 23)
            .storeUint(opts.createdAt, 64)
            .storeUint(this.state.timeout, 22)
            .endCell();
    }

    /**
     * Full external-in Message cell (signature + ref(inner)), optionally
     * carrying StateInit so it can initialize an uninited account.
     */
    buildExternalMessage(opts: { inner: Cell; attachInit?: boolean }): Cell {
        const signed = beginCell()
            .storeBuffer(signInner(opts.inner.hash(), this.secretKey))
            .storeRef(opts.inner)
            .endCell();

        return beginCell()
            .store(
                storeMessage({
                    info: { type: 'external-in', dest: this.address, importFee: 0n },
                    init:
                        opts.attachInit && this.contract.init
                            ? { code: this.contract.init.code, data: this.contract.init.data }
                            : undefined,
                    body: signed,
                })
            )
            .endCell();
    }

    // ------------------------------------------------------------------ //
    //  Deployment                                                        //
    // ------------------------------------------------------------------ //

    /**
     * Deploy the wallet by sending an external message carrying StateInit.
     * The attached self-transfer initializes the account and executes at once.
     *
     * Fund the address with at least `value` + ~0.02 TON for fees first.
     */
    async deploy(value: bigint | string = '0.05'): Promise<SendResult> {
        if (await this.isDeployed()) {
            throw new Error('Wallet is already deployed');
        }
        const balance = await this.getBalance();
        const need = resolveValue(value) + toNano(DEPLOY_MIN_EXTRA_TON);
        if (balance < need) {
            throw new Error(
                `Insufficient balance for deploy: have ${balance} nanoTON, need >= ${need} ` +
                    `(self-transfer ${resolveValue(value)} + ${DEPLOY_MIN_EXTRA_TON} fees). ` +
                    `Send TON to ${this.address.toString({ urlSafe: true, bounceable: false })} first.`
            );
        }

        const queryId = this.takeNextQueryId();
        const createdAt = HighloadWallet.freshCreatedAt();

        const message: MessageRelaxed = internalRelaxed({
            to: this.address,
            value: resolveValue(value),
            bounce: false,
            body: beginCell().storeUint(0, 32).endCell(), // empty text comment
        });

        const inner = this.buildSignedInner({
            message,
            mode: SendMode.PAY_GAS_SEPARATELY,
            queryId,
            createdAt,
        });
        const fullMessage = this.buildExternalMessage({ inner, attachInit: true });

        await this.getClient().sendFile(await fullMessage.toBoc());
        return { queryId, createdAt };
    }

    // ------------------------------------------------------------------ //
    //  Transfers                                                         //
    // ------------------------------------------------------------------ //

    /**
     * Build an outbound relaxed internal message.
     * Complies with contract validation: int_msg_info$0, src=addr_none,
     * no state-init allowed, no extra currencies.
     */
    private makeOutMessage(req: TransferRequest): MessageRelaxed {
        return internalRelaxed({
            to: resolveAddress(req.to),
            value: resolveValue(req.value),
            bounce: req.bounce ?? false,
            body: req.body ?? null,
        });
    }

    /**
     * Send a single transfer DIRECTLY through recv_external
     * (one transaction, minimal fee - official pattern).
     *
     * The contract commits the query id BEFORE sending, then executes
     * send_raw_message(msg, mode | IGNORE_ERRORS).
     */
    async send(req: TransferRequest, opts?: SendOptions): Promise<SendResult> {
        const provider = this.getClient().provider(this.contract.address, null);

        const queryId = opts?.queryId ?? this.takeNextQueryId();
        const createdAt = opts?.createdAt ?? HighloadWallet.freshCreatedAt();

        await this.contract.sendExternalMessage(provider, this.secretKey, {
            message: this.makeOutMessage(req),
            mode: opts?.mode ?? SendMode.PAY_GAS_SEPARATELY,
            query_id: queryId,
            createdAt,
            subwalletId: this.state.subwalletId,
            timeout: this.state.timeout,
        });
        return { queryId, createdAt };
    }

    /**
     * Send many transfers in batches (<=254 actions per external message,
     * one unique query id per batch). Uses the official two-phase pattern:
     * external msg -> self internal_transfer -> actions executed in tx2.
     * Each batch outer-message carries CARRY_ALL_REMAINING_BALANCE so the
     * full working balance backs every outgoing transfer; whatever is not
     * spent stays in the wallet.
     */
    async sendBatch(
        requests: TransferRequest[],
        opts?: { createdAt?: number; perActionMode?: number }
    ): Promise<Array<SendResult & { count: number }>> {
        if (requests.length === 0) return [];
        const provider = this.getClient().provider(this.contract.address, null);
        const result: Array<SendResult & { count: number }> = [];
        const createdAt = opts?.createdAt ?? HighloadWallet.freshCreatedAt();

        for (let i = 0; i < requests.length; i += MAX_ACTIONS_PER_MSG) {
            const chunk = requests.slice(i, i + MAX_ACTIONS_PER_MSG);
            const actions: OutActionSendMsg[] = chunk.map((r) => ({
                type: 'sendMsg',
                mode: opts?.perActionMode ?? SendMode.PAY_GAS_SEPARATELY,
                outMsg: this.makeOutMessage(r),
            }));
            const queryId = this.takeNextQueryId();
            await this.contract.sendBatch(
                provider,
                this.secretKey,
                actions,
                this.state.subwalletId,
                queryId,
                this.state.timeout,
                createdAt
            );
            result.push({ queryId, createdAt, count: chunk.length });
        }
        return result;
    }

    /**
     * True when the given query_id has ALREADY been consumed by the contract.
     * (`processed?` returns TRUE iff the bit for this query id is set in the
     * current or previous period dictionary.)
     */
    async isProcessed(queryId: HighloadQueryId, needClean = false): Promise<boolean> {
        const provider = this.getClient().provider(this.contract.address, null);
        return this.contract.getProcessed(provider, queryId, needClean);
    }

    /**
     * Poll until the given query id is marked processed on-chain.
     */
    async waitForProcessed(
        queryId: HighloadQueryId,
        opts?: { intervalMs?: number; timeoutMs?: number; needClean?: boolean }
    ): Promise<boolean> {
        const deadline = Date.now() + (opts?.timeoutMs ?? 90_000);
        const interval = Math.min(opts?.intervalMs ?? 3000, Math.max(250, Math.floor((opts?.timeoutMs ?? 90_000) / 6)));
        while (Date.now() < deadline) {
            try {
                if (await this.isProcessed(queryId, opts?.needClean ?? false)) return true;
            } catch {
                // transient rpc error - keep polling
            }
            await sleep(interval);
        }
        return false;
    }

    // ------------------------------------------------------------------ //
    //  Emergency: admin wallet fallback & sweep                          //
    // ------------------------------------------------------------------ //

    /**
     * Send with automatic failover:
     *   1. try sending via the highload wallet `attempts` times
     *      (same query_id & created_at on retries = replay-safe),
     *   2. optionally confirm on-chain (`confirmTimeoutMs`),
     *   3. if everything failed - route the same transfer through the
     *      admin's regular v4 wallet.
     *
     * Use this in production loops where a payout MUST go out even if the
     * highload path is broken.
     */
    async sendSmart(
        req: TransferRequest,
        opts?: SendOptions & {
            /** highload attempts before falling back (default 3) */
            attempts?: number;
            /** wait for on-chain confirmation between attempts */
            confirmTimeoutMs?: number;
            /** name or instance of the admin wallet used as backup sender */
            admin?: string | AdminWallet;
        }
    ): Promise<SmartSendResult> {
        const attempts = opts?.attempts ?? 3;
        let lastError = '';

        const queryId = opts?.queryId ?? this.takeNextQueryId();
        const createdAt = opts?.createdAt ?? HighloadWallet.freshCreatedAt();

        for (let i = 0; i < Math.max(1, attempts); i++) {
            try {
                await this.send(req, { ...opts, queryId, createdAt });
                if (!opts?.confirmTimeoutMs) {
                    return { queryId, createdAt, route: 'highload', fellBack: false };
                }
                const okChain = await this.waitForProcessed(queryId, {
                    timeoutMs: opts.confirmTimeoutMs,
                    needClean: false,
                });
                if (okChain) return { queryId, createdAt, route: 'highload', fellBack: false };
                lastError = 'not confirmed within confirmTimeoutMs';
            } catch (e: any) {
                lastError = e?.message ?? String(e);
                console.error(`[sendSmart] highload attempt ${i + 1}/${attempts} failed: ${lastError}`);
                await sleep(500 * (i + 1));
            }
        }

        const admin = typeof opts?.admin === 'string' ? await AdminWallet.load(opts.admin) : opts?.admin;
        if (!admin) {
            throw new Error(
                `[sendSmart] all highload attempts failed (${lastError}) and no admin wallet configured - ` +
                    `transfer NOT sent. Configure --admin or pass admin wallet.`
            );
        }
        await admin.send(req);
        const adminAddr = (admin as any).address?.toString?.() ?? '<admin>';
        console.warn(`[sendSmart] FALLBACK: transfer routed via admin wallet ${adminAddr}`);
        return { queryId, createdAt, route: 'admin', fellBack: true, error: lastError };
    }

    /**
     * EMERGENCY: move the ENTIRE balance out of the highload wallet using
     * CARRY_ALL_REMAINING_BALANCE (e.g. to the admin wallet address when
     * the service must be stopped / migrated). The destination keeps
     * whatever is left after gas.
     */
    async sweepAllTo(to: Address | string, body?: Cell | null): Promise<SendResult> {
        return this.send({ to, value: 0n, bounce: false, body }, { mode: SendMode.CARRY_ALL_REMAINING_BALANCE });
    }

    // ------------------------------------------------------------------ //
    //  NFTs (TEP-62): receive / store / send                             //
    // ------------------------------------------------------------------ //

    /**
     * Receiving & storing NFTs needs NO action: an incoming NFT transfer
     * only changes ownership_address inside the item contract; plain TON
     * notifications are accepted automatically by recv_internal.
     * Use getNftInfo() to verify what this wallet owns.
     */

    /**
     * Transfer an NFT item from this wallet to a new owner (TEP-62).
     */
    async sendNft(
        opts: Omit<NftTransferOptions, 'queryId'>,
        sendOpts?: SendOptions
    ): Promise<SendResult> {
        const nftAddress =
            typeof opts.nftAddress === 'string' ? Address.parse(opts.nftAddress) : opts.nftAddress;

        // sanity: we should own it
        const info = await this.getNftInfo(nftAddress);
        if (info.deployed && info.owner && !info.owner.equals(this.address)) {
            throw new Error(
                `NFT ${nftAddress.toString()} is not owned by this wallet ` +
                    `(owner: ${info.owner.toString()}) - refusing to send`
            );
        }

        const body = buildNftTransferBody({
            queryId: sendOpts?.queryId?.getQueryId() ?? BigInt(Math.floor(Date.now() / 1000)),
            newOwner: resolveAddress(opts.newOwner),
            responseAddress: resolveAddrOpt(opts.responseAddress ?? this.address),
            forwardAmount: resolveValue(opts.forwardAmount ?? DEFAULT_NFT_FORWARD_TON),
            forwardPayload: opts.forwardPayload ?? null,
        });

        return this.send(
            {
                to: nftAddress,
                value: resolveValue((opts as any).value ?? DEFAULT_NFT_VALUE_TON),
                body,
                bounce: false, // never bounce NFT transfers back
            },
            sendOpts
        );
    }

    /**
     * Transfer many NFT items (one outgoing message per item, packed into batches).
     */
    async sendNfts(
        list: Array<Omit<NftTransferOptions, 'queryId'>>,
        opts?: { createdAt?: number }
    ): Promise<Array<SendResult & { count: number }>> {
        const requests: TransferRequest[] = [];
        for (const item of list) {
            const nftAddress =
                typeof item.nftAddress === 'string' ? Address.parse(item.nftAddress) : item.nftAddress;
            requests.push({
                to: nftAddress,
                value: resolveValue((item as any).value ?? DEFAULT_NFT_VALUE_TON),
                bounce: false,
                body: buildNftTransferBody({
                    queryId: BigInt(Math.floor(Date.now() / 1000)),
                    newOwner: resolveAddress(item.newOwner),
                    responseAddress: resolveAddrOpt(item.responseAddress ?? this.address),
                    forwardAmount: resolveValue(item.forwardAmount ?? DEFAULT_NFT_FORWARD_TON),
                    forwardPayload: item.forwardPayload ?? null,
                }),
            });
        }
        return this.sendBatch(requests, opts);
    }

    /**
     * Read get_nft_data() from an NFT item contract to verify
     * ownership ("storing") state.
     */
    async getNftInfo(nftAddress: Address | string): Promise<NftInfo> {
        const addr = typeof nftAddress === 'string' ? Address.parse(nftAddress) : nftAddress;
        const client = this.getClient();
        const st = await client.getContractState(addr);
        if (st.state !== 'active') {
            return { deployed: false, init: null, index: null, collection: null, owner: null };
        }
        const provider = client.provider(addr, null);
        const res = await provider.get('get_nft_data', []);
        return parseNftData(res.stack as any);
    }

    /**
     * List nothing here - TON has no enumeration get-method; track owned
     * NFT addresses in your DB and call getNftInfo() per item.
     */
}

// ---------------------------------------------------------------------- //
//  Helpers                                                               //
// ---------------------------------------------------------------------- //

function resolveAddrOpt(src: Address | string | null | undefined): Address | null {
    if (!src) return null;
    return typeof src === 'string' ? Address.parse(src) : src;
}

// ---------------------------------------------------------------------- //
//  Helpers                                                               //
// ---------------------------------------------------------------------- //

function signInner(hash: Buffer, secretKey: Buffer): Buffer {
    // lazy import to avoid circular deps in tests
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sign } = require('@ton/crypto') as typeof import('@ton/crypto');
    return sign(hash, secretKey);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
