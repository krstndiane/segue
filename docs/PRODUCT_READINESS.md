# Product readiness (1 November 2026)

This is the Phase 1 audit, checked against the code on `main` (`c5f511b`) and the live site. The status column is updated as work lands.

## Live state

| Item | What was found |
| --- | --- |
| Web | https://segue.pdyntech.com serves `main` @ `034b710`, plus a docs-only commit `c5f511b` |
| API | https://segue-api-qhgc.onrender.com, `/health` 200: `accounts: true`, places cached (OpenStreetMap → Nominatim), weather cached (Open-Meteo → met.no), smart add **off** (no Anthropic key), assistant `basic` |
| Private data without sign-in | `/v1/state` → 401 (correct) |
| Database | Supabase Postgres, schema `segue`, migrations 001–006. RLS is on with no policies, so only the API can read it |
| Branches | `ai-assistant` (#4, unmerged, assistant stays off `main`). Old feature branches are all merged |

## Feature status

| Area | Status | Detail |
| --- | --- | --- |
| Registration, sign-in, sign-out, password reset, change password, delete account | **Operational (code and tests)** | Supabase Auth: email and password, plus Google sign-in. Every API request checks the JWT, and ownership is enforced in SQL. Live sign-up of a new account was not tested here, because creating accounts on production is the owner's step |
| Works without an account | Operational | Data stays on the device (IndexedDB) |
| Sync across devices | **Partly** | Synced: routines and one-offs, settings, saved places, place history, past days, and today's done/skipped. **Not synced: today's plan itself.** Each device builds it from the synced inputs, so the times can differ slightly between devices |
| Google Calendar | **Operational, read-only, with limits** | Browser-only token, valid about an hour, never stored. Reconnecting needs a tap about once an hour. No background sync and no writing to Google. The Google app is in **Testing**, so only 2 test users can sign in (see GOOGLE_CALENDAR_PRODUCTION.md) |
| Calendar events on Today, and fixed in the planner | Operational | Covered by tests; checked with the owner's real account on 31 Oct |
| Planner and rerouting | Operational | Alternatives use real OpenStreetMap places, listed hours, travel estimates and the next fixed commitment (live check: 15 places per category in about 1 s) |
| Done, Skip, Move up (with preview) | Operational | Skip never moves anything |
| Postpone | **Done in this round** | **Move to tomorrow** (one-offs) and **Not today** (routines) in item details. Nothing else moves; there's an Undo and it survives a reload |
| Edit a task | Operational | Editing from the item sheet |
| Routines on chosen days | **Done in this round** | Pick the days (Weekdays, Weekends, Mon/Wed/Fri…). Today, Plan and Calendar only count a routine on its days. Pause and resume with the switch. Routines saved earlier keep repeating every day |
| Together | Operational | Notes with privacy, "Can I join?", owner approval, invitations, notifications. Two-account tests passed on 30 Oct |
| Navigation | **Done in this round** | Bottom bar: Today, Plan, Calendar, Routines, Together. Floats under the column on desktop. Real links, so back, forward and reload all work |
| Onboarding | Operational | Three steps; can be skipped with "Skip for now". **"Try an example day" removed**, because it copied sample tasks into real accounts. There's a link to `/demo` instead |
| Empty states | Done in this round | Today "Your day is open.", Plan "Start with something you want to get done.", Calendar "Connect your calendar or add your first commitment.", Routines "Build a routine around something you want to do regularly." Together already had one |
| Demo | Operational and isolated | `/demo` never touches stored data |
| Weather "day or night" | Minor bug | met.no's symbols without a day/night suffix (for example "cloudy") read as daytime. The app uses its own sun position first, so this shows only when the position is unknown |

## Overall

**Ready for daily use by people the owner adds as Google test users. For other people, ready to use without Google Calendar.** Everything on the page works and is tested. What stands between this and an open public launch:
1. Google: publish the app or add test users, then verification (owner).
2. A live check of sign-up and Together with two real accounts (owner; checklist in PRODUCTION_RELEASE_CHECKLIST.md).
3. Push notifications, two-way calendar sync and a synced day plan. These are not built, and the app doesn't claim them.

## Priorities for this round (as planned)

1. **P1:** bottom navigation with the five tabs, adapted for desktop.
2. **P1:** Postpone (to tomorrow) on Today.
3. **P2:** routines on chosen weekdays, used by Today, Calendar and the planner.
4. **P4:** empty states and onboarding copy for each tab.
5. **P0 (owner):** Google Audience (publish or add test users), verification, and live account sign-up.

Out of scope for this round, and documented rather than faked:
- two-way Google sync and server-side refresh tokens (these need a client secret and Google verification)
- syncing today's plan itself
- push notifications
