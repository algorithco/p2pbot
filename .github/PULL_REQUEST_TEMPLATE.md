## Summary

<!-- What does this PR change and why? Link related issues with "Fixes #123". -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing behavior to change)
- [ ] Refactor / chore (no behavior change)
- [ ] Documentation

## Checklist

- [ ] CI passes locally and on GitHub Actions (`ci.yml` green)
- [ ] No secrets (mnemonics, bot tokens, API keys, session strings) are committed
- [ ] `.env` files and session/log artifacts are NOT included in the diff
- [ ] New config values are documented in the relevant `.env.example`
- [ ] Smart-contract changes include updated `contracts/tests` and are covered by the sandbox suite
- [ ] Docker images still build if Dockerfiles/dependencies changed

## Security considerations

<!-- Describe any impact on auth, key handling, fund flows, or Telegram account access. Write "none" if not applicable. -->
