# Segue audit — October 2026

A product, engineering, security and UX audit of Segue as it is on `main`, with the fixes made so far. Everything marked **verified** was run or reproduced; everything else says why it isn't. Continue from **Next steps** rather than starting over.

## 1. What Segue does today

A day planner for people who move around a lot. You say what you want to do in plain words; Segue plans the rest of today around fixed commitments, travel, opening hours, weather and energy, and re-plans in one tap when something changes. It runs offline on the phone (the same engine as the server), and accounts add sync and a small social layer (notes, hearts, invitations, mutual connections).

**Its real advantage** is the re-route loop: *something changed → one tap → a proposal with reasons that you accept or undo*. The audit's fixes protect that loop's trustworthiness first, because a re-plan you can't trust with your meetings is worse than none.

## 2. Feature inventory

| Feature | Status | Evidence |
| --- | --- | --- |
| Plain-words add (`quickAdd.ts`) | Working and verified | unit tests; browser flows |
| First-run setup, example day | Working and verified | browser flows |
| Today timeline, Next up, swipe done/skip, undo | Working and verified | browser flows |
| Hour-by-hour Plan, drag to move (pins it) | Working and verified | browser flows |
| Re-route with reasons (late, rain, tired, elsewhere, something came up) | Working and verified (**was broken** with commitments, see ENG-1) | engine scenarios, browser flow |
| On-device re-route when offline | Working and verified (API unreachable in browser tests) | browser flows |
| Engine: hours, travel, rush hour, rain, energy, fallbacks, alternatives | Working and verified | 38 engine tests incl. property test |
| Weather sky, precautions, location following | Working and verified with fixtures | unit + browser tests |
| Google Calendar, read-only, in the browser | Implemented, verified with a faked Google | browser flow; real Google not exercised here |
| Google Calendar two-way sync | **Missing**. Database tables only (migration 004, unused) | branch `calendar-sync` |
| Accounts (Supabase), cross-device sync of routines/settings/history/past days | Implemented, verified locally | API tests on Postgres, earlier browser flows; real Supabase unverified here |
| Profiles, photos, usernames, mutuals, blocking, notes, hearts, invitations | Implemented, verified locally | 86 API tests with permission checks |
| Smart add (Claude) | Implemented but unverified | needs `ANTHROPIC_API_KEY`; mocked in tests |
| Places (OSM, Google Places, mock) + cache/budget | Implemented; providers verified with fakes | 48 provider tests; live OSM/Google not called here |
| Reminders with the app closed (push) | **Missing** (documented) | needs a push server |
| Today's plan on a second device | **Missing**: only routines, settings, history and *past* days sync | `SYNC_KEYS` in `syncMerge.ts` |

## 3. Strong decisions, keep them

- **Pure, deterministic engine** shared by server and phone, with a property test over random days. This is why offline re-route works; don't move logic out of it.
- **Proposal, not imposition**: every re-route is previewed with a change list, can be undone, and fixed items never move.
- **Plain-words copy and explanations** throughout; errors are written for people.
- **Server-side authorization for every social action**, parameterised SQL, rate limits, body caps, strict CSP. All covered by tests.
- **Small dependency surface** (no framework on the API, a 30-line IndexedDB wrapper).

## 4. Risks

- **Real-service gaps**: Google, Supabase, Anthropic and live places are only exercised with fakes in this environment. The first real build is Vercel's (`vite build` can't run in this sandbox; an esbuild bundle was used for browser tests).
- **Sync semantics**: lists merge by id; something deleted on one device can come back if another device edited the same list offline (SYNC-1). Safe direction, but surprising.
- **Two-way calendar sync** is the largest planned change and touches privacy promises; it's on its own branch and must not ship half-done.

## 5. Issues and roadmap

Severity: P0 critical · P1 high impact · P2 product quality · P3 opportunity.

| ID | Sev | Area | Issue | Status |
| --- | --- | --- | --- | --- |
| ENG-1 | P0 | Planner | A fixed commitment silently disappeared from the plan when you couldn't reach it in time, when two commitments overlapped, or after *Something came up*; a flexible item could then be planned on top of it, and the reason shown was wrong ("Clashes with another fixed block") | **Fixed** |
| UX-1 | P1 | Mobile | On 360 px phones the Routines tab was entirely off-screen with no sign it scrolled; cut off at 390–412 px | **Fixed** |
| A11Y-1 | P1 | Accessibility | Text buttons (*Keep my current plan*, *End time and travel settings*, *Remove*, *Back*, *Try an example day*) were 20 px tall, under WCAG 2.2's 24 px | **Fixed** |
| ENG-2 | P2 | Planner | Wrong reasons for things that didn't fit: "Its window ended at 5:00 PM" when it hadn't (only too short), "Not enough time" when every gym was closed | **Fixed** |
| TEST-1 | P3 | Tests | Landing-page browser test depended on the hour it ran | **Fixed** |
| ENG-3 | P2 | Planner | Days are packed back to back: 4.5 h of work with no gap, a 6 h evening filled solid. No breaks or transition buffer | Open: needs a product decision (see Next steps) |
| PROD-1 | P2 | Product | "work, study, write, emails, review, code" become *café with Wi-Fi and power*, so offline or far from cafés the user sees "No café fits right now" for writing a report at home | Open: decision |
| SYNC-1 | P2 | Data | Deleted routines or places can come back after an offline edit on another device (merge by id, no tombstones) | Open |
| SYNC-2 | P2 | Product | Today's plan doesn't follow you to a second device, though the README says "keep your plans on every device" | Open |
| CAL-1 | P1 | Integration | Two-way Google Calendar sync not built (read-only works) | In progress on `calendar-sync` |
| ENG-4 | P3 | Planner | No memory of suggestions you rejected; the same re-plan can be offered again | Open |
| QA-1 | P3 | Parser | "10pm-1am" isn't read as a time range (it becomes a loose 1 h item), and the form refuses times past midnight | Open |

