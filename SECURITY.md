# Security Policy

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security problems.**

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability** (https://github.com/algorithco/p2pbot/security/advisories/new).

You can expect:

- **Acknowledgement** within 72 hours.
- An initial **assessment and remediation plan** within 7 days.
- A **fix or mitigation** coordinated with you before any public disclosure.
- Credit in the release notes (unless you prefer to remain anonymous).

## Scope

| Component | Description |
| --- | --- |
| `backend` | Telegram bot + REST API + off-chain deal ledger |
| `signer` | Isolated W5 wallet service (signs all fund movements) |
| `contracts` | Tact `Escrow` smart contract (TON) |
| `ubot` | Telegram userbot — channel/group takeover |
| `utradebot` | Telegram account-sale escrow bot |
| `webapp` | Telegram Mini App |

Out of scope: upstream dependencies (report to their maintainers), social
engineering of platform staff, and denial-of-service by volume.

## High-value targets — please scrutinize these areas

1. **Key material**: `SIGNER_MNEMONIC`, `UBOT_SESSION_STRING`, 2FA passwords,
   Telegram `StringSession` values. These must never leave the signer/userbot
   containers or appear in logs, API responses, or the database in plaintext.
2. **Auth boundaries**: `x-init-data` Telegram initData validation, `x-api-key`
   service-to-service auth, one-time join-link tokens.
3. **Fund flows**: deposit matching by memo (`escrow#<id>`), guarded status
   transitions, release/refund paths (both custodial and on-chain), fee split.
4. **Deal integrity**: approval permissions (buyer-only approvals), dispute
   handling, admin commands, E2E chat key derivation.

## Supported versions

Only the `main` branch receives security fixes. Always deploy the latest
image from the `main` build.

## Operator security requirements

- Rotate every credential that has ever been committed to git history
  (bot tokens included) — treat history as compromised.
- Keep the signer wallet balance minimal; hold reserves in cold storage.
- Never commit `.env` files, `sessions/` directories, or any mnemonic/seed
  phrase. The mnemonic must exist only in the signer's runtime environment.
- Restrict network access: the signer, ubot, and utradebot must never be
  exposed outside the internal Docker network.
