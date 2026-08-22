# Heatchecks — Full Loop Test Execution — Report

Final run: **462 passed, 0 failed, 4 informational warnings.** Harness: `scripts/acceptance.ts` (+ `scripts/acceptance/`), a consolidated, re-runnable suite covering every acceptance check from tonight's builds plus the four new verification phases.

Run it with:
```
npx tsx scripts/acceptance.ts               # everything
npx tsx scripts/acceptance.ts pets security  # just named suites
```
Requires `ACCEPTANCE_CONFIRM=1`, `DATABASE_URL`, `BASE_URL` (default `127.0.0.1:8788`), and `TICKER_SECRET`/`SETTLE_SECRET`/`SESSION_TOKEN_SECRET` matching the dev server's `.dev.vars`. Blank `RESEND_API_KEY` for the dev server process before a full run — settlement sends real emails otherwise.

---

## Per-phase result

| Phase | Suite(s) | Pass | Fail | Warn |
|---|---|---|---|---|
| 0 — consolidated harness (existing) | tickers, discovery | 69 | 0 | 1 |
| 0 — consolidated harness (new) | settlement, pets, auth, homepage | 133 | 0 | 0 |
| 1 — concurrency | concurrency | 40 | 0 | 0 |
| 2 — ledger trace | ledger-trace | 101 | 0 | 0 |
| 3 — boundary sweep | boundaries | 40 | 0 | 1 |
| 4 — security re-review | security | 79 | 0 | 2 |
| **Total** | | **462** | **0** | **4** |

All phases 0–4 are green. **Phase 5 (human walkthrough) was not attempted or simulated** — it's queued as an outstanding manual step, per the task brief.

---

## Bugs found and fixed

All fixes were in the **new test harness itself** (no product code was changed) — each was an unambiguous defect in the test code, not a product-behavior judgment call:

1. **`dotenv` ordering bug in the runner** (`scripts/acceptance.ts`) — several suites read `process.env.TICKER_SECRET` etc. into a module-top-level `const`, but static imports execute before the importing module's own `dotenv.config()` call, so those consts froze at `''`. Every `/api/ticker-tags` call failed 401 "Unauthorized" despite a correct secret in `.env`. Fixed by calling `dotenv.config()` first and dynamically `import()`-ing every suite only after, deferring their evaluation. This was the single largest cause of the first run's 78 failures (tickers, boundaries §4–7, concurrency's ticker-tag test).
2. **Date-object comparison bug** (`suites/settlement.ts`) — `pg` returns `TIMESTAMP` columns as `Date` objects; comparing two separately-fetched `Date` instances with `===` is reference equality, always false even for the identical instant. The idempotency re-run check now compares via `.getTime()`.
3. **CSS-substring false negative** (`suites/homepage.ts`) — the "no login CTA when logged in" check searched for the substring `hc-login-cta`, which also appears in the page's static `<style>` block regardless of login state. Fixed to check for the actual anchor markup instead.
4. **Over-strict hatch-race assertions** (`suites/concurrency.ts`, tests 5 and 6) — `hatch.ts`'s own comments document that a truly-simultaneous loser whose "do I already have a pet?" re-check runs before the winner's transaction commits will legitimately see 404, not 200/`created:false`. The assertions only accepted the latter; loosened to accept both, matching the code's documented behavior. (The core guarantees — exactly one pet ever created, the untargeted egg always surviving — held throughout and were never in question.)
5. **Inactive hardcoded catalog SKU keys** (`suites/pets.ts`, `suites/concurrency.ts`, `suites/security.ts`) — these suites hardcoded `egg_slate`/`food_basic`/`food_premium` (all `active=false` in the current catalog), so every purchase 404'd "That item is not available." Fixed by adding `cheapestActiveSku()`/`secondActiveSku()` to `fixtures.ts`, which look up a real active SKU (and its live price/points) at run time — the same pattern `ledger-trace.ts` already used successfully. This also fixed two downstream assertions in `pets.ts` that assumed a specific point total would overshoot the satisfaction cap; now forces satisfaction to 95 directly before the clamp test so it's robust to whichever food SKU is currently cheapest.

---

## Flagged back — not decided unilaterally

1. ~~**`DAILY_PICK_CAP`'s actual deployed value.**~~ **RESOLVED (local dev):** set `DAILY_PICK_CAP=3` in `.dev.vars` and re-ran the boundary suite against it — cap logic confirmed correct at 3 (picks 1–3 succeed, pick 4 gets 429/`remaining:0`, exactly 3 rows land, the `newsletter_exclusive` carve-out still doesn't count against it). **Still open:** what's actually set in the Cloudflare Pages dashboard for preview/prod — this only fixes local dev, since `wrangler.toml` has no `[vars]` entry and the deployed value lives in the dashboard, which this harness can't reach.
2. **Hatch is one-pet-per-account, not one-pet-per-egg.** The original test-plan doc's "never two pets from one egg" framing undersells what the code actually guarantees — `hatch.ts:1-7` and `idx_pets_one_captain` are explicit that it's one pet *per account, ever*. Not a bug; the code is correct and intentional. The test-plan doc's wording should be updated to match, not the other way around.
3. **`pets/feed.ts`'s food-SKU lookup has no `active`/availability-window filter**, unlike `shop/buy.ts`'s SKU lookup which checks both. Confirmed by direct code read (`feed.ts:56` vs `buy.ts:40-49`). Practical effect: a retired or window-closed food SKU can still be fed indefinitely by anyone already holding units of it. Plausibly intended ("you keep what you bought"), but it's an asymmetry worth an explicit yes/no rather than assuming.
4. **`functions/api/toolbar-state.ts` has no CSRF guard** despite triggering the Pet Discovery write side-effect on every call — confirmed by source read and a live dynamic probe (a hostile cross-origin GET is NOT rejected). Assessed as low-impact: a due roll always grants regardless of what triggered it, no data is exposed (no CORS headers), so the worst case is an attacker forcing a victim's discovery roll to fire at an attacker-chosen moment — a griefing nuisance, not a theft. Flagging the assessment for sign-off rather than assuming it's fine.
5. ~~**`lib/pages-functions/gamma.ts`'s missing-snapshot-outcomes fallback.**~~ **INVESTIGATED — real code-level gap, but dormant in practice.** When a Tank's frozen snapshot has no `outcomes` array, `outcomeOrderMismatch()` returns `false` and settlement proceeds on raw index (zero inversion protection). Traced every creation path for a `provider='polymarket'` tank (`tank-providers.ts:210-212`, `tank-filter.ts`, `functions/api/curate.ts:178-188`, the local admin `/api/tank/generate` route, and `scripts/seed-tank-starter-pages.ts`): all of them share the same construction, `odds: row.outcomes && row.outcome_prices ? {...} : null`, and **none of them guard against or filter out a `null` result** — so the gap is live and reachable, not hypothetical. There's also no DB constraint enforcing the shape (`game_snapshot JSONB NOT NULL` only). Queried the live DB directly: **34 total `provider='polymarket'` tank_pages rows, 0 with a missing/empty `outcomes`** — meaning Gamma has, empirically, always returned parseable outcome data for every prop that made it to curation so far. **Verdict: not urgent, but not purely theoretical either** — a single malformed Gamma response on a future curation run would silently create an unprotected Tank with no error or warning. Cheapest fix, if wanted: reject/skip a prop with `odds: null` in `tank-filter.ts` (or the curate insert) rather than letting it through unguarded — did not make this change since it's a product-behavior call, not a test-harness fix.
6. ~~**Same-feedToken parallel feed has no lock.**~~ **FIXED.** `feed()` in `lib/pages-functions/pets.ts` now takes a `feedLock()` advisory-xact-lock as its transaction's first statement, mirroring `ledger.ts`'s `spendLock()` exactly (same reasoning, separate lock namespace so the two never collide). Re-ran the concurrency suite with a new test (2b): N=8 truly-simultaneous identical-feedToken requests now consume **exactly one** food unit (was previously an accepted possible over-consume) — confirmed against a pet stocked with 8 units so an unfixed race would have been visible.
7. **Ticker-tag movement-cap boundary (Phase 3, item 7) could not be exercised this run** — the live market picked for the fixture had ~0 raw 3-day movement, so the suite logged a `WARN` and skipped the exact-cap assertion gracefully rather than faking a value. This is inherent to using a real market and will pass or skip depending on live conditions on any given run — not something to "fix," just something to know if you see the warning again.
8. **`ticker-sweep`/`notify-sweep`'s "correct secret → normal behavior" happy path was deliberately not exercised** — both run an unscoped sweep over every live Tank / onboarded account in the database, not just fixtures, so firing them for real was judged out of this suite's blast radius. Only their 401 auth-gate is proven here; their correctness is otherwise covered by production cron runs. Flagging so it's a conscious gap, not an invisible one.