**Why ENG-1 came first:** it's the one failure that can make someone miss a meeting because of Segue: the meeting vanished from Today, so no *Time to leave* nudge fired, and the "won't fit" reason pointed the wrong way.

### ENG-1 detail

- **Reproduce (before the fix):** at 2:40 PM with "Client meeting 3pm-4pm" and "Write report 2h", tap *Re-route from here → Something came up*. The preview said "Client meeting dropped — Clashes with another fixed block", "Won't fit: Client meeting", and moved *Write report* to 3:40 PM, inside the meeting. A meeting 8 km away at 2:30 PM, re-planned at 2:00 PM on foot, also vanished.
- **Expected:** commitments never move and are never dropped; the conflict is stated, and the user decides.
- **Fix:** the solver keeps every commitment and measures, once, how late you'd unavoidably be and whether it overlaps the one before. Those amounts are allowed, nothing more: a flexible item can't be put in front of a commitment to make it later, and can't overlap anything. Each affected item carries `conflict` ("Overlaps Class (3:00 PM–4:00 PM)", "You can't get there by 2:30 PM: about 25 min late"). The app shows it in words with an icon (never colour alone) on the Next-up card, timeline rows (and their screen-reader label), the re-route preview, *Why this?*, and the hour grid, where clashing items sit side by side.
- **Acceptance:** the property test now also checks that every commitment still to come is in the plan and that only two clashing commitments may overlap, both flagged; 9 new scenario tests; API test; browser test of the exact flow above. All pass.

## 6. Planner scenarios (`packages/engine/test/scenarios.test.ts`)

| Scenario | Result after fixes |
| --- | --- |
| Meeting you can't reach in time | Stays, flagged "about N min late", nothing scheduled before it |
| Two overlapping commitments (and one inside a long one) | Both stay, both flagged against the right one |
| *Something came up* right before a meeting | Meeting stays and is flagged; flexible work moves after it |
| Overbooked day | Must-do kept, rest filled, each leftover says "Not enough time left before 10:00 PM" |
| Deadline today | Placed before the deadline; if impossible, "Needs 60 min, but only 30 min left before 5:00 PM" |
| Missed morning routine | "Its window ended at 9:00 AM" |
| Closed venue | "Every gym nearby is closed for the rest of today" |
| Long trip | Travel counted; no false flag when you can make it |
| Bad weather | Existing test: outdoor blocks move away from rain or to their indoor version |
| Repeated rejection, recurring exceptions, offline calendar edits | Not covered: ENG-4 and CAL-1 |

Engine speed is unchanged: about 200 ms for 12 blocks × 40 places on this machine, before and after.

## 7. Security and privacy

Verified by tests or reading: every social route checks the signed-in user server-side (86 API tests cover cross-user access, blocking, visibility); SQL is parameterised (`p()` helper, no string-built values); avatars are checked by magic bytes and size; rate limits on re-route, smart add, writes and username checks; CSP and security headers on Vercel; the Google token stays in browser memory; precise location never syncs. No critical issue found. **Not verified here:** dependency vulnerability scan (no registry access from this sandbox; run `pnpm audit`), and real Supabase/Render configuration. When two-way calendar sync ships, the privacy policy, landing privacy section and ARCHITECTURE privacy paragraph must change together (they currently promise read-only and no stored Google tokens).

## 8. Test report

| Suite | Before | After |
| --- | --- | --- |
| Typecheck (5 packages) | clean | clean |
| schemas | 7/7 | 7/7 |
| engine | 26/26 | 38/38 |
| providers | 48/48* | 48/48 |
| api (real Postgres 16) | 85/85 | 86/86 |
| web unit | 158/160* | 158/160* |
| browser (Playwright, Pixel 7, esbuild bundle) | 20/21 | 23/23 |

\* Run with a vitest stand-in on `node:test` (vite's native binaries can't install here). After adding `it.each` to the stand-in, providers show 48 instead of 33. The 2 web failures are the sky-preview tests, which rely on Vite's `import.meta.env.DEV` being true under vitest; they test a development-only feature and fail only in the stand-in. Run `pnpm test` and `pnpm e2e` on a normal machine to confirm.

## 9. Known limitations

Real Google, Supabase, Anthropic and live places/weather weren't called from this environment. No automated accessibility scanner was available (checks were scripted: accessible names, labels, alt text, 24 px targets, plus the existing WCAG contrast unit tests). Push reminders with the app closed, two-way calendar sync and today's plan on other devices aren't built.

## 10. Next steps

1. **Decide ENG-3 (breaks).** Proposal: a default 10-minute buffer after anything over 60 min and a protected lunch window, both switchable in Settings; fully explainable ("Kept 10 min free after Deep work"). Low risk in the engine (a minimum gap in `simulate`).
2. **Decide PROD-1.** Proposal: plain "work/write/study" stays *Anywhere*; only "at a café", "laptop at…", or a saved spot asks for a place.
3. **Finish CAL-1** on `calendar-sync` (server OAuth, sync engine, webhooks, conflict view), behind the Google verification you'll submit.
4. **SYNC-1/2:** tombstones for deleted items, and sync today's plan.
5. **ENG-4:** remember rejected re-plans for the day and don't offer the same one again.
