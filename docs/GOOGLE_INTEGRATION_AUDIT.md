# Google integration audit (1 November 2026)

## How Segue uses Google

- **What it reads:** Google Calendar, read-only, with the scope `https://www.googleapis.com/auth/calendar.events.readonly`.
- **Where it runs:** entirely in the browser, through Google Identity Services. The access token stays in the page's memory for about an hour and is never sent to Segue's server.
- **Client:** the Google Cloud project "sugue", OAuth client `segue-web` (a web application, created 19 October 2026), client ID `186214357752-im4umpf5vp7p9tqkmbsd9u57157ejjfg.apps.googleusercontent.com`. This client ID is the one in the live bundle.
- **Not needed:** API keys, service accounts, a client secret or billing. The page is a public browser client.

## Why it failed for other people

| Finding | Status | Evidence |
| --- | --- | --- |
| On `https://segue.pdyntech.com`, Google sign-in and calendar reading work for the owner's account. | **CONFIRMED** | Signed in on the live site, and today's events loaded on Today. Only counts and times were checked; no event titles were recorded. |
| Vercel preview links (`segue-git-…vercel.app`) get "Error 400: redirect_uri_mismatch". | **CONFIRMED** | Reproduced. These origins aren't in the client's Authorized JavaScript origins. |
| Other people's Google accounts get "Error 403: access_denied" ("Access blocked") while the consent screen's Publishing status is **Testing** and they aren't listed as test users. | **LIKELY, UNVERIFIED** | This is Google's documented behaviour for apps in Testing. The owner's screenshots show the Audience page exists but not its status. Not reproduced with a second account from here. |

The failed demo is consistent with the third row (a presenter or visitor not on the test-user list) or the second (presenting from a preview link). Nothing in Segue's code was causing it.

## What the owner needs to configure

Everything below is in Google Cloud console → Google Auth Platform, project "sugue".

1. **Audience.**
   - For a demo: add the Google emails of the presenter and anyone trying it under **Test users** (up to 100).
   - For the public: click **Publish app**. Calendar is a sensitive scope, so until Google verifies the app, people see an "unverified app" warning they must click through. Google's verification needs a privacy policy URL and a home page on a verified domain.
2. **Clients → segue-web → Authorized JavaScript origins.**
   - Keep `https://segue.pdyntech.com`.
   - Add a preview origin only if you'll present from that exact link.
   - No redirect URIs are needed.
3. **Data Access.** Confirm `…/auth/calendar.events.readonly` is the only Calendar scope listed.

Credentials were not created, changed or put in the source code by this work.

## How Segue behaves when Google refuses

| Situation | What the user sees |
| --- | --- |
| The popup is closed, blocked, or Google shows "Access blocked" | "Google sign-in didn't finish. If Google said "Access blocked", Segue's Google sign-in isn't open to your account yet. You can still use Segue without Google, or try the demo." The message comes with links to both. |
| Access is denied | "Google didn't give Segue access to your calendar. Try again and allow access, or use Segue without Google." |
| The token expires, the service is busy, or Google is down | The existing messages from the stabilization release, and the last good events are kept. |
| The demo | It never calls Google. The sample class is labelled "Sample calendar… not your Google Calendar". |

"Connected" appears only after Google returns a token and a calendar read succeeds; that rule is unchanged.
