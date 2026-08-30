# Contracts

Tact smart contracts for the P2P escrow bot. The main contract,
[`Escrow.tact`](Escrow.tact), holds funds for a single deal on TON.

## Compile

```bash
cd contracts
npm install
npm run build        # tact --config tact.config.json
```

Output lands in `output/Escrow.boc`. Convert it to hex and put it into
`backend/.env`:

```bash
node -e "console.log(require('@ton/core').Cell.fromBoc(require('fs').readFileSync('output/Escrow.boc'))[0].toBoc().toString('hex'))"
```

```
# backend/.env
ESCROW_CONTRACT_CODE_HEX=<hex from above>
```

## Test

```bash
npm test             # jest --runInBand (sandbox tests via @ton/sandbox)
```

Tests load any compiled `.boc` found in `output/`; when none exists every test
is **auto-skipped**, so `npm test` stays green before compilation (e.g. fresh
clone or CI without network).

## Design summary

- **Dual asset** — plain TON deposits or jettons (TEP-74); jetton opcodes are
  pinned with explicit `message(0x…)` annotations.
- **Admin arbiter** — `admin` can force `release`, `refund`, and extend the
  deadline (`ExtendDeadline`); disputes resolve off-platform.
- **Mutual-confirm auto-release** — each party sends `"confirm"` independently;
  when both have confirmed while deposited, funds release to the seller
  automatically (fee split per `feeBps`).
- **Checks-effects-interactions** — status flips *before* any sends; a bounced
  payout reverts the terminal status back to DEPOSITED via `bounced()` so the
  admin can retry.
- **Storage reserve** — `STORAGE_RESERVE` (0.02 TON) plus deposit excess stays
  behind after payouts to cover storage debt.
- **Circuit breaker** — contract owner can `pause`/`unpause` all operations.
- Documented simplification: jetton release sends the full amount to the
  seller; the platform fee split for jetton deals is settled off-chain.

## Go-live checklist (on-chain)

1. [ ] `cd contracts && npm install && npm run build` succeeds.
2. [ ] `npm test` passes with real BOC present (tests actually run).
3. [ ] Choose network; set backend `TON_NETWORK=testnet|mainnet` +
      `TON_API_ENDPOINT`/`TONCENTER_API_KEY`.
4. [ ] Create/fund the W5 deployer wallet; paste its 24-word phrase into
       `SIGNER_MNEMONIC` in `signer/.env` (hot-wallet risk — keep balance minimal,
       never in `backend/.env`) and confirm `signer` `/address` matches `WALLET_ADDRESS`.
5. [ ] Set `ESCROW_CONTRACT_CODE_HEX` from the compiled BOC.
6. [ ] Configure addresses: `ADMIN_ADDRESS`, `FEE_ADDRESS`,
      `FEE_BPS`, `MIN_CONFIRMATIONS`.
7. [ ] Jetton deals only: verify the master on-chain explorer, then set
      `JETTON_MASTER_ADDRESS`, `USDT_JETTON_ADDRESS`,
      `JETTON_WALLET_CODE_HASH` (verification itself is still pending — treat
      as gap until confirmed).
8. [ ] Deploy an escrow for a test deal end-to-end on testnet; verify deposit,
      double-confirm release and refund flows on-chain.
9. [ ] Only then flip `REQUIRE_ONCHAIN=true` in production config.
