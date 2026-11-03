# Continue with Google: one step for the account and the calendar

The first time someone connects Google Calendar, that one Google consent also signs them in to Segue and creates their account. There is no second sign-in and no separate account form. After that they stay signed in and connected. When Google access is revoked they see one **Reconnect Google Calendar**, and they stay signed in.

## What people see

| State (from the server) | What shows |
| --- | --- |
| Signed out, Continue with Google switched on | One **Continue with Google** button, saying it signs in or creates the account and connects the calendar. Below it, a text link for people who already have an email account. Nothing else. |
| Signed in, connected | The Google account's email, **Connected**, "Last synced …", and **Manage connection** (Sync now, Use a different Google account, Disconnect). No sign-in or connect buttons anywhere in the app. |
| Signed in, not connected (calendar refused, or disconnected) | **Connect Google Calendar** only. |
| Signed in, access revoked or expired for good (`needs_attention`) | **Reconnect Google Calendar** only, with what happened and that plans are fine. Still signed in. |
| Continue with Google not switched on yet | The earlier flows: sign in to Segue (email), or connect for this visit only. |

Settings holds everything in one place: the Google Calendar connection (status, last sync, Sync now, reconnect, disconnect), the account, Sign out and Delete account. Disconnecting keeps the account. Signing out keeps the data in the account.

The buttons are driven by server state (`/health` → `googleSignIn`, `/v1/google/calendar` → `status`), not hidden with CSS. When a case doesn't apply, its button isn't rendered.

## How it works

```
browser                        Segue API                          Google              Supabase Auth
  │ tap Continue with Google      │                                  │                     │
  │── GIS code popup (openid email profile + 2 read-only calendar scopes) ──▶│              │
  │◀─ one-time code ──────────────────────────────────────────────────│                     │
  │── POST /v1/auth/google {code} ─▶│── code + client secret ────────▶│                     │
  │                                │◀─ id_token, access, refresh ────│                     │
  │                                │── grant_type=id_token (provider google, id_token) ───▶│
  │                                │◀─ Supabase session (user found or created by Google identity)
  │                                │  check the session like any request; make the profile the first time;
  │                                │  save the calendar grant, encrypted (segue.google_accounts)
  │◀─ {session, created, calendar} │
  │  store the Supabase session as with any sign-in (Google tokens never reach the browser)
```

- **Identity and calendar access stay separate inside.** Supabase holds the identity (`auth.users`, `auth.identities`). `segue.google_accounts` holds the calendar grant, sealed with AES-256-GCM (`GOOGLE_TOKEN_KEY`, with the user id as associated data). The single consent fills both. Each can change without touching the other: disconnecting removes only the grant, and revocation marks only the grant `needs_attention`.
- **Tokens.** Google's refresh token stays on the server, encrypted. The browser keeps only the Supabase session, exactly as it does after email sign-in. Nothing from Google is written to localStorage.
- **Permissions.** `openid email profile` plus `calendar.events.readonly` and `calendar.calendarlist.readonly`. Nothing that writes. `profile` is only requested by Continue with Google, for the first profile's name.
- **Calendar refused.** If the person unticks calendar access on Google's screen, the account is still created and signed in. The answer says `calendar.problem: "scope_denied"`, the app says the calendar isn't connected and why, and the card then offers **Connect Google Calendar**.
- **Returning people** are found by their Google identity (`sub`), so the same account comes back on every device. The profile is never overwritten.
- **Initial sync.** The connection is saved during sign-in, so the app's server-mode calendar loads today's events straight away. Routine recognition picks them up on its normal pass (see `docs/ROUTINE_LEARNING.md`).
- **Abuse.** `/v1/auth/google` is limited to 30 tries an hour per IP. Each code works once, and Google rejects a reused one.

## Existing accounts and safe linking

- **Email-and-password accounts.** Supabase links a Google sign-in to an existing user only when the Google account's email is **verified** by Google and matches. The person lands in their existing account, and their username, name, plans and shared notes are untouched. An unverified email is never merged; it gets a separate user. Tests cover both cases.
- **People already connected from the earlier server-kept flow** keep their row. Signing in with the same Google account reuses it and keeps the refresh token. If they sign in with a different Google account than the connected one, the existing connection stays, and the answer says `other_account` so they can choose to switch.
- **Nothing is migrated in bulk.** Existing rows and accounts are untouched until the person next signs in.

## Turning it on (owner steps)

Until these are done, `/health` says `googleSignIn: false` and the app keeps the earlier flows. Nothing breaks.

1. **Render → segue-api → Environment** (already needed for staying connected):
   - `GOOGLE_OAUTH_CLIENT_ID`: the segue-web OAuth client ID (same as the web's `VITE_GOOGLE_CLIENT_ID`)
   - `GOOGLE_OAUTH_CLIENT_SECRET`: that client's secret
   - `GOOGLE_TOKEN_KEY`: `openssl rand -base64 32`. Keep it safe; changing it means everyone reconnects once.
   - `SUPABASE_ANON_KEY` (optional): Supabase → Project Settings → API → anon/publishable key. Without it the service role key is used for this one call.
2. **Supabase → Authentication → Sign In / Providers → Google:** enable it and paste the same client ID and client secret. The id-token grant checks that the token's audience is this client ID. Leave "Skip nonce check" off.
3. **Google Cloud → OAuth consent screen:** add the `profile` scope next to `openid` and `email`. They are non-sensitive scopes, so no extra review is needed beyond the calendar scopes already submitted.
4. Redeploy the API, then check `https://segue-api-qhgc.onrender.com/health` for `"googleSignIn":true`.

## Tests

- `apps/api/test/googleSignIn.test.ts` (11): switched off; new user (account, profile, calendar, no Google tokens in the answer); returning user (same id, profile kept, one row each); calendar refused then connected later; existing email account linked with profile kept; unverified email not merged; other Google account kept; usernames unique; Supabase provider off (503, nothing written); bad or reused code; reconnect after `needs_attention`.
- `apps/api/test/google.test.ts` (13), unchanged and passing after the refactor into `storeConnection`.
- Browser journey (real API on Postgres, Supabase and Google stand-ins), all steps passing:
  1. A new person sees one Google button while getting started.
  2. One consent creates the account, signs in and connects the calendar.
  3. They go into the app with no further sign-in and no profile screen.
  4. There are no sign-in or connect buttons in any of the five sections.
  5. A refresh keeps the session and the connection, with no popup.
  6. Settings shows status, last sync, Sync now, Disconnect and Sign out.
  7. Expired authorization is refreshed on the server with no popup.
  8. On revocation: still signed in, one Reconnect, and the same account afterwards.
  9. Sign out, then Continue with Google: the same account, with no duplicates.
  10. Calendar refused: the account is created, the app explains why, and it offers Connect.
  11. An existing email account plus Google: the same account, with its profile kept.
  12. One account and one connection per person overall.
- The existing browser suite (41) and the production build check pass.

## Limits

- Continue with Google needs the owner steps above. Production stays on the earlier flows until then.
- Linking existing email accounts follows Supabase's verified-email rule. Someone whose Google email differs from their Segue email gets a new account; they can sign in with email instead.
- Delete account removes the Google grant (and asks Google to revoke it) along with the account, as before.
