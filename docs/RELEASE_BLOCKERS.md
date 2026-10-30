# Release blockers and issues — 29 October 2026

Status as of 30 October 2026: the release (`reroute-intelligence`) is merged (`main` = `c6817f2`) and deployed. "Fixed" means fixed in code, covered by the named test, and live unless noted. Full evidence: [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md), [MAP_AND_REROUTING_AUDIT.md](MAP_AND_REROUTING_AUDIT.md).

## P0 — release blockers

| ID | Issue | Status |
| --- | --- | --- |
| RB-1 | **The live site serves invented places.** | Fixed and verified live on 30 Oct (`source: "osm"` everywhere) |
| RB-2 | **Public Overpass servers are at capacity, so without mock there'd be no places.** | Fixed |
| RB-3 | Commitments disappearing on re-route (audit `ENG-1`). | Fixed (audit branch); re-verified |

**RB-1.**
- *Evidence:* live `/health` = `cached(osm→mock)`; live `/v1/places/nearby` returned only `source: "mock"` places, with made-up hours, in Makati, Quezon City and Manila.
- *Reproduce:* `GET https://segue-api-qhgc.onrender.com/v1/places/nearby?lat=14.6760&lng=121.0437&category=gym`.
- *Expected:* real places, or an honest "no data".
- *Fix:* mock only with `PLACES_PROVIDER=mock`; phones ignore saved mock places.
- *Acceptance:* after deploy, `/health.places` has no `mock`, and nearby results are `source: "osm"`.
- *Tests:* `apps/api/test/api.test.ts` "never falls back to made-up places", `apps/web/test/trustedPlaces.test.ts`.

**RB-2.**
- *Evidence:* `overpass-api.de` answered 502 "at capacity"; two other public servers timed out at 15 s.
- *Fix:* Nominatim search fallback with exact tag queries and tag filtering; Overpass rests 10 minutes after failing; shared one-request-a-second gate.
- *Acceptance:* real places in Makati and Quezon City (verified on 16 live responses), nothing outside the radius, no duplicates.
- *Tests:* `packages/providers/test/nominatimPlaces.test.ts`, `packages/engine/test/realWorld.test.ts`.

**RB-3.**
- *Fix verified:* the 2:40 PM case through the production API build (5/5 checks); overlapping calendar events; unreachable meetings.
- *Tests:* `scenarios.test.ts`, `properties.test.ts`, `api.test.ts`, browser test "something came up right before a meeting".

## P1 — high priority

| ID | Issue | Status |
| --- | --- | --- |
| RB-4 | `GET /v1/places/nearby` answered **500 "Internal error"** when no map source answered | Fixed |
| RB-5 | An alternative could make you late for the next commitment | Fixed |
| RB-6 | Rain options offered two mall walks at the same complex (Glorietta, Glorietta 3), not the 24/7 gym 300 m away | Fixed |
| RB-7 | Wrong reasons for excluded places | Fixed |
| RB-8 | Assistant: "Find a gym near me that's open now" described the planned gym instead of searching | Fixed |
| RB-9 | CI has never run on the candidate | Fixed: CI green on pull request #2 |
| RB-10 | `zod@3.25.76` has advisory GHSA-mrhx-c7xc-m3w5 (HIGH): memory exhaustion from oversized arrays | Open, mitigated; shipped with the release |
| RB-11 | Nominatim search from Render's own network is unverified | Verified live on 30 Oct |
| RB-22 | Nominatim refused every search with 429 right after deploy (29 Oct), and Segue kept asking | Fix in pull request #3 (back off for `retry-after`, 5–30 min); not merged yet. `NOMINATIM_USER_AGENT` with a contact email still to set |

**RB-4.** Now **503** `places_unavailable` with a plain message, and `/health.placesStatus` shows the failure.
- *Test:* `api.test.ts` "when no map source answers".

**RB-5.** The planner's 5-minute grace for set times applied to alternatives, so a shorter workout ended at 6:30 PM with dinner at Greenbelt at 6:30. Alternatives now get no grace.
- *Test:* `realWorld.test.ts` scenario 2.

**RB-6.** Options now cover each substitute kind (a gym *and* a mall walk), and places within 150 m count as one trip.
- *Test:* `realWorld.test.ts` scenario 1.

**RB-7.** A place you said was unavailable read "Wouldn't leave time for dinner", and running out of day read "too far". Both now give the real reason.
- *Tests:* `realWorld.test.ts` scenarios 2 and 6.

**RB-8.** "Find …" now always searches, with "open" meaning open by listed hours.
- *Test:* `assistant.test.ts` "plain-language requests from the audit".

**RB-9.** CI only runs on pushes to `main`/`social` and on pull requests, and the repository is public, so a pull request needs your OK.
- *Acceptance:* CI green on the final candidate commit (real vitest, `vite build`, bench).

**RB-10.** Request bodies are capped at 256 KB (64 KB for the assistant), and most arrays have length limits, so the practical risk is low.
- *Fix:* upgrade to zod ≥ 4.6.6. It's a major version, so it's planned work, not a release-day change.
- *Acceptance:* the advisory no longer applies, and schema tests pass.

**RB-11.** The live `/v1/place-name` proves Render reaches the same Nominatim host.
- *Acceptance:* the post-deploy check in DEPLOYMENT_READINESS, step 4.

## P2 — quality

| ID | Issue | Status / next step |
| --- | --- | --- |
| RB-12 | Only about 10–30% of places in OpenStreetMap have opening hours; some entries are stale ("ASpace (moved to the Astbury…)") | Shown honestly as "hours not listed". Google Places (paid) for better hours. |
| RB-13 | "About 49 min late" for a 40-minute visit you'd only reach after it ends | Fixed: "You can't get there before it ends at 3:00 PM" (`scenarios.test.ts`) |
| RB-14 | Quick add didn't read durations in words ("two hours") and kept "I need to" in titles | Fixed (`quickAdd.test.ts`) |
| RB-15 | Assistant: "I need to finish … before 7 PM", "I only have 30 minutes before class" and "I need to study…" weren't understood | Fixed (`assistant.test.ts`) |
| RB-16 | No in-app map: places are names with a Directions link | Product decision. A map would need a tile provider and a privacy review. |
| RB-17 | No error-reporting service; Dependabot off; no linter | Turn on Dependabot alerts (free); add a linter; choose an error reporter if wanted |
| RB-18 | Render free plan cold start can exceed the app's 9 s wait | The phone plans offline and says so (tested). A paid instance or a keep-warm ping removes it. |
| RB-19 | "Somewhere quiet near my next meeting" searches near you, not near the meeting | Small change in the assistant (search origin = the next stop) |
| RB-20 | vite 5 / esbuild 0.21 advisories | Dev and test tools only (under vitest 2); not shipped. Upgrade vitest. |
| RB-21 | Two-way Google Calendar sync | Not in this release (branch `calendar-sync`); read-only import is what ships, and the privacy policy says so |
