# Security hardening — backend (commit series, Sep 2026)

Money-handling system: every change below was verified with `npm run build`
(green) in each touched service before the next commit. No frontend, route,
or response-shape changes. All schema changes additive/backward-compatible.
Uzbek user strings preserved exactly.

## Commits (in order — do not reorder; B's CHECK depends on A's statuses)

| #   | Commit                                                                  | Risk closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | `fix(backend): drop non-existent confirmDeposit import`                 | Baseline `tsc` was RED (`listener.ts` imported a non-existent export from an uncommitted parallel workstream). One-line, zero behavior change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A   | `fix(escrow): crash-safe payouts via PENDING states + idempotency keys` | **Double-payout on crash between on-chain send and DB COMMIT.** Three-phase flow (`RELEASE_PENDING`/`REFUND_PENDING` + deterministic `release:{id}`/`refund:{id}` committed before any send; finalize only `WHERE status=PENDING AND key=key`; no DB tx held during network I/O) in both `guardedTransition` and `buyerApproveReceipt` via shared `executePayout`. Signer dedupes same-key replays in memory (409 on key-reuse-with-new-params); durable truth is the DB. Fee-leg failures now persist to `fee_payout_failed`/`fee_payout_error` + `admin_alerts` (were log-only). Boot runs `reconcileStuckPayouts(15m)` — flags, never auto-retries. |
| B   | `fix(db): deal indexes, status CHECK, pending-join uniqueness`          | Full-table scans on party/status lookups (`idx_deals_buyer/seller/status`; singles, not composite — the hot query is `OR`-shaped). `chk_deals_status` enum guard (try/catch pattern; PG has no `ADD CONSTRAINT IF NOT EXISTS`). Partial unique `uq_join_requests_pending` + `23505`→existing-row closes the double-click race. `buyer_id`/`seller_id` proven write-only, marked DEPRECATED, kept (no destructive migration).                                                                                                                                                                                                                           |
| C   | `fix(security): fail-closed encryption in production`                   | Silent plaintext fallback when `ENCRYPTION_KEY` missing/malformed. Strict when `NODE_ENV=production` (set by Dockerfile) or `STRICT_ENCRYPTION=true`: backend refuses boot, ubot/utradebot `encryptSession` throws. Dev keeps fallback with louder once-only banner. Read/decrypt paths untouched (rotation-safe).                                                                                                                                                                                                                                                                                                                                     |
| D   | `fix(api): rate-limit public TON proxies + deal state-changing routes`  | Unprotected paid-API proxies (`status`/`balance`/`payload` → 30/min) and unprotected state mutations (`confirm`/`ship`/`approve` → 20/min). In-memory TODO + `rate-limit-redis` path documented (no Redis in compose — out of scope).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| E   | `chore(deploy): require POSTGRES_PASSWORD, document CSP exception`      | Weak guessable default `escrow_password` in 3 compose spots → `:?` fail-fast (verified both directions). README updated. CSP `unsafe-inline` kept with accepted-risk rationale (Telegram WebView).                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F   | `fix(chat): atomic chat-key backfill under SELECT FOR UPDATE`           | Concurrent first chat opens could split-brain E2E keys. Backfill now transactional under row lock (same pattern as `atomicJoinDeal`); missing deal returns null.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| G   | `chore(backend): error-handling audit`                                  | ~150 catch blocks reviewed in 17 files. 4 real fixes: `resolvePayoutAddress` fallback lookups now warn (were misleadingly silent), channel-payout persist failures now warn, `atomicJoinDeal` rollback can no longer mask the join error, admin alerts handler now logs+replies. ~35 intentionally-silent blocks annotated `// best-effort: <why>`.                                                                                                                                                                                                                                                                                                    |

## Deliberately NOT fixed in this pass (known remaining risks)

- **Listener excess-refund sends** (`processTonDeposit`/`processJettonDeposit` overpay path)
  are still single-phase. Bounded to the overpay excess (not principal), same crash window
  in miniature — needs the same PENDING treatment or an outbox table; follow-up.
- **Signer idempotency cache is memory-only** (1000 keys / 24h). Survives backend crashes
  (the dangerous direction) but not signer restarts. Acceptable because the backend DB
  key + PENDING state is the durable guard; a signer restart + backend retry in the same
  window is the residual risk — narrow, and flagged by reconciliation if it bites.
- **Rate limits are per-process.** Fine at 1 backend instance; must move to
  `rate-limit-redis` before horizontal scaling (TODO in code).
- **Scheduler auto-close** still uses unguarded `updateDealStatus`, but only selects
  `AWAITING_DEPOSIT` rows, so it cannot clobber a PENDING/RELEASED deal. The parallel
  `dealTransitions.ts` workstream (untracked, imported by nothing) aims to centralize
  this; left untouched.
- **`buyer_id`/`seller_id` still written.** Dead but harmless; removal is a destructive
  migration for a later maintenance window.
- **No test suite exists** (`package.json` has no test script). Verification was
  `tsc` green per service per commit + crash-table reasoning in commit A. Adding
  payout-path unit tests (especially the PENDING state machine) is the highest-value
  follow-up.

## Pre-existing tree state (not authored here, preserved)

Uncommitted parallel-workstream changes were already in the tree
(`money.ts dealPricing`, `dealService dealLike/isDisputedDeal`,
`contractDeployer` import cleanup, `dealTransitions.ts` untracked, webapp files);
commits that touched overlapping files say so in their messages.
