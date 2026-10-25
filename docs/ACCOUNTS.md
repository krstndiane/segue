# Accounts, notes, hearts and invitations

Segue is a personal planner with an optional social layer. **Plan on your own. Share what you choose. Invite when you're ready.** Nothing here is needed to plan a day; without an account Segue works exactly as before.

This document covers what was built in the first round (accounts, sync, notes, hearts, invitations, notifications), how it's secured, how to set it up, and what's still to come.

## What a person can do

| | |
| --- | --- |
| **Account** | Create an account with email and password, confirm the email, sign in and out, reset a forgotten password, change it, delete the account. |
| **Profile** | Name, username, optional photo (resized on the phone to 160×160) and "about you", who can find you (nobody by default), which notifications you want, time zone. |
| **Sync** | Routines and one-offs, settings, saved places, place history and past days follow you to every device. Offline first: the device is the working copy. |
| **Notes** | Write, edit, pin, archive, search and delete notes; give one a day, a place, or link it to one of your plans. Each note is **Only me** (default), **People I choose**, or **Anyone who finds me**. |
| **Hearts** | Heart someone's note to say "I'd like to be invited". The author is told once. Take it back any time. |
| **Invitations** | Invite one person or a group to something, with or without a fixed time. Each person accepts, declines or suggests another time on their own. The sender can change the details or cancel for one person or everyone. |
| **Your day** | An accepted invitation with a time can be added to your day as a fixed block, after Segue shows what it overlaps. Nothing is added unless you tap it. |
| **Updates** | In-app notifications with an unread badge on the Together tab; tap one to open what it's about. |

## How it fits together

```
Phone (React PWA)                        Supabase                 Segue API (Render)
──────────────────                       ────────                 ──────────────────
IndexedDB: the planner (offline)
auth.ts ── email + password ───────────▶ Auth (GoTrue)
        ◀── access token (JWT, 1 h) ────
social.ts ── Bearer token ─────────────────────────────────────▶ verifies the JWT (JWKS or HS256)
useSync.ts ─ versioned values ─────────────────────────────────▶ /v1/state ──┐
Together tab ─ notes, hearts, invites ─────────────────────────▶ /v1/... ────┼─▶ Postgres (Supabase)
                                                                              │   schema `segue`
                                                                              └─  RLS on, no policies
```

- **Sign-in** goes straight from the browser to Supabase Auth's REST API (`apps/web/src/lib/auth.ts`, no SDK). The session lives in `localStorage` under `segue.session`, apart from the planner's data, and is never synced. It refreshes itself a minute before it runs out.
- **The API checks every request** (`apps/api/src/auth.ts`): signature against the project's public keys (`/auth/v1/.well-known/jwks.json`, ES256/RS256) or the legacy HS256 secret, then expiry, issuer, audience (`authenticated`) and the user id. Identity comes only from the token; ids in URLs and bodies are checked against it.
- **The data** is in Postgres, in its own schema `segue`. Supabase's auto-generated REST API doesn't expose that schema, and row-level security is on with no policies, so the browser's public key can't read or write any of it. Only the API, connecting with the database URL, can.
- **Permissions are enforced in SQL on every query**, not in the app: a note is readable only by its author, or while it isn't archived, by anyone if it's discoverable, or by the people it's shared with if it's "selected" (`canSeeNote` in `apps/api/src/social/views.ts`). Anything you can't see answers 404, so ids can't be probed.

### Data model

| Table | What | Notes |
| --- | --- | --- |
| `profiles` | id (= Supabase user id), username (unique, `a-z0-9_`), display name, avatar (data URL ≤ 60 KB), bio, discoverable, notify (JSON), timezone | Deleting a profile deletes everything below (`on delete cascade`). |
| `user_state` | (user, key) → JSON value + version | Keys: `blocks`, `settings`, `favorites`, `placeHistory`, `dayArchive`. |
| `notes` | author, title, body, visibility, on_date, place_name, block_id, pinned, archived_at, client_id | `unique (author_id, client_id)` makes a retried create harmless. |
| `note_shares` | (note, user) | Who a "selected" note is shared with. Rows stay if the note changes visibility, but only count while it's "selected". |
| `note_interests` | a heart: (note, user) unique, withdrawn_at, invitation_id | Its status is **derived**: withdrawn, or from the linked invitation (invited / accepted / declined), else interested. Never stored twice, so it can't drift. |
| `activities` | the shared thing: title, description, start/end, timezone, place, meeting notes, source note, active/cancelled | One per invitation send. |
| `invitations` | one per person: activity, sender, recipient, status, expires_at, changed_fields, counter-proposal | `unique (activity_id, recipient_id)`; `check (sender_id <> recipient_id)`. |
| `notifications` | recipient, actor, type, entity, read_at, dedupe_key | `unique (recipient_id, dedupe_key)`: retries and repeat taps never notify twice. |

