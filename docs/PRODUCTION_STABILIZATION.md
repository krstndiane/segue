# Production stabilization — 30 October 2026

Google Calendar on Today, the assistant kept out of production, Together, and one-tap task actions. **Recommendation: READY AFTER SPECIFIC FIXES**: the owner's review and merge, then a check with a real Google account (see the end).

| | |
| --- | --- |
| Live now | `main` = `c6817f2` (the rerouting release). Not changed by this work. |
| Release candidate | `stabilize` (pull request [#5](https://github.com/krstndiane/segue/pull/5)), which includes the Nominatim back-off from #3. On top of it: `task-actions` ([#6](https://github.com/krstndiane/segue/pull/6)). |
| Assistant | `ai-assistant` (`1ea0c03`, pull request [#4](https://github.com/krstndiane/segue/pull/4)), not merged and not deployed |
| Migrations | `005_join_requests`, `006_today_progress`: additive only (new columns and allowed values); down migrations tested |
| Merged or deployed by this work | Nothing |

## 1. The assistant is out of production

| Check | Result |
| --- | --- |
| Production UI | **PASS**. The panel is built in only when `VITE_ASSISTANT=on` at build time, so a production build drops its code. Nobody can switch it on from the browser. |
| Build guard | **PASS**. `pnpm --filter @segue/web build` now runs `scripts/check-build.mjs`, which fails if assistant code is in the build. CI's real `vite build` passed with it on the candidate. |
| API | **PASS**. `/v1/assistant` stays off (404) unless `ASSISTANT_AI=on`, even with an Anthropic key (smart add uses that key). Test: `api.test.ts`. |
| Where it lives | `ai-assistant`. Its previews need `VITE_ASSISTANT=on` once it takes in this change. Browser tests build it in, so its tests keep running. |

## 2. Google Calendar on Today

**Root cause.** Google's access token lives only in the page's memory (about an hour) and nothing synced on its own. So on every new day, or after any reload, the saved events were an earlier day's. A re-route then left them out ("Calendar hasn't synced today"), and tapping Sync in Settings never touched a plan that already existed. Together, Today showed no calendar events even when Google had them. The client ID is set in production (checked in the live bundle), so the setup isn't the problem.

**Fix (Google → Segue, read-only):**
- **Automatic refresh:** on opening the app, on coming back to it, and every 15 minutes while Google's sign-in is live.
- **One-tap refresh:** otherwise Today says "Today's Google Calendar isn't loaded yet" with **Refresh calendar**. Google needs a tap to sign in again, about once an hour.
- **Changes shown on Today:** events added, moved or deleted in Google since the plan was made appear on Today, with any overlaps. **Update my plan** opens the usual proposal; nothing changes without review. A day's first plan includes events straight away.
- **All-day events:** shown, never blocking time.
- **More than 250 events:** every page is read.
- **Rate limits:** Google's limits read "busy, try again", not "no permission".
- **Failures:** the last good events are kept and say when they're from.

| Check | Result |
| --- | --- |
| Automated (Google's answers mocked) | **PASS**. 18 tests: time zones (also run under New York and Manila), daylight saving, overnight, all-day, recurring, pagination, expiry, revoked access, rate limits, outages, duplicate syncs, added/moved/deleted events, calendar events as fixed blocks. Browser test: the next morning, one tap, then Update my plan. |
| Real Google account | **UNVERIFIED**. Not tested with a real calendar from here. |
| Sync direction | **Read-only.** Segue never writes to Google Calendar. Two-way sync is **not implemented** (see below). |

**Two-way sync and background refresh need a server-side Google connection:**
- the code flow with refresh tokens stored encrypted (migration 004 already has unused tables)
- a Google client secret on Render
- a redirect URI in Google Cloud
- the `calendar.events` write scope, which needs Google's app verification
- rules for who owns each event

That work needs the owner's Google Cloud access and is not started.

## 3. Together

| Change | Detail |
| --- | --- |
| **Overview** tab (opens first) | What needs your answer (invitations, requests to join your plans); plans you've agreed with people (one row per plan, who's in it, clashes with your calendar); plans your people shared that you can ask to join. Built only from what the server lets you see; a clear empty state otherwise. |
| "Can I join?" | Replaces "Interested". Asking is clearly not agreeing. The owner can **Say yes** (time optional), which makes it a plan both are in, or **Not this time**. Nobody's own day changes. |
| Open to join | Shared plans can refuse requests. The server enforces it. |
| Server | `POST /v1/notes/:id/interests/:id/accept` and `/decline`: author only, in a transaction, refused if sharing was taken back, someone blocked someone, it was already answered, or the plan isn't open. Notifications `join_accepted`, `join_declined`. |

| Check | Result |
| --- | --- |
| Postgres API tests | **PASS**. 7 new: yes, interest alone, not this time, who may answer, closed plans, revoked sharing and blocking, times. |
| Two people, real API, production-style build, phone size | **PASS**. Ben sees Ana's shared plan (not her closed or private ones), asks, and nothing is confirmed. Ana sees the request, says yes with a time, and both see "Plans together". Ben is notified. Neither person's own plan changes. Empty state for someone with no people. No page errors. |
| Push notifications | **Not configured.** Requests and answers show in the app (Overview and Updates). |
| Limitation | Shared plans have a day but no time, so "Alex is studying until 4 PM" can only be shown for agreed plans, which have times. |

## 4. Today: one-tap done, skips that keep the day (`task-actions`)

| Change | Detail |
| --- | --- |
| ✓ beside every task | One tap, 44 px. Labelled "Mark ‹task› as done" for keyboards and screen readers. Repeat taps are ignored. Undo on the notice; a "done and skipped" list with **Bring back**. |
| Skip | Marks it skipped. **Nothing else moves.** The notice offers **Move tasks up**; ignoring or dismissing it changes nothing. |
| Move tasks up | The same tasks in the same order, earlier where realistic. It counts the trip from the previous stop, "not before" times and listed opening hours. Set times, calendar events, pinned items and anything underway never move. A preview comes first, with **Apply changes** or **Keep current schedule**, and Segue checks again before applying if the plan changed meanwhile. |
| Calendar events | No done or skip: their status is Google's. |
| Across devices | Today's done and skipped items sync to the account (key `today`; the latest change wins, so an undo sticks). Calendar ids stay on the device. Done items are saved on the device at once and sent when online; the sync status in Settings says if that hasn't happened yet. |

| Check | Result |
| --- | --- |
| Unit | **PASS**. Move-up rules, stale plans, sync merge. |
| API | **PASS**. `today` shape is checked, calendar ids are stripped, version conflicts are caught. |
| Browser | **PASS**. ✓ by mouse, double tap and keyboard; survives a reload; Bring back; skip leaves times unchanged (also after reload); Keep changes nothing; Apply does exactly what was previewed; calendar events have no ✓. |
| Two phones, one account, real API | **PASS** (3 runs). Done on one shows on the other; bringing it back on the second shows on the first. |
| Task dependencies | **Not applicable.** Segue's tasks have no dependency model. Move-up keeps the existing order. |

## Tests on the candidate (`task-actions` head)

| Check | Result |
| --- | --- |
| Typecheck, 5 packages | PASS |
| Engine / schemas / providers | 65/65, 7/7, 70/70 |
| API (Postgres 16) | 109/109 |
| Web unit | 227/229. The 2 sky-preview tests need `import.meta.env.DEV`; they pass in CI. |
| Browser (Pixel 7) | 28/28 |
| CI (real vitest, vite build, build check, bench) | PASS on `stabilize`. `task-actions`: see #6. |
| Lint | No linter configured |
| Security | No new dependencies. zod 3.25.76 advisory (HIGH) still open, mitigated by body size caps. |

## What the owner needs to do

1. Review and merge [#5](https://github.com/krstndiane/segue/pull/5), then [#6](https://github.com/krstndiane/segue/pull/6). Close #3; #5 includes it. Merging needs your approval; it was not done here.
2. After deploy: open Segue with your Google account, check today's events appear on Today, and change an event in Google to see it flagged.
3. Set `NOMINATIM_USER_AGENT` on Render with a contact email.
4. For the assistant's preview builds, set `VITE_ASSISTANT=on` on the `ai-assistant` preview environment only.
5. If you want two-way calendar sync: a Google Cloud client secret, a redirect URI and app verification (section 2).
