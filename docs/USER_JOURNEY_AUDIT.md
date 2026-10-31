# User journey audit (1 November 2026)

**Where each journey was checked:**
- **Local**: the production-style build, with Google mocked and no API, in automated browser tests.
- **Local + API**: with the real API and Postgres.
- **Live**: on https://segue.pdyntech.com.

Account sign-up was **not** done on live, because creating accounts on production is the owner's step.

| Journey | What was checked | Where | Result |
| --- | --- | --- | --- |
| **1. New user** | Landing page explains the product. Setup takes three short steps and can be skipped ("Skip for now", which lands on an empty Today saying "Your day is open."). Add tasks, plan, reload, tasks remain. All tabs reachable | Local | PASS |
| | Sign up with email, confirm email, sign in on a second device | Local + API (30 Oct) | PASS. **UNVERIFIED on live** |
| **2. Google Calendar** | Connect, today's events on Today and Calendar, fixed in the plan, changed events flagged, refresh, disconnect | Local (mocked Google), Live for the owner's account (31 Oct) | PASS (owner). Other accounts are blocked by Testing mode, see GOOGLE_CALENDAR_PRODUCTION.md |
| **3. Daily planning** | Done, Skip (nothing else moves), Move tasks up with a preview (Apply or Keep), **Move to tomorrow / Not today** (nothing else moves, Undo works, survives a reload) | Local | PASS |
| **4. Rerouting** | Rain on an outdoor plan, real nearby places with distance, travel time and opening-hours confidence, the next fixed commitment kept, Use this / Not this place / Keep | Local (snapshot), Live (`/demo` with live places, 1 Nov) | PASS. In the app it uses the same engine with the user's own location |
| **5. Routines** | Create, choose days (Weekdays), it appears in today's plan on its days only, edit days, "None of your routines repeat today", pause and resume, survives a reload, no duplicates (each routine is one record, planned once per day) | Local | PASS |
| **6. Together** | Two accounts: share, "Can I join?", owner says yes or "Not this time", private notes stay private, plans unchanged | Local + API (30 Oct) | PASS. **UNVERIFIED on live** |
| **7. Mobile** | Bottom navigation at 360 px: every tab on screen, 44 px or taller, the last button on the page scrolls clear of the bar, back, forward and reload keep the tab, keyboard Enter works | Local | PASS |

## Notes by area

- **Navigation.** Today, Plan, Calendar, Routines and Together are in a bottom bar on phones. On wider screens it floats under the page's column, the same width as the content. They are real links (`/app`, `/app/plan`, `/app/days`, `/app/routines`, `/app/together`). Together appears when accounts are on, which they are in production.
- **Today.** It shows the next thing, then the rest of the day, plus finished items, calendar changes and weather precautions. Item details hold Done, Skip today, Move to tomorrow / Not today, Edit, Pin, other options and directions.
- **Plan.** Lists today's one-offs, the routines that repeat today, and calendar events (each can be left out today). Natural-language add works on the device ("Gym 1h after 5pm"). The AI version ("smart add") is off in production because no Anthropic key is set.
- **Calendar.** Week and month views, Google events per day, your plans per day, past days.
- **Demo separation.** Onboarding used to offer "Try an example day", which copied sample tasks into the user's real plan. It has been replaced by **Skip for now** and a link to `/demo`, which never touches stored data.
- **Not built:** push notifications, two-way calendar sync, and syncing today's built plan between devices. The inputs sync, and each device builds the plan from them.
