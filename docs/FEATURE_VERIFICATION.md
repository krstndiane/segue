# Feature verification: Together (1 November 2026)

**How it was tested:**
- **API:** Postgres 16 integration tests, 111/111.
- **Journey:** a three-account run (Ana, Ben, Cy) on phone screens, against the real API and Postgres with the production-style app build. All 11 steps passed (`together2.mjs`).
- **Browser:** the 35 browser tests, for regressions.

**Production status:** the work is on the branch `together-landing` and **not deployed**. Migration 007 runs on the API's next start after merge.

| Feature | Backend | Persistence | Authorization (server-side) | Tested | Production |
| --- | --- | --- | --- | --- | --- |
| Discover authorized shared plans | `GET /v1/notes?scope=shared` and `discover` | `notes`, `note_shares` | `canSeeNote` in SQL: author, chosen people, or public from findable people; blocks hide both ways | Journey: Ben sees Ana's shared plan, not her private one. Cy (not connected) sees only her public plan; her others are 404 by id | After merge |
| Plan details (time, place, description) | `start_time`, `end_time` (**new**, migration 007), `on_date`, `place_name` | Columns, with format and order checks | Author only can change them | API test: order checked, end cleared with start. Journey: "Tomorrow · 2:00–4:00 PM" shown | After merge |
| Can I join? (with a message) | `POST /v1/notes/:id/heart` `{ message? }` (**message new**, ≤ 280) | `note_interests.message` | Only people who can see the plan, not your own plan, not archived, not closed; the message is visible to the author only | API: the message reaches only the author; too long is refused. Journey: sent from the sheet | After merge |
| Duplicate requests prevented | Unique (note, user); a repeat updates the same row | — | — | API and journey: one row, one notification | Live (existing) |
| Cancel own request | `DELETE /v1/notes/:id/heart` | `withdrawn_at` | Own interest only | Journey: cancel, then ask again | Live (existing) |
| Owner receives request | Notification `note_hearted` (text now "asked to join… Say yes or not this time in Requests") | `notifications`, de-duplicated | Respects the "hearts" notification preference | Journey: Requests tab count; the request with its message | After merge (new wording) |
| Approve / decline | `POST …/interests/:id/accept` and `/decline` | Creates an activity and invitation as accepted / `declined_at` | Author only; refused if sharing was revoked or someone is blocked | Journey: Ana says yes with the time pre-filled; Ben is notified and sees "You're going" | Live (existing) |
| Going and waiting counts | `goingCount`, `pendingCount` (**new**, author only) | Derived in SQL | Not shown to non-authors | API: 1 going / 0 waiting, then 1 waiting; hidden from others | After merge |
| Invitations accept / decline, status | `/v1/invitations…` | `invitations` | Recipient answers, sender changes or cancels; anyone else gets 404 | Journey: Ben accepts, Ana's sent view shows accepted | Live (existing) |
| Edit shared plan | `PATCH /v1/notes/:id` | — | Author only (403 for others) | API (existing and new) | Live |
| Visibility / stop sharing | `PATCH visibility: private` | `notes.visibility` | Access is removed at once | Journey: after "Stop sharing", Ben's GET is 404 and the plan leaves his screens | Live (existing) |
| Private tasks stay private | Planner data never goes to Together; only plans you share | — | — | Journey: "Therapy notes" (private) never shown to Ben or Cy; 404 by id | Live |
| Notifications open the right place | Client routing | — | Text built when read, so a revoked plan says "no longer available" | Journey: "Ana said yes" opens Invitations with the plan; the Requests tab shows Going | After merge |
| Mobile | — | — | — | 390 and 360 px: no overflow in any section, the bottom navigation visible | After merge |
| Empty, loading and error states | — | — | — | Every section: one message plus one action; shared loading and error components with Try again | After merge |

## Other checks

| Check | Result |
| --- | --- |
| Typecheck, 5 packages | PASS |
| Lint | No linter is configured in the repo |
| Unit: engine / schemas / providers / web | 65/65, 7/7, 70/70, 244/246 (2 DEV-only sky tests pass in CI) |
| API (Postgres), including migration 007 up, down and up | 111/111 |
| Browser | 35/35 |
| Production frontend build and in-development feature check | PASS |
| Production API build (esbuild bundle) | PASS |
| Security | Messages are length-limited and plain text, shown as text (no HTML). New fields are author-only. No new dependencies |
| Deployed application | **Not tested.** Not merged yet. Steps after merge are below |

## After merge (owner)

1. Vercel deploys the web app. Render restarts the API, which applies migration 007 (`MIGRATE_ON_START`), the same as earlier releases.
2. On the live site, with two real accounts:
   - Share a plan with a time from one.
   - From the other, ask to join with a message.
   - Say yes from the first.
   - Check the other sees "You're going".
3. Rollback: revert the merge. Then `pnpm --filter @segue/api migrate down` removes the three new columns (and any plan times and request messages saved in them).
