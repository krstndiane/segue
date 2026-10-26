# Re-route intelligence, live places and the planning assistant — October 2026

Branch `reroute-intelligence`, built on `audit` (which keeps the fix that stops commitments disappearing). **Not merged, not deployed.** This is the handoff: what changed, how it was checked, what still needs real-world verification, and how to ship it.

## What was wrong (verified)

| ID | Finding | Evidence |
| --- | --- | --- |
| LIVE-1 | **The live site served invented places.** When OpenStreetMap's Overpass server refused the API, the chain fell back to the built-in mock provider and cached the result for 24 h. | `GET /v1/places/nearby` on the live API near Makati returned "Iron Box", "Night Lift", "Core Studio", "Pulse Fitness", all `source: "mock"`, with made-up hours and ratings. `/health` said `places: cached(osm→mock)`. |
| LIVE-2 | Phones saved those places for offline planning. | `placeCache` stores whatever the server sent. |
| ENG-5 | Re-routing could only rebuild the whole day; there was no way to ask "what can I do instead of *this*?" (indoor option, another open gym, shorter, later). | Code review: `reroute()` only. |
| PROD-1 | Writing, studying and emails were turned into "needs a café with Wi-Fi", so people saw "No café fits right now" for writing at home. | `quickAdd.ts`, smart-add prompt. |
| — | No planning assistant existed. Smart add (and therefore any AI) is **off** on the live API (`smartAdd: false`). | `/health` |

## What changed

**Live place data** (`packages/providers`, `apps/api/src/providers.ts`)
- Real modes never fall back to made-up places; mock is only for `PLACES_PROVIDER=mock`. When no map server answers, the plan says "Couldn't reach live map data for gyms right now" and uses the no-place version.
- Overpass: tries `overpass-api.de`, then `overpass.private.coffee`, within a 9-second budget, starting with whichever answered last. `OVERPASS_URLS` overrides. Each failure is logged, so Render's logs now say why OpenStreetMap failed.
- Every place carries `fetchedAt` (kept on cached answers). Empty answers are cached for 1 h, not 24 h. Duplicates are merged and broken coordinates skipped. Google's permanently closed places are dropped, and temporarily closed ones are marked and never planned.
- `openStatusAt()`: open / closed / unknown / temporarily closed, from **listed** hours only.
- Phones ignore mock places saved from the old server.

**Feasibility engine for one item** (`packages/engine/src/alternatives.ts`, `POST /v1/alternatives`)
- Holds the rest of the day in place. It tries other places of the same kind, substitutes (park → gym or indoor mall walk; café, library and coworking stand in for each other), the no-place version (indoors when it rains), the same plan once the forecast says it's drier, and a shorter version before the next commitment.
- Each option is checked by simulating the whole day. That covers travel from where you'll be, listed hours, the next commitment, the item's window, and the weather. Options are placed as close as possible to the original time.
- Facts are tagged *hard*, *preference*, *unknown* or *tip*, plus trade-offs. Places that don't work are listed with the hard reason.
- Never: replace or move a commitment, offer the current plan as an "alternative", suggest outdoor activity in a reported thunderstorm or at a feels-like of 42 °C or more, or promise drier weather without a forecast.
- The server searches near where you'll be just before the item (the previous stop), not only where you are now.

**In the app** (smallest additions, existing components and tokens)
- Item details: *Closed, raining or short on time? See other options* (flexible items). The rain nudge: *See options*.
- The options sheet: time, trip, listed hours, room before the next commitment, unknowns, trade-offs, *Not this place*, *How much time do you have?*, *Keep my plan*. *Use this* changes only that item, pins it, and can be undone. Offline it runs on the phone with saved places.
- Quick add and smart add: work and study are *Anywhere* unless a café, library, Wi-Fi, outlets or quiet is mentioned (enforced in code after the model, too).

