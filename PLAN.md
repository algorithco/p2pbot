# P2P Escrow — Backend Hardening Plan (money-handling rigor)

## Phase 0 notes (what the code actually does)

### Deal lifecycle (verified in code)

`AWAITING_DEPOSIT` (created via `POST /api/deals` → `createDealRecord`) →
`DEPOSIT_CONFIRMED` (blockchain `listener.ts` exact/overpay match, or manual) →
`ITEM_SENT` (`markItemSent`, seller-only, `SELECT ... FOR UPDATE`) →
`RELEASED` (buyer `buyerApproveReceipt`, or admin `adminRelease`/`payoutSellerForChannel`
via `guardedTransition`) / `REFUNDED` (admin `adminRefund` via `guardedTransition`,
or 24h scheduler auto-close of `AWAITING_DEPOSIT` via **unguarded** `updateDealStatus`).
`BUYER_CONFIRMED` is legacy (tolerated as a source state, never written by current code).

### Where money leaves custody (all via signer HTTP → TON)

- `escrowService.guardedTransition` — principal + fee (`sendTon`/`sendJetton`), used by
  `adminRelease`, `adminRefund`, `payoutSellerForChannel`.
- `escrowService.buyerApproveReceipt` — **duplicated** principal + fee send block (same risk).
- `listener.processTonDeposit/processJettonDeposit` — overpay excess refunds (small amounts,
  same crash-window shape but bounded to excess; still benefits from group A key passing).
- Current guarantee: `SELECT ... FOR UPDATE` + guarded `UPDATE ... WHERE status=$old`.
  This blocks **concurrent** double-payout but NOT **crash-between-send-and-COMMIT**
  double-payout (DB still shows pre-payout status after restart → retry re-sends).
- `sendTon`/`sendJetton` (`signerClient.ts` → `signer/src/index.ts` → `wallet.ts`):
  plain network calls, fresh wallet `seqno` per call, **no idempotency support**.
  A timeout after on-chain acceptance looks identical to a failure to the caller.

### Load-bearing indexes (queries that filter on these columns)

- `GET /api/deals/mine`, `GET /api/deals`: `WHERE buyer_telegram_id=$1 OR seller_telegram_id=$1`
  → needs `idx_deals_buyer`, `idx_deals_seller` (OR → bitmap-or; a composite index would
  NOT serve this pattern, so singles are correct).
- Status filters: scheduler (`status='AWAITING_DEPOSIT'/'DEPOSIT_CONFIRMED'/'ITEM_SENT'`),
  listener seed (`status='AWAITING_DEPOSIT'`), inbox join (`deal_join_requests.status`),
  `findAwaitingDealById` (`id + status`) → `idx_deals_status` + existing
  `idx_join_requests_status`.
- `buyer_id`/`seller_id` on deals: full-repo grep proves **write-only**
  (only written in `createDealRecord` INSERT, never read outside `ALTER ... TYPE BIGINT`).
  Decision: NOT dropped (live system, destructive migration forbidden) — marked
  DEPRECATED in code, writes kept (harmless, keeps rows consistent for external readers).

### Discrepancies found during Phase 0 (plan adjusted, no blind fixes)

1. **Baseline build is RED**: `listener.ts` imports `confirmDeposit` from `dealService`,
   which does not exist (leftover of an uncommitted parallel workstream touching
   `listener.ts`/`dealService.ts`/`money.ts`). Fix = drop the import (it is unused).
   Done as Commit 0. Working tree also contains other uncommitted workstream changes
   (money `dealPricing`, `dealLike`, `dealTransitions.ts` untracked); they are preserved
   untouched. `dealTransitions.ts` is imported by nothing → group A does not extend it.
2. **Postgres has no `ADD CONSTRAINT IF NOT EXISTS`** — group B uses the file's existing
   try/catch `ADD CONSTRAINT` pattern (same as `chk_deals_amount_pos`) instead.
3. **Payout logic is duplicated**: `buyerApproveReceipt` re-implements the send block
   outside `guardedTransition`. Group A fixes BOTH via one shared `executePayout` helper.
4. **New PENDING statuses reach the API**: transient only; frontend untouched per
   constraints (clients should treat unknown non-final statuses as "in progress").
5. No Redis in `docker-compose.yml` → group D documents the multi-instance TODO only.
6. Backend Dockerfile sets `NODE_ENV=production` → `NODE_ENV`-gated fail-closed is reliable.

## Phase 2 commits

### Commit 0 — `fix(backend): drop non-existent confirmDeposit import (build breakage)`

- Files: `backend/src/blockchain/listener.ts` (1 line).
- Risk: build red, nothing else shippable. Verify: `npm run build` green.

### Group A — `fix(escrow): crash-safe payouts via PENDING states + idempotency keys`