Migrations live in `apps/api/src/migrations.ts` (as TypeScript strings so the bundled server carries them), run in one transaction under an advisory lock, and are recorded in `segue.schema_migrations`.

## The rules, precisely

### Notes and visibility
- New notes are **private**. Nothing becomes visible to anyone else without the author choosing it.
- "People I choose": only the author and the people on the list. Removing someone, or switching the note to private, takes their access away at once: the API stops returning it, they drop off the interested list, and their old notifications lose the title.
- "Anyone who finds me": any signed-in person can open it; it's listed in **Discover** only if the author's profile is findable too.
- Archived notes are visible only to their author. Only the author can edit, archive or delete.

### Hearts
- You can heart a note you can see that isn't yours or archived. One heart per person per note (unique constraint); a second tap does nothing; taking it back sets `withdrawn_at`, and hearting again restores it.
- The author is notified **once per person per note**, however often they toggle it (dedupe key `heart:<note>:<user>`), and only if they want heart notifications.
- Only the author sees who is interested, and only people who can still see the note. Others never see a heart count.
- Taking a heart back **never cancels an invitation**; the app says so if one is open.

### Invitations
- Status per person: `pending → accepted | declined`; the sender can move any open one to `cancelled`; `expired` is computed from `expires_at`. Only the person invited can accept, decline or suggest a time; only the sender can change or cancel. A third party gets 404.
- A heart and an invitation are separate: you can be interested without being invited, and invited without having hearted. When an invitation is sent from a note, the matching hearts link to it in the same transaction, so their status follows.
- One open invitation per person per note: a second one for the same note is refused (409).
- Sending is idempotent: the app sends a `clientId`, and a retry returns what the first try made.
- When the sender changes **time or place**, everyone who'd accepted goes back to *pending* with `changed_fields` set, and is notified, so a new yes is needed. A title or description change keeps their answer. A time change clears any counter-proposal.
- A group invitation is one activity with one invitation per person; nobody's answer affects anyone else's.

