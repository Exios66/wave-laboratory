# E2E reliability and deferred items

Goal: every e2e test passes reliably under Playwright + SwiftShader (two full serialised runs in a
row), and the deferred items from the last two PRs are closed.

## Design

For each failing test: reproduce, find the root cause, then fix the app (with a unit test) or the
test method (same behaviour asserted, waits keyed to real renders via `stats().frames`). No timeout
bumps without a measured reason.

## Tasks

- [ ] Baseline full run, record failures
- [ ] TAA camera cuts (graphics.spec.ts)
- [ ] Storm wet lens (graphics.spec.ts)
- [ ] app.spec.ts keyboard preset test and the second failing app test
- [ ] Underwater depth badge / shelf tests under load
- [ ] Resources spec: composer disposal case (fails if `disposeComposer()` is skipped)
- [ ] Screenshots: clouds-storm.jpg, clouds-plane-deck.jpg
- [ ] Hull contact 0 kn vs 18 kn: find why the speed order never took effect; screenshots
- [ ] Two consecutive full e2e runs green; `pnpm run check`
- [ ] ARCHITECTURE.md / PLAN.md status

## Validation

`flock .../playwright.lock env CI=1 PW_MAX_FAILURES=0 pnpm exec playwright test --trace off --reporter=line`
twice; `pnpm run check`.
