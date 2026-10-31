# Google Calendar in production (1 November 2026)

## What it does today

| | |
| --- | --- |
| Direction | **Read-only.** Segue reads events and never creates, changes or deletes anything in Google Calendar. Two-way sync is **not implemented** |
| Scope | `https://www.googleapis.com/auth/calendar.events.readonly`, and nothing else |
| How it connects | In the browser, through Google Identity Services (token client). There is no redirect and no server step: Google opens a popup and returns an access token to the page |
| Token storage | **Memory only**, for about an hour. It is never written to storage, never sent to Segue's server, and gone on reload. The connection *preference* is saved, so Segue knows to offer a one-tap refresh |
| Token refresh | No refresh token, which a browser-only client can't have. After about an hour, or after a reload, Today shows "Today's Google Calendar isn't loaded yet" with **Refresh calendar**. One tap, with no consent screen again unless access was revoked |
| Automatic refresh | When the app opens, when you come back to it, and every 15 minutes while the token lasts |
| Events read | Today's events, plus the days opened in Calendar. All pages are read (more than 250 events). Recurring events are expanded by Google (`singleEvents=true`). All-day events are shown but never block time. Times are converted to the device's time zone |
| On Today and in the planner | Timed events become fixed blocks the planner never moves or overlaps. Events added, moved or deleted in Google after the plan was made are flagged on Today with **Update my plan**, which shows a proposal. Nothing changes without review |
| Duplicates | Events are keyed by Google's event id, so re-syncing replaces and never duplicates |
| Disconnect | Settings → Google Calendar → Disconnect. This revokes the token with Google and removes the saved events from the device |
| Failures | Revoked access asks you to reconnect. Rate limits or an outage keep the last good events, show when they're from, and offer Retry. Events are never made up, and "Connected" is shown only after a successful read |

## Production configuration (Google Cloud project "sugue")

| Setting | State on 1 Nov 2026 |
| --- | --- |
| OAuth client | `segue-web`, web application, client ID `186214357752-im4u…`. This matches the live bundle |
| Authorized JavaScript origin | `https://segue.pdyntech.com` works. Vercel preview origins are **not** authorized (Error 400 `redirect_uri_mismatch`) |
| Redirect URIs | None needed; the token client doesn't redirect |
| Publishing status | **Testing**, with 2 test users. Anyone else gets "Access blocked" |
| Branding and verification | Not verified. The Verification Center needs branding first (app name, logo, home page, privacy policy `https://segue.pdyntech.com/privacy`, and authorized domain `pdyntech.com`, which needs a Search Console check). Then data-access verification for the sensitive calendar scope, which needs a scope justification and a demo video |

**For everyone to be able to connect:** press **Publish app** under Audience. Until Google verifies the app, people see an "unverified app" screen and must choose Advanced → Continue, and there is a lifetime cap of 100 users.

## Real-account verification

| Check | Result |
| --- | --- |
| Owner's account on segue.pdyntech.com: connect, today's events on Today, fixed in the plan | **PASS** (31 Oct 2026). Only counts and times were recorded |
| Another person's account | **UNVERIFIED.** Blocked by Testing mode until they're added as a test user or the app is published |
| Disconnect and reconnect on live | **UNVERIFIED** on live. Covered by browser tests with Google mocked |
| An event changed in Google, then flagged on Today | Covered by browser tests. **UNVERIFIED** live |

## Known limitations, and what removing them takes

1. **A tap to refresh after about an hour, and no background sync.** Fixing this needs a server-side connection: the authorization-code flow, a client secret on Render, refresh tokens stored encrypted (migration 004 already has unused tables for this), and a redirect URI on `segue-api-…onrender.com`.
2. **No writing to Google.** This needs the `calendar.events` scope, Google's verification, and rules for which events Segue owns, so it never overwrites events it didn't create.
3. Both of these are owner decisions with Google Cloud access. Neither was started, and neither is presented in the app as working.
