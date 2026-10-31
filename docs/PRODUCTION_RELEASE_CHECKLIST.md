# Production release checklist: pull request #8 (1 November 2026)

| | |
| --- | --- |
| Change | Bottom navigation, postpone, routines on chosen days, empty states, onboarding without sample tasks |
| Branch | `product-ready`, [#8](https://github.com/krstndiane/segue/pull/8) |
| Live before merge | `main` @ `c5f511b` (web), API unchanged |
| Deployment commit | **Pending.** The owner merges #8, and Vercel then deploys `main` |

## Tests

| Check | Result |
| --- | --- |
| Typecheck: engine, schemas, providers, api, web | PASS |
| Web unit | 244/246. The 2 sky-preview tests need `import.meta.env.DEV` and pass in CI |
| Engine / schemas / providers | Unchanged since the last release (65/65, 7/7, 70/70) |
| API with Postgres 16 | 109/109 |
| Browser (Pixel 7 profile) | 35/35, including bottom navigation, postpone, routine days, landing and demo |
| CI on #8 (real vitest, vite build, build check, bench) | PASS |
| Vercel preview of #8 | Built; it loads and shows onboarding on a fresh browser |
| Production build check (no in-development features) | PASS |

## Production services (checked live, 1 Nov 2026)

| Service | Status |
| --- | --- |
| API `/health` | 200. Accounts on; places cached (OpenStreetMap → Nominatim); weather cached (Open-Meteo → met.no); smart add off; assistant basic |
| Private routes without sign-in | 401 |
| Live places (from segue.pdyntech.com) | 15 park, gym and mall results each, in 0.1–1.1 s |
| Database | Supabase Postgres, migrations 001–006. **This release adds no migrations** |
| Environment variables | **Not changed** |

## Security checks for this change

- There are no new endpoints, dependencies or stored fields on the server. A routine's days ride inside the existing `blocks` sync value, which is the owner's own data, read and written only with their token.
- Postpone and routine days are device-side changes to the user's own data. Undo restores exact snapshots.
- The sample tasks that onboarding used to copy into real plans are removed. `/demo` stays separate and keeps its data in memory.
- The known zod 3.25.76 advisory (HIGH) is unchanged, and still mitigated by body size caps.

## After merge (owner, about 10 minutes)

1. Wait for Vercel to deploy `main` (the commit shows a green "Vercel" check).
2. On a phone, open https://segue.pdyntech.com/app:
   - Check that the bottom bar shows **Today, Plan, Calendar, Routines, Together**.
   - Tap each tab, then go back and reload.
3. In Routines, add one that repeats on Weekdays only. Check that it shows on Plan today, which is a weekday.
4. Open an item's Details. Tap **Move to tomorrow** or **Not today**, then **Undo**.
5. **Accounts on live:** sign up with a second email, confirm it, and sign in on another device. Check that routines appear there.
6. **Together on live:** from the second account, ask to join a plan your main account shared. Answer it from the main account.
7. Google: Audience → **Publish app**, or add test users (see GOOGLE_CALENDAR_PRODUCTION.md).

## Outstanding blockers before a public launch

| Blocker | Owner |
| --- | --- |
| The Google app is in Testing (2 users) and unverified | Owner, Google Cloud |
| Live sign-up and Together with two real accounts have not been checked | Owner (steps 5–6) |
| No push notifications; Google needs a tap after about an hour; today's built plan isn't synced between devices | Not built. Documented, not claimed |

## Rollback

Revert the merge commit of #8 on `main`. There's no data to migrate back: a routine's days are an optional field, and older versions ignore it, so those routines would simply repeat every day again.