### Your plan stays yours
- Accepting changes nothing in your day. **Add to my day** (on the device) turns an accepted, timed activity into a fixed one-off block on that date (`apps/web/src/lib/invitePlan.ts`). Before adding, Segue lists what it overlaps (other fixed plans that day and that day's calendar events) and asks. If the sender later changes it, the card offers **Update in my day**.
- Each person's travel time, place choices and re-routing stay their own; the shared activity only says when and where.

### Sync
- Each key has a version. A write says which version it started from; if another device saved since, the server refuses (409) and returns its copy. The device combines the two and tries again, so stale data never replaces newer data.
- Combining: routines, one-offs and saved places by id (this device wins a tie; something deleted on one device while another still has it may come back, which is safer than losing it), place history by the higher counts, past days by date, settings from the account.
- **The first time an account meets a device with plans**, Segue asks: save them to the account, combine, use the account's, or keep this device separate. A fresh device just receives the account's plans.
- Never sent: the device's last position, and anything from Google Calendar (the server strips both too).
- Offline: changes wait on the device and go when there's a connection (on focus, coming online, every five minutes, and 1.5 s after a change).
- **Not signed in, or "keep this device separate":** data stays only on the device. **Signing out** keeps the device's copy; *Start over* clears it.

### Notifications
Hearts, notes shared with you, invitations received, accepted, declined, cancelled, changed, and counter-proposals. The words are written when they're read, and only name a note or activity the reader can still see; otherwise "no longer available". People can switch off each kind in their profile; an invitation still arrives in Invitations either way.

### Limits
Per signed-in person per hour: 300 writes (notes, hearts, invitations, profile), 60 searches, 900 sync writes. People search needs 2+ characters, returns at most 20, matches names and usernames of findable people only, and never matches email addresses.

## API

All routes need `Authorization: Bearer <Supabase access token>`. Everything except `GET/PUT /v1/me` also needs a profile (`403 profile_required` otherwise). Errors are `{ error, code?, details? }` in plain words. With accounts switched off, these routes answer `503 accounts_off`.

| Method | Path | |
| --- | --- | --- |
| GET | `/v1/me` | `{ profile \| null, email }` |
| PUT | `/v1/me` | Create the profile (username, displayName, …). `409 username_taken`. |
| PATCH | `/v1/me` | Change any profile field. |
| DELETE | `/v1/me` | Body `{ "confirm": "DELETE" }`. Deletes everything, then the sign-in if the server has the service role key. |
| GET | `/v1/users?q=` | Findable people by name or username. |
| GET | `/v1/users/:id` | A profile card, if findable, a mutual, or you already share something: `{ user }` with `full` (false when they keep details private), `connection`, `connectionId?`, `mutualCount?`. Blocked people are `404`. |
| POST | `/v1/me/avatar` | Raw image bytes (`image/jpeg`, `png` or `webp`, ≤ 2 MB, 32–1024 px). Returns the profile. `503 avatars_off` when storage isn't configured. |
| DELETE | `/v1/me/avatar` | Removes the photo and its stored file. |
| GET | `/v1/connections` | `{ mutuals, incoming, outgoing, blocked }` |
| POST | `/v1/connections/requests` | `{ userId }`. If they already asked you, this accepts. `409 already_connected`, `429 request_cooldown`. |
| POST | `/v1/connections/:id/accept` · `/decline` | Person asked. |
| DELETE | `/v1/connections/:id` | Cancel a request you sent, or remove a mutual (either person). |
| POST | `/v1/blocks` · DELETE `/v1/blocks/:userId` | `{ userId }`. Block / unblock. |
| GET | `/v1/state` | `{ items: { key: { value, version, updatedAt } } }` |
| PUT | `/v1/state/:key` | `{ value, baseVersion }` → `{ item }`, or `409 version_conflict` with `details.current`. |
| GET | `/v1/notes?scope=mine\|shared\|discover\|hearted&q=&archived=1&onDate=&author=&limit=&offset=` | `{ notes, more }` |
| POST | `/v1/notes` | `{ title, body?, visibility?, onDate?, placeName?, blockId?, pinned?, shareWith?, clientId? }` |
| GET / PATCH / DELETE | `/v1/notes/:id` | Read (if allowed) / change or delete (author only). |
| POST / DELETE | `/v1/notes/:id/heart` | Heart / take it back (`invitationStillOpen` says if an invitation remains). |
| GET | `/v1/notes/:id/interests` | Author only: who's interested, with status. |
| GET | `/v1/invitations?box=received\|sent\|all&state=open\|past\|all` | `{ invitations }`, each with `direction`. |
| POST | `/v1/invitations` | `{ recipientIds, title, timezone, description?, startsAt?, endsAt?, placeName?, meetingNotes?, sourceNoteId?, expiresAt?, clientId? }` |
| GET / PATCH | `/v1/invitations/:id` | Read (participants) / change the activity (sender). |
| POST | `/v1/invitations/:id/accept` · `/decline` · `/counter` | Person invited. `counter`: `{ startsAt, endsAt?, note? }`. |
| POST | `/v1/invitations/:id/cancel` | Sender. `{ "everyone": true }` cancels the activity for all. |
| GET | `/v1/notifications` | `{ notifications, unread }` |
| POST | `/v1/notifications/:id/read` · `/v1/notifications/read-all` | |

## Setting it up

You need a Supabase project (free tier is fine). Accounts stay off until all of this is in place; the planner keeps working meanwhile.

1. **Create the project** at supabase.com: name `segue`, region *Southeast Asia (Singapore)* (next to the Render API). Save the database password somewhere safe.
2. **Authentication → Sign In / Providers → Email:** on, with *Confirm email* on. Minimum password length 8.
3. **Authentication → URL Configuration:** Site URL `https://segue.pdyntech.com/app`; Redirect URLs: `https://segue.pdyntech.com/app`, and `http://localhost:5173/app` for development.
4. **Render (API) → Environment:**
   - `DATABASE_URL`: Supabase → **Connect** → *Session pooler* connection string, with your database password in it.
   - `SUPABASE_URL`: `https://<project-ref>.supabase.co`.
   - `SUPABASE_SERVICE_ROLE_KEY`: Project Settings → API Keys → `service_role` / secret key. Server only. Lets *Delete my account* remove the sign-in too.
   - `CORS_ORIGINS` must include `https://segue.pdyntech.com` (it already does).
   - The tables are created when the server starts (`MIGRATE_ON_START`, on by default). The log says `accounts: on`, and `/health` shows `"accounts": true`.
5. **Vercel (web) → Environment Variables**, then redeploy:
   - `VITE_SUPABASE_URL`: the same project URL.
   - `VITE_SUPABASE_ANON_KEY`: the public `anon` / publishable key. It's safe in the browser: it can't reach the `segue` schema.
6. **Optional, recommended:** Authentication → Emails → set up custom SMTP. Supabase's built-in email is rate-limited (a few emails an hour) and meant for testing.

### Migrations by hand

```bash
DATABASE_URL=... pnpm --filter @segue/api migrate        # apply anything new
DATABASE_URL=... pnpm --filter @segue/api migrate down   # undo the latest (deletes its tables and data)
```

### Tests

`apps/api/test/social.test.ts` runs against a real Postgres when `TEST_DATABASE_URL` is set (CI starts one; it drops and rebuilds the `segue` schema). Locally:

```bash
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter @segue/api test
```

## Profiles, photos, mutuals and blocking (Round 1 of the profile and mutuals work)

**Profile photos.** The browser lets you drag and zoom a photo inside a circle, then makes a 512 px square WebP (JPEG where WebP isn't available) and sends only that. The API checks it is really a JPEG, PNG or WebP by its first bytes, reads its size from the header (32–1024 px, ≤ 2 MB), and stores it in the public `avatars` bucket in Supabase Storage at `<your id>/<random>.webp`. The profile keeps only the link and the key; replacing or removing a photo deletes the old file, and so does deleting the account. The server does **not** re-encode images (it has no image library), so it refuses anything it can't positively identify instead of cleaning it. The bucket is public: anyone with a photo's link can open it, so links are long random names and aren't listed. Setup: run the migration (it creates the bucket), set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the API, and allow `https://*.supabase.co` in the web app's `img-src` (done in `vercel.json`). Without the key the Add photo button still crops, but saving says photos aren't switched on yet.

**Profile settings.** Name, username, about, pronouns, up to 10 interests, who can find you (`discoverable`), who sees your details (`everyone`, `mutuals` or `only_me`; others then see just name and photo), whether your mutual count shows, and who can invite you (`everyone`, `mutuals`, `nobody`). The default for invitations is `everyone` so existing behaviour doesn't change; it will move to `mutuals` when the invite picker becomes mutual-first. Someone who hearted your note can always be invited to *that* note.

**Mutuals.** One row per pair in `segue.connections` (unique whichever way round). A request needs a yes; if both ask at once they become mutuals. A declined asker can ask again after 7 days; the person who said no can ask at any time. Cancelling a request or removing a mutual deletes the row. Requests and acceptances create in-app notifications (switchable with *Someone asks to connect*).

**Blocking** wins over everything. Blocking someone removes the connection, deletes notes shared between you, withdraws hearts either way, cancels invitations that are still waiting, deletes notifications between you, and from then on hides each of you from the other (profile, search, notes, hearts, invitations, requests). **Accepted invitations stay as they are** (they are already in both calendars). Unblocking does not restore anything.

**Not done yet (Round 2):** per-block sharing with mutuals, the "Your Mutuals" section on Today, "Can I join?" requests, mutual-first invite picking, and planner integration. The notification, profile and block work above is what they will build on.

## Data retention and deletion

- Account data stays until you delete it. Deleting a note deletes its hearts and shares at once; invitations already sent stay, without the link.
- *Delete my account* deletes the profile and, through `on delete cascade`, synced planner data, notes, shares, hearts, the activities and invitations you sent, invitations you received, and notifications. With `SUPABASE_SERVICE_ROLE_KEY` set, it also deletes the sign-in; without it, the email and password remain in Supabase Auth until removed in the dashboard.
- Notifications about something that's gone stay, without its title ("no longer available"), until the account is deleted.
- Supabase's backups may hold deleted data for a short while.

## Not in this round

- **Shared daily plans** (selected activities shared with view-only or collaborative access, secure links with expiry and revocation): round two, built on the same tables and checks.
- **Push and email notifications**: in-app only for now; invitations never depend on them.
- **Follow**: not built. Mutual connections (both sides agree) are; discovery is search by name or username of people who opt in.
- **Offline queue for social actions**: drafting a note or invitation needs a connection to send; the app says so. Planner sync works offline.
- **Google sign-in for Segue accounts**: the existing Google button still only connects Google Calendar on the device. It can be added later as a Supabase provider.
- **Audit log** of sharing and permission changes beyond `created_at`/`updated_at` and notifications.
