# Product UX release checklist (4 November 2026)

Branch `product-ux`, from `main` at `488d2e9` (the live site at the time). **Not merged and not deployed.**

## What's in it

| Area | Change | Backend | Status |
| --- | --- | --- | --- |
| Google Calendar | Connected once, it stays connected for signed-in people: encrypted refresh token on the server, automatic refresh, server-reported status and Last synced, Reconnect only when Google revokes access, deliberate account switching, disconnect revokes at Google | `apps/api/src/social/google.ts`, migration 008 | Built and tested. **Off in production until three API settings are added** (below) |
| Google Calendar | One connection control per state; Today shows one Reconnect when needed | — | Built and tested |
| Google buttons | Removed "Continue with Google" (landing) and "Sign up with Google" (Settings), and their code | — | Done |
| Landing | Route-aware hero, one main action (**Try Segue**), How it works scrolls to the one story (four steps on the real engine), logo palette, staged motion that respects reduced motion | — | Done |
| Together | Discover, Connections, Invitations, Join requests and My plans; View plan; participant counts for everyone who can see a plan; share preview; Pending, Accepted, Declined and Cancelled | Going count visible to all viewers (counts only) | Done |
| Navigation | The five bottom tabs, unchanged; Together's section chips stay separate | — | Unchanged, re-tested |
| AI assistant | Not in this branch; the build check confirms no in-development features | — | Kept out of `main` |

## Regression tests (all on the final code)

| Suite | Result |
| --- | --- |
| Typecheck (engine, schemas, providers, api, web) | Pass |
| Engine / schemas / providers | 65/65, 7/7, 70/70 |
| Web unit | 242/244. The 2 sky tests need a development build and pass in CI, as before |
| API against Postgres (including the 13 new Google tests and migration 008 up, down and up) | 124/124 |
| Browser tests (Playwright) | 35/35 |
| Google Calendar journey, real browser (14 steps; production-style build, real API and Postgres, sign-in and Google stand-ins) | See "Journeys" below |
| Together journey, three accounts (11 steps) | Pass |
| Production build check (no in-development features) and API bundle | Pass |
| Landing at 1440, 1280, 820, 390 and 360 px | No horizontal scroll |

Covered: Today, Plan, Calendar, Routines, fixed commitments, done, skip, move up only on request, the live OpenStreetMap fallback in the demo, weather precautions and re-routing.

## Journeys

**Google Calendar** (the journey script):
1. Signed in, never connected: one Connect button.
2. Connect: Connected, the account and Last synced.
3. Today, Plan, Calendar and Routines: no Google prompts, no popup.
4. Reload, close and reopen the browser, sign out and back in, a second device: no popup.
5. The access token expires: the server refreshes it.
6. Google revokes access: Needs attention, with one Reconnect, on Calendar and Today.
7. Reconnect works.
8. Use a different Google account.
9. Disconnect: revoked at Google, row removed.
10. Connect again.
11. No Google sign-in on the landing page or in Settings.

**Together** (three accounts):
- Discover first, with the five sections.
- View plan; ask with a message, cancel, ask again (one row).
- Approve with the time pre-filled; participants go from 1 to 2.
- Stop sharing makes the plan return 404 for Ben.
- The share preview; "Accepted" on the sender's side.
- A stranger at 360 px sees only the public plan.

## Accessibility

- **Keyboard and screen readers:** every action is a real button or link with a visible focus ring. Together's sections are a `tablist`; the landing steps use `aria-current="step"`, and later steps are disabled; the bell and counts have spoken labels; the connection states use `aria-busy` and `role="alert"`.
- **Touch and contrast:** targets are at least 44 px on phones (bottom nav, card actions, landing actions). The road-yellow button has navy text (high contrast); text on the navy band is white or 86% white.
- **Motion:** hero stagger, problem reveal and road fill are all off under `prefers-reduced-motion`.

## Remaining limitations

- **Production Google test not done.** It needs the API settings and a real Google account. Until then the live site keeps the browser-only connection (about an hour), now labelled "This visit only".
- **Google's Audience is still Testing** (2 test users): other Google accounts are blocked by Google. Publishing and verification are owner tasks (`GOOGLE_CALENDAR_PRODUCTION.md`).
- **Route sharing** (several stops as one route) needs route routines first (master plan Phase 2). Together shares one plan or stop.
- No push notifications. No two-way calendar sync (by design, read-only).
- **First-time visitor five-second test** not run (it needs a person; script in `LANDING_PAGE_UX_AUDIT.md`).

## Deployment status and steps (owner)

1. **Review and merge** the pull request. Vercel builds `main`; Render restarts the API and applies **migration 008** (adds one nullable column; `migrate down` drops it).
2. To turn on the lasting Google connection, add these to Render, then redeploy:
   - `GOOGLE_OAUTH_CLIENT_ID`: the `segue-web` client id;
   - `GOOGLE_OAUTH_CLIENT_SECRET`;
   - `GOOGLE_TOKEN_KEY`: `openssl rand -base64 32`. Keep it safe, and don't rotate it casually: rotating means everyone reconnects once.
3. In Google Cloud → Data access, make sure `openid` and `email` are listed with the two calendar scopes.
4. On segue.pdyntech.com, run the production checklist in `GOOGLE_CONNECTION_AUDIT.md`, then check Together with two real accounts.
5. **Rollback:** revert the merge. Then `pnpm --filter @segue/api migrate down` removes `last_synced_at`; connections saved in `google_accounts` are then ignored by the old code. Removing the three settings returns the app to browser-only.