- Files: `backend/src/services/dealService.ts` (2 statuses), `backend/src/db/queries.ts`
  - `backend/src/db/schema.sql` (4 columns), `backend/src/services/escrowService.ts`
    (two-phase `guardedTransition` + `buyerApproveReceipt`, shared `executePayout`,
    `reconcileStuckPayouts`), `backend/src/blockchain/signerClient.ts` (key passthrough),
    `signer/src/index.ts` (in-memory idempotency cache = last line of defense),
    `backend/src/index.ts` (boot reconciliation call).
- Design: **new statuses** `RELEASE_PENDING`/`REFUND_PENDING` (least disruption: the
  machine already reasons about statuses; a visible state blocks concurrent retries at
  the state-machine level and is admin-queryable). Tx1 marks PENDING + deterministic key
  (`release:{id}`/`refund:{id}`) and COMMITS; network send runs with NO DB lock held;
  tx2 finalizes only `WHERE status=PENDING AND key=key`. Send failure → status rolled
  back to pre-payout value (retryable) + persistent `admin_alerts` row + `notifyAdminsHub`
  (NOT just a log line). Fee-leg failure → `fee_payout_failed=true` + `fee_payout_error`
  - `admin_alerts` row (deal still finalizes: principal already left custody).
    Boot: `reconcileStuckPayouts(15min)` flags stuck PENDING deals to admins, NEVER auto-retries.
    Signer cache (1000 keys, 24h, 409 on key-reuse-with-different-params) is best-effort;
    the durable guarantee is the backend DB key + PENDING state.
- Verify: `npm run build` in `backend/` and `signer/`; manual reasoning trace of
  crash-at-each-step table (in commit message); Uzbek strings unchanged.

### Group B — `fix(db): deal indexes, status CHECK, pending-join uniqueness`

- Files: `backend/src/db/queries.ts`, `backend/src/db/schema.sql`,
  `backend/src/services/dealService.ts` (`createJoinRequest` 23505 handling + deprecation note).
- Adds `idx_deals_buyer/seller/status`, `chk_deals_status` (8 values incl. PENDING),
  partial unique `uq_join_requests_pending`; race in `createJoinRequest`
  (select-then-insert) closed by catching unique violation → return existing row.
- Verify: `npm run build`; SQL reviewed for backward-compat (`IF NOT EXISTS`/try-catch only).

### Group C — `fix(security): fail-closed encryption in production`

- Files: `backend/src/utils/encryption.ts` (+ `backend/src/config.ts` flag plumbing,
  `backend/src/index.ts` boot assert), `ubot/src/sessionManager.ts`,
  `utradebot/src/services/sessionCrypto.ts`.
- Strict when `NODE_ENV=production` OR `STRICT_ENCRYPTION=true`: missing/malformed
  `ENCRYPTION_KEY` → fatal + `process.exit(1)` (backend) / throw on encrypt
  (ubot/utradebot, no silent plaintext). Non-prod keeps fallback with louder once-only warning.
- Verify: builds of all three services; boot-path reasoning (no behavior change in dev).

### Group D — `fix(api): rate-limit public TON proxies + deal state-changing routes`

- Files: `backend/src/index.ts` only.
- `publicTonLimiter` 30/min → `GET /api/status/:address`, `/api/balance/:address`,
  `/api/ton/payload`; `dealActionLimiter` 20/min → `confirm`/`ship`/`approve`;
  in-memory TODO comment (+ `rate-limit-redis` path); `API_DOCS.rateLimits` updated.
- Verify: `npm run build`; limits consistent with existing naming/pattern.

### Group E — `chore(deploy): require POSTGRES_PASSWORD, document CSP exception`

- Files: `docker-compose.yml` (3× `:?` required-var), `README.md` (drop "defaults to …"),
  `backend/src/index.ts` (CSP comment: Telegram WebView needs inline scripts; nonce infeasible).
- Non-sensitive defaults (ports/URLs) untouched. Verify: `docker compose config` reasoning + build.

### Group F — `fix(chat): atomic chat-key backfill under FOR UPDATE`

- Files: `backend/src/services/dealService.ts` (`getDealChatKey` rewrite).
- Same `SELECT ... FOR UPDATE` pattern as `atomicJoinDeal`; missing deal → null (no phantom write).
- Verify: `npm run build`; concurrent-first-open reasoning.

### Group G — `chore(backend): error-handling audit — log or annotate every bare catch`

- Files: touched per-file across `backend/src` (comments + `logger.warn/error` only;
  behavior change limited to `resolvePayoutAddress` fallback lookups gaining warnings —
  still fall through, never break payout resolution).
- Commit message reports reviewed vs changed counts. Verify: `npm run build`.

## Final summary

Written to `SECURITY_FIXES.md` at the end: every commit, risk closed, remaining known risks
(listener excess-refund sends still single-phase but bounded to overpay excess;
signer dedupe is memory-only; rate limits per-process; scheduler auto-close still uses
unguarded `updateDealStatus` but only selects `AWAITING_DEPOSIT` rows — follow-ups, not this pass).

 < ! - -   b r a n c h - p r o t e c t i o n   s m o k e   t e s t   - - > 
 
 
