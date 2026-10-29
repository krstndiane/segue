# AI assistant — implementation report (branch `ai-assistant`)

**Not merged or deployed.** This branch starts at `main` = `c6817f2` (the rerouting release) and is for review only. Release documentation is separate: [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md).

## How the assistant works

The assistant already existed in the release (panel, plain answers, optional AI wording). This branch makes it understand the requests in the brief, using the planner's own services rather than a separate set of rules:

| Need | Service it uses |
| --- | --- |
| Read today's schedule | the day's plan and blocks on the phone (`AssistantContext`) |
| Find nearby places | `GET /v1/places/nearby` (real OpenStreetMap data), or places saved on the phone when offline |
| Weather | the sky the app already fetched; stale or missing weather is said to be unknown |
| Opening hours | `openStatusAt` over listed hours; "open" is claimed only from listed hours |
| Travel, feasibility, fixed commitments, alternatives | the alternatives engine (`/v1/alternatives`, or on the phone offline) |
| Rebuilding the day | the normal re-route, which shows a proposal before anything changes |

Answers come from `apps/web/src/lib/assistant.ts` (`answer`), which is pure and has no network access. Anything that needs a lookup is returned as `run` and carried out by the panel. Anything that changes the plan is a button, and changes need a "Yes", or go through the re-route proposal's "Use this plan".

## What changed on this branch

| Request | Before | Now |
| --- | --- | --- |
| "I need a quiet place with Wi-Fi to study." | Answered with the next item | Searches libraries. Places that list Wi-Fi or quiet on the map come first. If none do, it says so instead of implying they have Wi-Fi |
| "Find a café open now within 1 km." | Searched 2 km and ignored "1 km" | Searches within 1 km, shows each place's distance, and treats "open" as open by listed hours |
| "It's raining. Find somewhere indoors where I can work out." | Searched gyms | Same, plus a button for rain options for the outdoor item still planned |
| "Finish this report before 7 PM." | Echoed the item | Checks the deadline: "Yes: … before 7 PM", or how much it misses by |
| "My meeting is running late. Fix my schedule." | Summarised the day | Asks one question, "About when will Team meeting end?", then offers to keep that time free and rebuild the rest. The meeting never moves; the user sees the proposal first. Also handles "running over until 3:30" in one message, "I'm running late" (start 15 min later), and a meeting that isn't in the plan |
| "That place is closed. Find another one." | "Didn't catch that" | Options for the item at that place, with the place left out |
| "I don't want to travel far." | "Didn't catch that" | Options for the next item with a place, least travel first, with trip times |
| "What should I do next?" | Next item | same |
| "Why did you recommend this place?" | Listed things that didn't fit | Explains from what the planner knows: what the item needs, the trip estimate, listed-hours status, and backups |
| "I have 30 minutes before class." (no class planned) | Talked about dinner as if it were the class | "I don't see a class in today's plan." Then the next set-time item |

Code: `apps/web/src/lib/assistant.ts`, `apps/web/src/components/AssistantPanel.tsx`, `apps/web/src/lib/replan.ts` (the "Something came up" block can now run until a given time), `apps/web/src/App.tsx` (search radius; the re-route proposal with a running-over block).

## Safety and privacy

- **Nothing changes without confirmation.** Option swaps and moves need "Yes". Running over opens the re-route proposal, which needs "Use this plan". Set-time and calendar items are never moved (browser test below).
- **AI mode** (`POST /v1/assistant`, unchanged here) only rewords Segue's own answer. It sees a small snapshot of today: titles, times, place names, reasons and options. It never gets location, notes or other days. It needs a signed-in user and has per-user and daily caps. Any action it suggests must point at an item or option in the snapshot, and the phone still asks first. If the AI fails, times out or is off, the plain answer is used.
- **No made-up places:** mock places are never shown by default. Wi-Fi, quiet and opening hours are only claimed when the map lists them.

## Tests

| Check | Result |
| --- | --- |
| Typecheck, 5 packages | PASS |
| Web unit tests | 209/211. The 2 failures are the sky-preview tests, which need `import.meta.env.DEV`; real vitest sets it, and they passed in CI on `main` |
| New assistant tests (`assistant.test.ts`) | 15 new tests, all pass: each request above, distance and Wi-Fi in place answers, never claiming unlisted Wi-Fi, never showing mock places, least-travel ordering |
| `replanNudges.test.ts` | New: the running-over block lasts exactly as long as asked, never past the end of the day, and falls back to an hour |
| Browser tests (Pixel 7) | 26/26, including the new "my meeting is running late": asks when it ends, the proposal keeps the meeting, and "Read" moves to 3:30 PM only after "Use this plan" |
| API tests | 100/100 (unchanged code) |
| CI | Runs on the pull request |

## Configuration

| Environment | To enable AI wording | Otherwise |
| --- | --- | --- |
| Development | `ANTHROPIC_API_KEY` in `apps/api` env; optional `ASSISTANT_MODEL` (default `claude-haiku-5-5`) | Plain answers |
| Preview / production (Render) | `ANTHROPIC_API_KEY` secret; optional `ASSISTANT_RATE_LIMIT` (default 60 per user per hour), `ASSISTANT_DAILY_CAP` (default 500 a day overall) | `/health` shows `assistant: "basic"` |

Production currently has no Anthropic key (`/health`: `assistant: "basic"`, `smartAdd: false`), so **AI wording is not live**. Everything on this branch works without it.

## Not done yet

- Search near the next meeting instead of near you ("somewhere quiet near my next meeting").
- "I don't want to travel far" as a lasting preference, rather than a one-time request.
- AI mode with a real key: untested here (no key).
- No automated accessibility scan; the panel keeps its existing keyboard and focus behaviour.
