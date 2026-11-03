# Google Calendar connection audit (4 November 2026)

## Why people were asked to sign in again

Before this change the only Google Calendar connection was in the browser. It used a Google Identity Services *token* client, with a token that lasts about an hour and was held in memory only. The server never had a way to read the calendar. So:
- Every new page load needed a new token.
- After about an hour, Today showed "Refresh calendar" and Google's popup opened again.
- Nothing carried across devices.
- "Connected" was a flag on the device (`calendar.connected`), not a fact anyone checked.

On top of that, three Google buttons competed:
- **Continue with Google** on the landing page.
- **Sign up with Google** in Settings.
- **Connect Google Calendar** on the Calendar page.

The first two made a device-only "account": a Google name and photo saved in the browser. That predated Segue accounts and was a different thing from both a Segue sign-in and a calendar connection.

## Segue sign-in versus Google Calendar access

| | What it is | Where it's managed |
| --- | --- | --- |
| **Segue account** | Email and password through Supabase Auth. Needed for sync, Together, and keeping Google Calendar connected | Settings → Account. Unchanged by this work |
| **Google Calendar access** | Read-only permission for Segue to read your events. Not a way to sign in to Segue | The **Google Calendar** page (Plan → Connect, Settings → Manage Google Calendar, or while getting started) |

Connecting Google Calendar never signs you in to Segue, and signing in to Segue never connects Google by itself.

## How it works now

**Signed in to Segue, and the server is set up for it** (the API has `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_TOKEN_KEY`):

1. **Connect Google Calendar** opens Google's popup through the GIS *code* client (`ux_mode: popup`). The scopes are `openid email calendar.events.readonly calendar.calendarlist.readonly`. Google hands a one-time code back to the page; no redirect URI is involved (`redirect_uri=postmessage`).
2. The page sends the code to `POST /v1/google/calendar`, with the Segue sign-in. The server:
   - swaps the code at Google's token endpoint, using the client secret;
   - checks the calendar scope was granted;
   - reads which Google account it is from the id token Google returned;
   - saves the connection.
3. What's saved, in `segue.google_accounts` (from migration 004, unused until now):
   - the Google account id and email, and the granted scopes;
   - the refresh token and the current access token, each sealed with **AES-256-GCM** under `GOOGLE_TOKEN_KEY`, with the Segue user id as authenticated data, so a token copied to another row can't be opened;
   - the access token's expiry, a status (`active` / `needs_reauth`), the last error, and **`last_synced_at`** (new in migration 008).
4. Events come from `GET /v1/google/calendar/events?start&end`, a window of at most 62 days. The server:
   - uses the saved access token while it has more than a minute left, and otherwise refreshes it with the refresh token;
   - reads every calendar that's switched on (up to 10), with recurring events expanded;
   - trims each event to what the planner needs (no descriptions, other attendees or links);
   - passes the events to the app and **does not store them**;
   - updates `last_synced_at`.
5. The app asks `GET /v1/google/calendar` for the status once per sign-in. **The server is the source of truth.** A local flag is never taken as proof of a connection: if the server says *disconnected*, the device's calendar is cleared.

**Without a Segue account, or a server without those settings:** the old browser-only connection, unchanged. The Calendar page says so plainly ("This visit only: Google asks again after about an hour"). Signed out on a build with accounts, the page offers **Sign in to Segue** first, with **Or connect for this visit only** as a quieter link.

## When Segue asks Google again

Only in these cases:
- The first connection.
- Google answers `invalid_grant` to a refresh: access was removed in the Google account, the token expired for good, or the consent was withdrawn.
- The saved token can't be decrypted, because `GOOGLE_TOKEN_KEY` changed.
- There is no refresh token.
- The person chooses **Use a different Google account**.

A network failure or a Google 5xx is **not** treated as revoked. The status stays *connected* and the app says it couldn't reach Google. When access really is lost, the server marks `needs_reauth` once, and later reads answer `google_reconnect` without calling Google again.

**Switching accounts is never silent.** If a different Google account is chosen while one is connected, the server refuses with `409 google_other_account`. It names both accounts and revokes the newly granted access. Switching takes a deliberate `replace: true`, from **Use a different Google account** or **Switch to …**.

**Disconnect** (`DELETE /v1/google/calendar`) revokes the grant at Google (best effort) and deletes the row. **Delete my account** does the same before removing the profile.

## Connection states in the app

There is one control, `CalendarConnection`, used on the Google Calendar page and while getting started. Each state has exactly one main action:

| State | Shows | Action |
| --- | --- | --- |
| Signed out of Segue (accounts on) | "Sign in to Segue first and Google Calendar stays connected…" | **Sign in to Segue**, plus "Or connect for this visit only" |
| Signed in, never connected | What Segue does with the calendar | **Connect Google Calendar** |
| Connected | Google mark, **Connected**, the Google account's email, **Last synced** (the server's real time; "today at 3:05 PM") | **Manage connection**, which opens Sync now, Use a different Google account, and Disconnect Google Calendar |
| Needs attention | "Your Google Calendar connection needs attention." and why | **Reconnect Google Calendar** (also on Today, as one notice) |

## Redundant sign-in controls removed

| Where | Before | Now |
| --- | --- | --- |
| Landing page hero and final call to action | Continue with Google | Removed. **Try Segue** opens the app |
| Settings | A "Google" section with Sign up with Google, or name, photo and sign out | Removed. Settings shows the calendar's status and links to the Google Calendar page |
| Calendar page | Connect, then Sync now and Disconnect, always shown | The one control above |
| Today | "Refresh calendar… Google asks you to confirm about once an hour" | Only in browser-only mode. With the server, nothing, or one Reconnect when it needs attention |
| Calendar tab, Plan tab | "Connect Google Calendar" / "Connect" links | Kept as links to the Google Calendar page when not connected. They don't open Google themselves |
| Code | `signUpWithGoogle`, `GoogleButton`, the profile scope | Deleted. An old device-only profile is still read so those people are greeted by name |

## Real synchronisation behaviour

- **Read-only.** Segue never writes to Google Calendar. There's no two-way sync, so sync loops can't happen.
- **Today's events and the days you open** are read on demand: on opening the app, on coming back to it, every 15 minutes while it's open, on Sync now, and before a re-route.
- **What's included:** events you're busy for. Free/transparent, declined and cancelled events are left out, and all-day events are shown without blocking time. Recurring events come expanded (`singleEvents=true`). A meeting on two calendars shows once (iCalUID).
- **Changes in Google Calendar:**
  - Updated or new events appear on the next read.
  - Deleted ones disappear on the next read.
  - Today shows "Your calendar changed since this plan was made", and nothing moves until you accept the new plan.
- **Time zones:** event times come from Google as ISO times with offsets. Days are the device's local days.
- **Fixed commitments** stay protected: calendar events become fixed blocks the engine never moves.

## Tests and results

| Test | Result |
| --- | --- |
| API, against Postgres with a fake Google (`apps/api/test/google.test.ts`, 13 tests) | **Pass**. Covers: server not set up; connect once and stay connected; the token is encrypted at rest and never in an answer; the token is bound to its user; automatic refresh after expiry and after an early 401; revoked access means needs attention, and reconnecting fixes it; a repeat connect without a refresh token keeps the saved one; a first connect without lasting access is refused; a missing scope or bad code is refused; no silent account switch, but a deliberate one works; each account is isolated; signed out gets 401; disconnect revokes and removes; range checks; Google unreachable is not "revoked"; deleting the account revokes too; migration 008 up, down and up |
| Real-browser journey (`gjourney.mjs`, 14 steps, run twice) on the production-style build, the real API and Postgres, the sign-in stand-in and a Google stand-in | **Pass, both runs.** Steps 1–8 of section 28 (sign in, connect, Today, Plan, Calendar, refresh, close and reopen the browser, sign out and back in) needed no popup. Also passed: a second device; expiry with refresh; revoked access, then Reconnect; switching accounts; disconnect, then reconnect; and no Google sign-in on the landing page or in Settings. No page errors |
| Browser tests (35) | **Pass**. Includes onboarding connect (one button, then Connected and Last synced), Calendar page connect, and a new day |
| **Production, with a real Google account** | **Not done.** It needs the three API settings on Render, which are a production change only you can authorise, and Google's real consent screen. Steps are below |

## Production checklist (owner)

1. In Google Cloud, open the OAuth client `segue-web` and copy its **Client secret**. The scopes on **Data access** must include `openid` and `email` next to the two calendar scopes.
2. On Render, add `GOOGLE_OAUTH_CLIENT_ID` (the same id as `VITE_GOOGLE_CLIENT_ID`), `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_TOKEN_KEY`. Generate the key with `openssl rand -base64 32`, store it somewhere safe, and don't change it. Then redeploy.
3. Check the API log has no "Google Calendar stays in the browser" warning.
4. On segue.pdyntech.com, with a test-user Google account:
   - sign in to Segue, connect, then reload, close and reopen, and sign out and back in. None of these should open Google's popup;
   - remove Segue at myaccount.google.com/permissions. The next Sync now should show "needs attention";
   - reconnect, then disconnect.
5. Until step 2 is done, the live site keeps the browser-only connection (about an hour, then one tap), now said plainly on the Calendar page.
6. Google's Audience is still **Testing** (2 test users). Anyone else is blocked by Google until it's published or they're added (see `GOOGLE_CALENDAR_PRODUCTION.md`).
