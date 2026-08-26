# Highload Wallet v3

TON **Highload Wallet v3** implementation based on the official
[ton-blockchain/highload-wallet-contract-v3](https://github.com/ton-blockchain/highload-wallet-contract-v3)
repository (official compiled FunC contract embedded - code hash
`11acad7955844090f283bf238bc1449871f783e7cc0979408d3f4859483e8525`).

Designed for exchanges / services that need to send **thousands of transfers**
(up to 8,380,415 unique messages per timeout window).

## Setup

```bash
npm install
copy .env.example .env   # edit NETWORK / TONCENTER_API_KEY
```

`.env` options:

| Variable              | Description                                              |
|-----------------------|----------------------------------------------------------|
| `NETWORK`             | `testnet` (default) or `mainnet`                         |
| `TONCENTER_API_KEY`   | recommended for mainnet (get free key at @tonapibot)     |
| `TONCENTER_ENDPOINT`  | optional custom ton-http-api endpoint                    |
| `HIGHLOAD_WALLET_DIR` | optional override of wallet storage dir (default ./wallets) |

## Quick start

```bash
# 1. Create a new wallet (generates 24-word mnemonic)
npm run create-wallet -- hot-wallet --timeout 3600

# 2. Fund its address with TON, then deploy
npm run deploy -- hot-wallet

# 3. Check state
npm run info -- hot-wallet

# 4a. Single transfer (with automatic admin-wallet failover)
# 4b. Batch transfers (up to 254 recipients per external message)
npm run send-batch -- hot-wallet transfers.json

# 5. NFTs
npm run send-nft -- hot-wallet <nft-item-addr> <new-owner-addr> --comment "sold"
npm run send-nft -- hot-wallet --file nfts.json

# 6. Admin wallet (backup sender / rescue)
npm run admin -- create ops-admin
npm run admin -- info ops-admin
npm run admin -- deploy-highload ops-admin hot-wallet   # alternative reliable deploy
npm run admin -- rescue hot-wallet ops-admin            # EMERGENCY: sweep all highload funds
```

`transfers.json` format:

```json
[
  { "to": "UQ...", "amount": "0.5", "comment": "payout #1" },
  { "to": "EQ...", "amount": "1.25" }
]
```

## Library usage (from your own code)

```ts
import { HighloadWallet } from './src';

// create once & save
const wallet = await HighloadWallet.generate({ name: 'hot-wallet', timeout: 3600 });
wallet.save();
console.log(wallet.address.toString());          // fund this address
console.log(wallet.state.mnemonic.join(' '));    // BACK THIS UP

// later: load & use
const w = await HighloadWallet.load('hot-wallet');
await w.deploy('0.05');

// single transfer
await w.send({ to: 'UQ...', value: '1.5' });

// batch transfer
await w.sendBatch([{ to: 'EQ...', value: '0.1' }, { to: 'UQ...', value: '0.2' }]);

// replay protection helpers
const res = await w.send({ to: 'UQ...', value: '0.01' });
const done = await w.waitForProcessed(res.queryId); // polls processed?(query_id)
```

## How it works

- **Receiving / holding TON**: `recv_internal` accepts **any** incoming TON
  unconditionally (no limits, no amount cap) - only self-sent
  `op::internal_transfer` messages trigger logic. The contract safely stores
  arbitrarily large balances indefinitely; storage rent is negligible.
  ⚠️ Before deployment, fund it using the **non-bounceable** (`UQ...`)
  address - bounceable transfers to an uninited account bounce back.
- **Deployment**: external message carrying StateInit (+ small self-transfer),
  so no second wallet is required. Needs `value` + ~0.02 TON already on the
  address (checked before sending).
- **Sending**: single transfers go **directly** through `recv_external`
  (one transaction, minimal fee). Batches use the official two-phase pattern:
  external msg -> self internal_transfer -> actions executed, with
  `CARRY_ALL_REMAINING_BALANCE` backing every outgoing transfer - unspent
  funds stay in the wallet. Contract adds `IGNORE_ERRORS` automatically so one
  bad recipient cannot abort the rest of a batch.
- **Replay protection**: every external message carries `query_id(23 bits)`,
  `created_at`, `timeout`; the contract commits the query id *before*
  sending and stores used ids in a rotating dictionary.
- **Clock safety**: `created_at` is sent with a 15s backward margin
  (`CREATED_AT_MARGIN_S`) - the contract rejects future timestamps, so this
  tolerates local clock skew ahead of chain time. Keep NTP enabled anyway.
- **Query id management**: `nextSeqno` is persisted to the wallet file
  *before* each send (crash-safe, never reuses ids within a window).
  Run exactly ONE sender process per wallet file.
- **Batches**: >254 actions are packed recursively into nested internal
  messages (`op::internal_transfer = 0xae42e5a4`) exactly like the reference
  wrapper. Capacity: 8,380,415 unique query ids per timeout window.
- ⚠️ `timeout` must be > 0 (recommend 1h..24h).
- ⚠️ Use subwallet_id distinct from other contracts (default `0x10ad`,
  as recommended by the official README). Never change
  pubkey/subwallet/timeout after deployment - it changes the address
  (the loader refuses such files).

## Admin wallet & failure handling

When code errors, RPC outages, or validator drops break the highload path:

- **`sendSmart(req)`** - production-safe send: retries the highload send
  (same `query_id`/`created_at` = replay-safe), waits for on-chain
  confirmation if `confirmTimeoutMs` is set, and finally routes the transfer
  through the **admin wallet** (regular v4) as last resort. Returns
  `{ route: 'highload' | 'admin', fellBack }`.
- **`npm run admin -- rescue <highload> <admin|addr>`** - emergency sweep of
  the ENTIRE highload balance (`CARRY_ALL_REMAINING_BALANCE`) to the admin
  address when stopping/migrating the service.
- **`deploy-highload`** - deploys the highload contract via an internal
  StateInit message from the admin wallet (reliable alternative to
  external-StateInit deployment).

The admin wallet cannot move highload funds directly (different keypair);
it sends from its own balance or receives swept funds.

## NFT support (TEP-62)

- **Receiving / storing**: automatic. An incoming NFT only changes
  `ownership_address` inside the item contract; no wallet logic involved.
  Verify holdings with `getNftInfo(itemAddr)` -> reads standard
  `get_nft_data()` (owner, index, collection).
- **Sending**: `sendNft({ nftAddress: ITEM_addr, newOwner })` builds the
  TEP-62 `transfer#5fcc3d14` body (response_destination = this wallet so
  excess gas returns, forward_amount default 0.01 TON to notify new owner)
  and refuses to send items the wallet does not own.
  `sendNfts([...])` batches multiple item transfers.
  ⚠️ Always pass the **item** contract address, not the collection.

## Tests

```bash
npm test        # 62 offline checks: code hash, cell layouts,
                # wire format, query-id math, persistence,
                # outbound-message contract-validation compliance
```

## Files

```
src/
  code.ts               official compiled contract BOC
  HighloadQueryId.ts    shift/bitnumber iterator (port of official wrapper)
  HighloadWalletV3.ts   low-level contract wrapper (port of official wrapper)
  wallet.ts             high-level manager (create/deploy/send/batch)
  config.ts             .env / network configuration
scripts/
  createWallet.ts       generate + save new wallet
  walletInfo.ts         balance / deployment status / on-chain getters
  deployWallet.ts       deploy via external StateInit message
  sendTransfer.ts       single transfer
  sendBatch.ts          JSON-driven batch transfers
tests/
  offline.test.ts       verification suite (no network needed)
wallets/                generated wallet files (gitignored!)
```
