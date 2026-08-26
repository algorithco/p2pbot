// P2P escrow contract (TON / jetton deals) — Tact ^1.5
//
// Design notes:
// - All externally reachable logic lives in receive()/bounced() handlers;
//   Tact has no Solidity-style `external` functions.
// - Jetton opcodes are pinned with explicit message(0x…) annotations (TEP-74).
//   Declaring opcodes as plain constants would NOT wire them up: Tact derives
//   message opcodes from message names unless annotated.
// - `owner` is passed as an init parameter: init() cannot read ctx.sender, so
//   the deployer wallet address is supplied by the deploy transaction.
// - `deadline` arrives as an init param but stays MUTABLE — only the admin
//   ExtendDeadline operation may move it forward.
// - TON deposits: value beyond amount + STORAGE_RESERVE is intentionally kept
//   by the contract as storage/gas headroom instead of bouncing excess back.
// - Jetton release: the FULL amount is transferred to the seller's jetton
//   wallet; the platform fee split is performed OFF-CHAIN. This documented
//   simplification keeps the contract free of partial-transfer failure states.
// - Checks-effects-interactions throughout: status flips BEFORE any sends, and
//   a bounced payout reverts the terminal status back to DEPOSITED for retry.
import "@stdlib/deploy";

message(0x7362d09c) JettonNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

message(0x0f8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x65787464) ExtendDeadline {
    newDeadline: Int as uint32;
}

// ----- Deal statuses -----
const STATUS_AWAITING_DEPOSIT: Int = 0;
const STATUS_DEPOSITED: Int = 1;
const STATUS_RELEASED: Int = 2;
const STATUS_REFUNDED: Int = 3;

// ----- Asset types -----
const ASSET_TON: Int = 0;
const ASSET_JETTON: Int = 1;

// Kept behind after every payout to cover storage debt.
const STORAGE_RESERVE: Int = ton("0.02");
// Attached to each outgoing jetton transfer (covers wallet chain + forward).
const JETTON_OP_GAS: Int = ton("0.06");
// Forward notification amount carried inside the jetton transfer.
const JETTON_FORWARD_TON: Int = ton("0.01");

