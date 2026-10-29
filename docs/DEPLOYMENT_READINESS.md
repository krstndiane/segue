# Deployment readiness — 29 October 2026

## Release status (updated 30 October 2026)

| Check | Result | Evidence |
| --- | --- | --- |
| Pull request | **PASS** | [#2](https://github.com/krstndiane/segue/pull/2), `reroute-intelligence` at `f5505a1` into `main` |
| CI on the release | **PASS** | Every step green: install, typecheck, `pnpm test` (real vitest, so the 2 sky-preview tests that failed in the audit sandbox pass), `pnpm build`, engine bench |
| Merged | **PASS** | `main` = `c6817f2` (merge commit), on the owner's instruction ("push everything in main") |
| Vercel production | **PASS** | Commit status "Deployment has completed" for `c6817f2`. The live bundle calls `https://segue-api-qhgc.onrender.com`, never `localhost` |
| Render API | **PASS** | `/health` now reports `places: cached(osm→nominatim)`, `assistant: basic` and `placesStatus`, which only the new code produces |
| Real places in production | **PASS WITH LIMITATIONS** | 30 Oct: Makati gyms (Gold's Gym 287 m, Anytime Fitness 439 m, Fitness First 511 m), Makati cafés, Quezon City groceries (Savemore, Puregold, Robinsons) and parks, Manila libraries (Manila City Library, National Library of the Philippines). All `source: "osm"`, within 2 km, nearest first, unique ids. `placesStatus.lastAnswer.provider` = `nominatim` (Overpass still failing). Most places have no listed hours. |
| Provider failure in production | **PASS** | Right after deploy (29 Oct), every search got "[nominatim] search returned 429". The API answered 503 "Live map data isn't available right now" and showed no made-up places. It recovered by itself. Follow-up fix: back off after a refusal (pull request #3). |
| Live rerouting | **PASS WITH LIMITATIONS** | See MAP_AND_REROUTING_AUDIT, "Production checks". Real weather wasn't raining, so rain was tested with "you said it's raining" |
| `NOMINATIM_USER_AGENT` on Render | **UNVERIFIED** | Needs the owner's contact email; the code default names the site but no contact |
| zod advisory | **Open, accepted for release** | Still `zod@3.25.76`; body caps limit the risk. Upgrade to zod 4 is follow-up work |

**Rollback:** in Render and Vercel, redeploy the previous production deployment (`e89d550`). No database change to undo. Note that rolling back brings the made-up places back.

---

**Release decision at audit time (29 October): READY AFTER SPECIFIC FIXES.** No code-level release blockers remain on the release candidate, and Vercel's real production build of the final code succeeded. Three verification and configuration steps (below) must be done before or right after deploying, because they can't be done from the audit environment.

Companion reports: [MAP_AND_REROUTING_AUDIT.md](MAP_AND_REROUTING_AUDIT.md) (providers, map data, rerouting scenarios) and [RELEASE_BLOCKERS.md](RELEASE_BLOCKERS.md) (every issue, its status and acceptance criteria). Earlier rounds: [AUDIT.md](AUDIT.md), [REROUTE_INTELLIGENCE.md](REROUTE_INTELLIGENCE.md).

## What was audited

| | |
| --- | --- |
| Release candidate | branch `reroute-intelligence` (contains `audit`). Audit started at `a6823fa`; fixes from this audit are `4746d07` and `57a4e0e`, and the reports are committed on top of them. |
| Live site | `main` at `e89d550`. Verified: the live API's `/health` reports `places: cached(osm→mock)` and has no `assistant` field, which only `main` produces. Vercel production deploys `main`. |
| Code vs live | **Different.** The candidate is 9 commits ahead of `main` and has not been merged or deployed. |
| Working tree | Clean; local branches equal their GitHub copies. |
| Migrations | None in the candidate. `004_google_calendar_sync` (unused tables) is already on `main`. |
| Merged or deployed during this audit | **Nothing.** Branch pushes only. |

## Before deploying (the specific fixes)

1. ~~Production build of the final commit~~: **done.** Vercel's preview build of `57a4e0e` (the last code change) succeeded.
2. **Run CI on the candidate:** CI only runs on pushes to `main`/`social` and on pull requests, and the repository is public, so opening a pull request was left to you. It runs the real `vitest` and `vite build`.
3. **Set `NOMINATIM_USER_AGENT`** on Render to a name and a real contact email (Nominatim's usage policy). `render.yaml` now has a default.
4. **After deploying, verify live map data:** `GET /health` → `placesStatus.lastAnswer.provider` is `osm` or `nominatim`, never `mock`; `GET /v1/places/nearby?lat=14.5547&lng=121.0244&category=gym` returns places with `source: "osm"` (real names such as Anytime Fitness or Gold's Gym).

## Scorecard (release candidate)

| Category | Status | Evidence |
| --- | --- | --- |
| Build and type safety | **PASS** | `tsc --noEmit` clean in all 5 packages. The API production build (the exact esbuild command Render runs) succeeds. Vercel's real `vite build` succeeded for the final code commit `57a4e0e` (and for `a6823fa`). |
| Automated tests | **PASS WITH LIMITATIONS** | 433 of 435 unit/API tests pass; the 2 failures are proven environment-only (see the test report). 25/25 browser tests pass. CI has not run on the candidate (step 2). |
| Production configuration | **PASS WITH LIMITATIONS** | `render.yaml`: Node 22, `NODE_ENV=production`, health check `/health`, `PLACES_PROVIDER=osm`. CORS verified: the production build gives foreign origins no CORS header, and the live site reaches the live API. No development URLs or mock providers in production config. Secret values on Render and Vercel can't be inspected from here (**UNVERIFIED**), but the live API reports `accounts: true` (Supabase configured) and `smartAdd: false` (no Anthropic key). |
| Database and migrations | **PASS** | The candidate adds no migration. The migrate/rollback tests for 001–004 pass on Postgres 16. Rollback is a redeploy of the previous commit, with no schema change to undo. |
| Authentication and security | **PASS WITH LIMITATIONS** | 100 API tests, including cross-user access, blocking, visibility, sign-in required for the AI assistant, and assistant actions validated against the snapshot. No secret patterns in the frontend bundle. Request logs record the path only (no location query). Open: zod 3.25.76 advisory GHSA-mrhx-c7xc-m3w5 (HIGH, memory), mitigated by 256 KB / 64 KB body caps. Dependabot is off and there is no linter. |
| Live map and place data | **live: FAIL · candidate: PASS WITH LIMITATIONS** | Live `main` serves invented places (`source: "mock"`) in every area tested. Public Overpass servers answered "502 … at capacity" or timed out from a home connection. The candidate never serves mock data and falls back to Nominatim search. On real responses (16 searches in Makati and Quezon City) it returned real places only, within the radius, with no duplicates. From Render itself, Nominatim *reverse* lookups work (live `/v1/place-name`); Nominatim *search* from Render is **UNVERIFIED** until step 4. Opening hours exist for only about 10–30% of places. |
| Weather integration | **PASS WITH LIMITATIONS** | The live site shows current weather (26 °C, cloudy, Manila). The Open-Meteo → MET Norway chain and stale-data handling are tested. Forecasts are used for rain decisions, labelled as forecasts, and never promised when missing. |
| Rerouting engine | **PASS** | All 9 audit scenarios pass on real Makati places. The fixed-meeting regression passes through the production API build (5/5 checks). Overlapping calendar events are kept and flagged, and unreachable meetings are flagged. Property tests pass over random days. See the map and rerouting audit. |
| Calendar integration | **PASS WITH LIMITATIONS** | Read-only import into the plan (set-time blocks) is verified in browser tests with a faked Google. Real Google is **UNVERIFIED** here. Two-way sync is **not implemented** in the candidate (separate branch) and is not claimed. |
| Mobile and accessibility | **PASS WITH LIMITATIONS** | Browser tests run at phone size. All section tabs are visible at 360 px. Text buttons are at least 24 px. Conflicts use words and an icon, not colour alone. The assistant panel is keyboard-closable and returns focus. No automated axe scan (not installable here). The candidate's Vercel preview needs a Vercel login, so its UI wasn't inspected live; a local pixel comparison against `main` was done in the previous round. |
| Performance and reliability | **PASS WITH LIMITATIONS** | Engine about 210 ms for 12 blocks × 40 places. JavaScript is about 195 KB gzipped across chunks. With maps and weather down, the production API build still plans and says what's missing. Overpass rests after failing, so people don't wait for it. The Render free plan sleeps; a cold start can outlast the app's 9-second wait, and the phone then plans offline (tested). |
| Monitoring and recovery | **PASS WITH LIMITATIONS** | `/health` now reports which map source answered last and the latest failure, and provider failures are logged. No error-reporting service (none configured). Recovery: redeploy the previous commit; no data migration. |

## Test report

Commands as run on 2026-10-29. The sandbox can't install packages, so tests run on a small vitest-compatible runner over `node:test` (`tsx`), and the web bundle for browser tests is built with esbuild. CI uses real vitest and vite.

| Check | Command | Ran | Result |
| --- | --- | --- | --- |
| Lockfile / install | `pnpm install --frozen-lockfile` | No (no registry access) | UNVERIFIED here; Vercel and Render install from the lockfile |
| Typecheck | `tsc --noEmit -p .` in each package | Yes | 5/5 clean |
| Lint | — | No | No lint script or config exists (missing check) |
| Schemas | vitest-compatible runner | Yes | 7/7 |
| Engine (incl. property, scenario, real-world) | same | Yes | 65/65 |
| Providers (incl. Overpass failover, Nominatim, cache) | same | Yes | 68/68 |
| API (Postgres 16) | same, `TEST_DATABASE_URL` set | Yes | 100/100 |
| Web unit | same | Yes | 193/195. The 2 failures are `weather.test.ts` sky previews, which need `import.meta.env.DEV`; real vitest sets it, and `main`'s CI passed with them. Rerun with the flag supplied, both pass. Environment-only, not blocking. |
| Browser (Playwright, Pixel 7) | `playwright test` against an esbuild bundle | Yes | 25/25 |
| Engine benchmark | `tsx test/bench.ts` | Yes | 207–227 ms average |
| API production build | `esbuild src/server.ts --bundle …` (as `pnpm --filter @segue/api build`) | Yes | OK, 1.5 MB |
| API production smoke | built server, `NODE_ENV=production`, no network | Yes | `/health` OK; re-route plans with "Couldn't reach live map data…"; nearby answers 503; CORS refuses a foreign origin |
| Web production build | `vite build` | On Vercel | Success on `57a4e0e` and `a6823fa` (GitHub commit status "Deployment has completed") |
| Migrations | migrate/rollback tests | Yes | Pass |
| Dependency audit | OSV.dev query of the shipped dependency versions | Yes | zod 3.25.76: GHSA-mrhx-c7xc-m3w5 (HIGH). Dev-only: vite 5.4.21 (8 moderate, via vitest), esbuild 0.21.5 (moderate, via vitest). None in react, react-dom, pg, @anthropic-ai/sdk, vite 6.4.4. |
| Accessibility | scripted checks plus browser tests | Partly | No axe available |
| Live probes | live `/health`, `/v1/places/nearby`, `/v1/place-name`; Overpass and Nominatim from a home connection | Yes | See the map audit |

## Still unverified

Real Google Calendar and Google sign-in, the Anthropic AI mode (no key on the live API), Nominatim search from Render's network, the candidate's UI on its Vercel preview (behind login), CI on the candidate, and Render and Vercel environment-variable values.