**Ask about your day** (`AssistantPanel.tsx`, `src/lib/assistant.ts`, `POST /v1/assistant`)
- A chat button next to Settings opens a side panel (wide screens) or a full-screen panel (phones) over the page. The Today layout isn't changed.
- **Basic mode (default, free, offline-capable):** answers from the plan and the alternatives engine. Example questions: what's next, my next commitment, free time this afternoon, why did you move X, why doesn't X fit, can I still finish X before 7 PM or before dinner, what can I do instead of running in the rain, find a gym open now, reorganize the rest of my day (opens the proposal), move X to 4pm (asks first), weather (says when stale), sync status. It also handles follow-ups: "the second option", "can it be closer?", "what if I only have 30 minutes?", "why is that better?", "use that one".
- It never changes anything without a *Yes*. It refuses to move set-time items or calendar events, notices when the plan changed since options were shown, and says plainly when it can't answer.
- **AI mode (optional):** when the API has `ANTHROPIC_API_KEY` and Supabase sign-in, signed-in users get answers worded by Claude, but only from a small snapshot of today (no location, notes or other days). The defaults: model `claude-haiku-5-5`, 60 answers per account per hour, 500 a day overall. Any action the model suggests must point at an item or option in the snapshot, and the phone still asks for confirmation. Any failure falls back to the basic answer.

## Tests (run in this sandbox)

| Suite | Result |
| --- | --- |
| Typecheck, 5 packages | clean |
| engine | 55/55: alternatives (open gym fits; closes too soon; closed; temporarily closed; too far; unknown hours; study at home; library instead of a far café; rain → gym, mall walk, indoor workout at home, later; user-reported rain without a forecast; dangerous weather; shorter before dinner; nothing fits; commitments untouched; "not this place"; "only 30 min"; deterministic; current plan never offered), plus the audit's scenario and property tests |
| providers | 63/63: Overpass failover, time budget, hung server, error remark, no mock, broken coordinates, dedupe, `fetchedAt`, closures, cache times, open status incl. past midnight |
| api (Postgres 16) | 99/99: `/v1/alternatives` (storm, map data down, bad request), `/v1/assistant` (off by default, sign-in required, malformed input, action validation incl. set-time items and unknown ids, model failure → 502, per-account limit), no-mock wiring, work/study tidy |
| web unit | 187/189: alternatives (offline path, no mock places, server answer, refine, apply, rain nudge), assistant (19 cases), quick add. The 2 failures are the sky-preview tests, which need Vite's dev flag and fail only in this sandbox's test runner |
| browser (Playwright, phone size) | 25/25, incl. new: assistant answers, refuses to move dinner, moves Read only after Yes; other options offline with *Keep my plan* |
| Manual browser runs against a local API | Other-options sheet end to end; assistant at phone and desktop sizes; Esc closes and focus returns; no console errors |
| UI comparison with `main` | Pixel diffs of landing, setup, Today, Plan, Calendar, Routines, item details and Settings at 360, 412 and 1280 px. Unchanged apart from: the audit's phone tab row (about 50 px shift) and 24 px text buttons (about 4 px shift), the new chat button, and the *See other options* link in item details. The landing page's privacy wording and the privacy policy changed after this comparison (text only) |

## Not verified here (needs the real services)

- **Whether Overpass answers Render now.** This sandbox can't reach OpenStreetMap. After deploying, check the Render logs for `places: … failed` lines and call `/v1/places/nearby` to see `source: "osm"`.
- Live weather, Google Places and the AI assistant with a real Anthropic key (all mocked in tests).
- A real `vite build` (an esbuild bundle was used for browser tests; Vercel's build is the first real one).

## Known limitations

- Hours are the places' **listed** hours, not live availability; temporary closures are only known when Google reports them or OSM tags `opening_hours=closed`.
- Travel times are estimates (with rush hour), not live traffic or transit.
- With no forecast, Segue won't suggest "later, when it's drier".
- Rejected places are remembered for the day on this device only.
- The assistant's basic mode understands the phrasings in its tests and close variants; unusual wording gets an honest "I didn't catch that" with examples.
- Calendar-linked events are read-only: two-way sync is a separate branch (`calendar-sync`).

## Deploying (after you approve the merge)

1. Merge `audit`, then `reroute-intelligence`, into `main` (fast-forward; `reroute-intelligence` already contains `audit`).
2. No new required environment variables. Optional: `OVERPASS_URLS`; for AI mode, `ANTHROPIC_API_KEY` (set a monthly spend limit first), `ASSISTANT_MODEL`, `ASSISTANT_RATE_LIMIT`, `ASSISTANT_DAILY_CAP`.
3. No database migration.
4. After Render deploys: `/health` should show `places: cached(osm)` (no `mock`) and `assistant: basic`. Try `/v1/places/nearby?lat=14.5547&lng=121.0244&category=gym`, then read the Render logs.
5. The privacy policy and landing page already describe the new data flows (Overpass servers, AI assistant).