contract Escrow with Deployable {
    // ----- Immutable deal parameters (set once in init) -----
    dealId: Int as uint64;
    buyer: Address;
    seller: Address;
    admin: Address;
    feeAddress: Address;
    assetType: Int as uint8;          // 0 = TON, 1 = jetton
    amount: Int as coins;
    feeBps: Int as uint16;            // basis points, <= 10000 enforced in init
    jettonMaster: Address?;
    contractJettonWallet: Address?;   // this contract's jetton wallet

    // ----- Mutable runtime state -----
    deadline: Int as uint32;          // admin may extend via ExtendDeadline
    status: Int as uint8;
    depositTimestamp: Int as uint32;
    buyerConfirmed: Bool;
    sellerConfirmed: Bool;
    buyerJettonWallet: Address?;
    paused: Bool;
    owner: Address;

    init(
        dealId: Int,
        buyer: Address,
        seller: Address,
        admin: Address,
        feeAddress: Address,
        assetType: Int,
        amount: Int,
        feeBps: Int,
        deadline: Int,
        jettonMaster: Address?,
        contractJettonWallet: Address?,
        owner: Address
    ) {
        require(feeBps <= 10000, "Escrow: feeBps exceeds 10000");
        require(amount > 0, "Escrow: amount must be positive");
        require(deadline > 0, "Escrow: deadline must be positive");

        self.dealId = dealId;
        self.buyer = buyer;
        self.seller = seller;
        self.admin = admin;
        self.feeAddress = feeAddress;
        self.assetType = assetType;
        self.amount = amount;
        self.feeBps = feeBps;
        self.deadline = deadline;
        self.jettonMaster = jettonMaster;
        self.contractJettonWallet = contractJettonWallet;
        self.owner = owner;

        self.status = STATUS_AWAITING_DEPOSIT;
        self.depositTimestamp = 0;
        self.buyerConfirmed = false;
        self.sellerConfirmed = false;
        self.buyerJettonWallet = null;
        self.paused = false;
    }

    // ---------- Internal guards ----------

    fun requireNotPaused() {
        require(!self.paused, "Escrow: paused");
    }

    fun requireAdmin(from: Address) {
        require(from == self.admin, "Escrow: only admin");
    }

    // ---------- Deposits ----------

    // Plain TON transfer (empty body) from the buyer fills the escrow.
    receive() {
        self.requireNotPaused();
        require(self.assetType == ASSET_TON, "Escrow: not a TON deal");
        require(self.status == STATUS_AWAITING_DEPOSIT, "Escrow: wrong status");
        require(ctx.sender == self.buyer, "Escrow: only buyer may deposit");
        require(context().value >= self.amount + STORAGE_RESERVE, "Escrow: insufficient value");

        self.status = STATUS_DEPOSITED;
        self.depositTimestamp = now();
        self.buyerConfirmed = false;
        self.sellerConfirmed = false;
        // Excess value beyond amount + STORAGE_RESERVE is accepted as extra
        // storage headroom (deliberate choice; see header notes).
    }

    // Jetton deposit: trust the message source, not payload claims — the
    // notification must come from OUR expected jetton wallet, and the wallet
    // must report the tokens came from the buyer.
    receive(msg: JettonNotification) {
        self.requireNotPaused();
        require(self.assetType == ASSET_JETTON, "Escrow: not a jetton deal");
        require(self.status == STATUS_AWAITING_DEPOSIT, "Escrow: wrong status");
        require(sender() == self.contractJettonWallet!!, "Escrow: untrusted wallet");
        require(msg.sender == self.buyer, "Escrow: only buyer may deposit");
        require(msg.amount == self.amount, "Escrow: wrong amount");

        self.status = STATUS_DEPOSITED;
        self.depositTimestamp = now();
        self.buyerConfirmed = false;
        self.sellerConfirmed = false;
        // Buyer's jetton wallet is deterministically derivable off-chain from
        // (master, buyer); refund falls back to the buyer address directly.
    }

    // ---------- Admin operations ----------

    receive("release") {
        self.requireAdmin(ctx.sender);
        self.requireNotPaused();
        require(self.status == STATUS_DEPOSITED, "Escrow: wrong status");
        self._release();
    }

    receive("refund") {
        self.requireAdmin(ctx.sender);
        self.requireNotPaused();
        require(self.status == STATUS_DEPOSITED || self.status == STATUS_AWAITING_DEPOSIT, "Escrow: wrong status");
        self._refund();
    }

    receive(msg: ExtendDeadline) {
        self.requireAdmin(ctx.sender);
        self.requireNotPaused();
        require(msg.newDeadline > self.deadline, "Escrow: deadline not extended");
        self.deadline = msg.newDeadline;
    }

    // ---------- Mutual confirmation ----------
    // Each party confirms independently; when BOTH have confirmed while
    // deposited, the escrow releases to the seller (minus fee).

    receive("confirm") {
        self.requireNotPaused();
        require(self.status == STATUS_DEPOSITED, "Escrow: wrong status");
        require(ctx.sender == self.buyer || ctx.sender == self.seller, "Escrow: not a party");

        if (ctx.sender == self.buyer) {
            self.buyerConfirmed = true;
        }
        if (ctx.sender == self.seller) {
            self.sellerConfirmed = true;
        }
        if (self.buyerConfirmed && self.sellerConfirmed) {
            self._release();
        }
    }

    // ---------- Circuit breaker (owner = bot wallet) ----------

    receive("pause") {
        require(ctx.sender == self.owner, "Escrow: only owner");
        self.paused = true;
    }

    receive("unpause") {
        require(ctx.sender == self.owner, "Escrow: only owner");
        self.paused = false;
    }

    // ---------- Internal effects ----------

    fun _release() {
        // Effect first: a bounced payout reverts via bounced() below.
        self.status = STATUS_RELEASED;

        if (self.assetType == ASSET_TON) {
            let fee: Int = (self.amount * self.feeBps) / 10000;
            let sellerAmt: Int = self.amount - fee;
            send(SendParameters{
                to: self.seller,
                value: sellerAmt,
                bounce: false,
                mode: SendPayGasSeparately
            });
            if (fee > 0) {
                send(SendParameters{
                    to: self.feeAddress,
                    value: fee,
                    bounce: false,
                    mode: SendPayGasSeparately
                });
            }
            // STORAGE_RESERVE plus any deposit excess remains for storage debt.
        } else {
            // SIMPLIFICATION (documented): full amount goes to the seller in a
            // single transfer; the platform fee split is settled off-chain.
            send(SendParameters{
                to: self.contractJettonWallet!!,
                value: JETTON_OP_GAS,
                bounce: true,
                body: JettonTransfer{
                    queryId: 0,
                    amount: self.amount,
                    destination: self.seller,
                    responseDestination: self.admin,
                    customPayload: null,
                    forwardTonAmount: JETTON_FORWARD_TON,
                    forwardPayload: emptySlice()
                }.toCell()
            });
        }
    }

    fun _refund() {
        let hadDeposit: Bool = self.status == STATUS_DEPOSITED;
        // Effect first; bounced payout reverts via bounced() below.
        self.status = STATUS_REFUNDED;
        if (!hadDeposit) {
            return; // nothing ever escrowed — just close the deal out
        }
        if (self.assetType == ASSET_TON) {
            send(SendParameters{
                to: self.buyer,
                value: self.amount,
                bounce: false,
                mode: SendPayGasSeparately
            }); // STORAGE_RESERVE stays behind for storage debt
        } else {
            let dest: Address = self.buyer;
            if (self.buyerJettonWallet != null) {
                dest = self.buyerJettonWallet!!;
            }
            send(SendParameters{
                to: self.contractJettonWallet!!,
                value: JETTON_OP_GAS,
                bounce: true,
                body: JettonTransfer{
                    queryId: 0,
                    amount: self.amount,
                    destination: dest, // deterministic wallet derivation happens off-chain
                    responseDestination: self.admin,
                    customPayload: null,
                    forwardTonAmount: JETTON_FORWARD_TON,
                    forwardPayload: emptySlice()
                }.toCell()
            });
        }
    }

    // A bounced payout reverts a terminal status back to DEPOSITED so the
    // admin can retry with corrected conditions.
    bounced(msg: Slice) {
        if (self.status == STATUS_RELEASED || self.status == STATUS_REFUNDED) {
            self.status = STATUS_DEPOSITED;
            self.buyerConfirmed = false;
            self.sellerConfirmed = false;
        }
    }

    // ---------- Getters ----------

    get fun dealInfo(): (Int, Address, Address, Address, Int, Int, Int, Int, Int) {
        return (
            self.dealId,
            self.buyer,
            self.seller,
            self.admin,
            self.assetType,
            self.amount,
            self.feeBps,
            self.deadline,
            self.status
        );
    }

    get fun getStatus(): Int {
        return self.status;
    }

    get fun getConfirmations(): (Bool, Bool) {
        return (self.buyerConfirmed, self.sellerConfirmed);
    }

    get fun getPaused(): Bool {
        return self.paused;
    }
}