---

## Aside (not part of the test result)

While this ran, two unrelated files — `scripts/generate-static-site.ts` and `scripts/templates/tank-article-template.ts` — picked up a one-line `kickoff` field addition each, timestamped mid-session. None of my agents touched these (each was scoped strictly to its own suite file); this looks like your own concurrent work in another session. I already flagged this to you before touching the dev server and left both files exactly as they were — nothing further needed from me here, just noting it for the record.

---

## Deliverable status

- Phases 0–4: **all green**, consolidated into one re-runnable harness at `scripts/acceptance.ts`.
- 5 harness bugs found and fixed (all test-code, zero product-code changes).
- 8 items flagged back above — genuine judgment calls, not decided unilaterally. Two have since been resolved (see items 1 and 6) and one investigated to a clear verdict (item 5); the rest remain open.
- **Phase 5 (human walkthrough): outstanding, queued as a manual follow-up. Not automated, not simulated, not skipped.**

---

## Post-report follow-ups (product code changed)

Two product-code changes were made after the initial report, both re-verified against the live dev server:

1. **`lib/pages-functions/pets.ts`** — added `feedLock()` (a `pg_advisory_xact_lock` keyed on `('pet_feed', userId)`) as the first statement in `feed()`'s transaction, closing the same-feedToken true-simultaneity double-consume race (flag-back item 6 above). `scripts/acceptance/suites/concurrency.ts` gained a new test (2b) that proves it under real N=8 parallelism.
2. **`.dev.vars`** — added `DAILY_PICK_CAP=3` for local dev. The boundary suite re-ran against it and confirmed the cap logic is correct at 3 (flag-back item 1 above). This is local-only; the deployed preview/prod value still needs confirming in the Cloudflare dashboard.

Both changes are covered by a clean `npx tsc --noEmit` and a subsequent full `boundaries`+`concurrency` run: **85 passed, 0 failed, 1 informational warning** (the same thin-market ticker-cap skip as before).
