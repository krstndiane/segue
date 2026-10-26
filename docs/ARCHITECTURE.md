# Segue architecture

Segue is an offline-first day planner. A day is a set of **blocks** — what you want to do and what kind of place it needs. One tap rebuilds the rest of the day around your location, what's open, the weather, and the time and energy left.

## Principles

- **Blocks, not slots.** A block is *what* (2 h deep work) plus *requirements* (Wi-Fi, quiet, outdoors), not a place and a time.
- **Re-route in under a second.** Everything serves the loop: something changes → tap → new plan.
- **Works with bad signal.** The plan, the blocks and recently seen places live on the phone, and the engine runs there too.
- **Suggest, never force.** Re-routes are shown as a proposal with a change list, and they can be undone.
- **Cheap to run.** Paid map APIs are the main cost, so caching and budgets are part of the design.

## System

```
┌──────────────── Phone (PWA) ────────────────┐
│ React UI · IndexedDB store · service worker │
│ @segue/engine (offline re-route)            │
└───────────────┬─────────────────────────────┘
                │ HTTPS  POST /v1/reroute
┌───────────────▼─────────────────────────────┐
│ API (apps/api, node:http)                   │
│  validation (zod) · CORS · rate limit       │
│  Re-route Engine  ← @segue/engine           │
│  Places Gateway   ← @segue/providers        │
│    cache (geohash) → Google (budget) → OSM → mock
│  Context          ← Open-Meteo weather      │
└─────────────────────────────────────────────┘
```

## The engine (`packages/engine`)

The engine solves a small Orienteering Problem with Time Windows, using a heuristic so that a whole day plans in well under a second (about 0.2 s for 12 blocks × 40 places, including both alternatives).

**Inputs:** blocks; candidate places per block; context (now, end of day, location, energy, travel mode, UTC offset, hourly weather); the previous plan; pinned, done and skipped block ids; place affinity.

**Pipeline**

1. **Pin** fixed blocks (classes, meetings) and items the user pinned. A commitment is never dropped: one that overlaps another, or that can't be reached in time from where you are, keeps its time and carries a `conflict` ("Overlaps Class (3:00 PM–4:00 PM)", "You can't get there by 2:30 PM: about 25 min late"), and nothing flexible may be put before it to make that worse. The app shows the conflict in words with an icon on Today, in the re-route preview, on the hour grid (clashing items side by side) and in *Why this?*.
2. **Filter** candidates that lack a hard requirement or are out of reach, and keep the 8 best by fit, rating, affinity and distance.
3. **Insert greedily**: must → should → nice, by deadline. Every insertion is checked by simulating the whole day, so travel, opening hours (including past-midnight hours), time windows and the end of day are always respected.
4. **Improve** with a bounded local search: relocate blocks, retry unscheduled ones, and swap a lower-priority block out for a must.
5. **Fallbacks**: a block runs as its no-place version (e.g. "bodyweight workout") only when no real place fits. Outdoor blocks are the exception, since rain can make the indoor version better.
6. **Explain**: each changed item gets a reason ("Starts when Night Lift opens at 4:00 PM", "Switched to X (was Y)", "Its window ended at 2:30 PM"). Anything that didn't fit says why in words that match what happened: the window ended, how many minutes were missing before a deadline, every nearby place is closed, none stays open long enough, or the day ran out. The plan also carries up to two open alternatives per item.

**Scoring:** block value is priority × requirement fit, minus travel, unconfirmed-hours, rain, energy-mismatch, time-preference and lateness penalties, plus quality and affinity bonuses. Weights live in `DEFAULT_WEIGHTS`. The alternatives are the same solve with different weights: *Less travel* and *Get more done*.

**Guarantees** (checked by property tests over thousands of random days): flexible blocks never overlap anything, and only two commitments that clash with each other may overlap (both flagged); fixed blocks never move and are never dropped while they're still to come; flexible blocks stay inside now…end of day and their min–max duration; no place is used while it's known to be closed or known to lack a requirement; every block is either scheduled or reported with a reason; the result is deterministic.

## Places Gateway (`packages/providers`)

Every vendor sits behind `PlacesProvider` / `WeatherProvider`.

| Need | Default | Also |
| --- | --- | --- |
| Places + hours | OpenStreetMap Overpass (free) | Google Places API (New), mock |
| Weather | Open-Meteo (free) | — |

- `CachedPlacesProvider`: 24 h TTL keyed by geohash cell, category and radius bucket. Memory today; the `KeyValueStore` interface fits Redis.
- `FallbackPlacesProvider`: tries providers in order.
- `BudgetedPlacesProvider`: stops paid calls after a daily cap.
- The OSM `opening_hours` parser handles the common forms. Anything it can't honour becomes "hours unknown" rather than a guess.

**Philippines note:** jeepney, tricycle and UV routes aren't in routing data, so the `local` travel mode uses a moderate speed plus a waiting buffer.

## The app (`apps/web`)

**Sign up with Google.** The landing page's **Continue with Google** (`src/lib/account.ts`) asks Google, in one window, for the basic profile (`openid email profile`) plus the read-only calendar scopes; it saves the profile (name, email, photo) and today's events on the device and moves into the app without a page load, so the in-memory token carries over (`googleCalendar.ts` keeps one token per page, never saved). Setup then greets you by name with the calendar already connected; Settings shows who's signed in, with **Sign out**, or **Continue with Google** for people who started without it. This Google sign-in is separate from Segue accounts: nothing about it reaches the API. A Segue account (email and password, see [ACCOUNTS.md](ACCOUNTS.md)) is what syncs between devices.

**Pages.** `/` is the landing page (what Segue does, a live plain-words demo, a sky you can switch between weathers, privacy, and a link into the app). Everything else lives under `/app`: `/app` (Today), `/app/plan` (Plan my day), `/app/days` (Calendar), `/app/routines`, and `/app/calendar` (Google Calendar connection). A tiny History-API router (`src/lib/router.ts`) switches between them; the landing page and the app are separate chunks, so the landing page stays light. The installed app opens at `/app`.

- **Plan my day (`/app/plan`):** the deliberate planning screen, separate from Today, built around an **hour-by-hour grid** (`HourPlanner.tsx`): one row per hour with a line for now and travel between stops. Tap an empty spot (top or bottom half of an hour) to add something that starts then or any time after; tap an item for its details; drag an item by its handle to move it (snaps to 15 minutes, stays pinned). Calendar events and set-time items show a lock and don't move. Before there's a plan, the grid shows the day's fixed points. Day settings (end time, how you're feeling, travel) and "What's in today" (calendar events and routines switched in or out *for today only* via `DayState.excludedIds`, plus today-only items) fold away below. **Plan my day** builds the plan; once there is one it becomes **Re-plan my day** and shows the proposal first.
- **Calendar (`/app/days`):** a month grid or a week strip (`DaysPage.tsx`, pure date logic in `src/lib/days.ts`). Each day shows a teal dot for Google Calendar events and a brass dot for Segue plans. Tapping a day opens it below: its Google events, then today's plan (with Open today and Plan my day), a past day's plan with what was done or skipped (from `dayArchive`, which keeps every day's plan on the phone for about four months), or, for a future day, the things planned ahead for it (one-off blocks dated that day, added with the same quick-add bar). Planned-ahead blocks wait for their day and join the plan when it comes. Events for the weeks or month on screen are fetched only while a Google token is live this session (or on a tap of Sync) and saved per day in `calendarDays` for offline viewing; disconnecting clears them. Plan shows the same week strip at the top; tapping another day opens it on the Calendar.
- **Together (`/app/together`):** optional Segue accounts (Supabase Auth, email and password) add cross-device sync, notes with explicit visibility, hearts ("I'd like to be invited"), invitations with one answer per person, and in-app notifications. The planner never depends on them, and accepting an invitation never changes a plan until you tap **Add to my day**. Details, rules, endpoints and setup: [ACCOUNTS.md](ACCOUNTS.md).
- **Google Calendar (`/app/calendar`):** a full screen for connecting. Before connecting it says exactly what Segue reads and skips and that it never writes; after, it lists today's events with a switch to leave any of them out of today's plan, Sync now, and Disconnect. Settings and the Plan screen link to it; first-run setup keeps an inline connect card.
- **First run:** three short steps instead of a fake seeded day: location (optional), how you get around and when the day ends, then what's on today in plain words (or connect Google Calendar, or try an example day).
- **Add in plain words:** `src/lib/quickAdd.ts` turns "Gym 1h after 5pm", "Lunch with Ana 12:30 at Greenbelt" or "Standup 9:30-10" into a block on the phone, instantly and offline, and shows what it understood as chips. Things added this way are for today only; routines repeat. When the parser isn't sure and the server has smart add on, the user can tap **Let Segue read it** to send just that note to `POST /v1/understand` (Claude, structured output, clamped to the schema limits).
- **Today is a timeline:** one status line (details on tap), nudge banners, the add bar, a Next-up card ("in 25 min", Done / Directions / Details), then the rest of the day with travel legs, free gaps you can fill with one tap, and what didn't fit. Rows swipe right for done and left to skip; tapping opens the item.
- **Item details:** "Why this?" in plain reasons, change the time (moves and pins it), backups, pin, Save to My spots, Add to Google Calendar (a template link, no extra permission) and directions.
- **One-tap re-route:** the dock button plans straight away with saved settings, and the sheet offers reasons: *Running late* (starts 15 min later), *It's raining* (rain for the rest of the day, so outdoor blocks move inside), *I'm tired* (low energy), *I'm somewhere else* (fresh location), *Something came up* (keeps the next hour free). Each is a small, testable change to the engine input (`src/lib/replan.ts`). The result is still a proposal you accept, with alternatives and a change list.
- **Nudges and reminders:** `src/lib/nudges.ts` works out *Leave by…* (with directions), *Still on…?* (something ran over) and *It's raining: X is outside*. They show in the app, and with Reminders on they're also system notifications while Segue is open or in the background. Notifications with the app fully closed need a push server, which comes with accounts.
- **Weather precautions:** `src/lib/precautions.ts` turns the weather where you are into advice: *Bring an umbrella* (raining now, or a 50%+ chance within 12 hours, with the time), *Drive safely / Ride safely / Walk carefully* in heavy rain (wording follows your travel mode), *Avoid flooded streets*, storm safety, *Drink water, find shade* from a feels-like 33 °C in the daytime and a danger warning from 42 °C (PAGASA heat index levels), *Wear sunscreen* from UV 6 (WHO scale) now or later today, strong-wind and cold tips. They show as a "Before you head out" card on Today (dismissed per day; new ones come back), a strip on the Plan screen, the top tip appended to *Leave by…*, and, for serious ones with Reminders on, a notification. `/v1/weather/now` carries feels-like, UV, gusts and the next 12 hours for this. Preview any case with `?sky=clear&feels=38&uv=10&gust=60&rainAt=15` (development only, see below).
- **Learning and My spots:** done and skipped items update a per-place history on the phone; with saved places it becomes the engine's `affinity`, so places you keep going back to win ties. Saved places are also sent as `favorites` and always considered for blocks of their kind, online and offline.
- **Undo:** every change to the day (re-route, done, skip, move, swap) can be undone, up to ten steps, from the toast.
- **Routines and Settings:** Routines lists today-only items and everyday routines; the block form asks for a name and keeps the rest under "More options". Settings holds end of day, travel mode, location, reminders, °C/°F, My spots, Google Calendar and Start over.
- **Sky and theme:** a realistic animated sky drawn on a canvas (`src/lib/skyRenderer.ts`) for clear, partly cloudy, cloudy, fog, rain, heavy rain and storm. The time of day comes from the sun, never from the weather: `src/lib/sunTimes.ts` (pure, NOAA equations) gives sunrise, sunset, the sun's height and the moon's phase for the place, on its own clock, recomputed every tick. Phases: night (sun below −6°), dawn and dusk (−6° to 0°), golden hour (0° to 6°), day. Colours blend smoothly by the sun's height, the sun and moon move along their arcs, and the moon shows its real phase. The page follows the sky (`src/lib/pageTheme.ts`): dark at night and dusk whatever the system theme, the system theme by day, tinted toward the sky, with every text pair held at WCAG AA (unit-tested for every sky and phase); an unknown sky leaves `prefers-color-scheme` in charge. Header text sits on a scrim sized per sky for AA, and the pill, tabs and gear on dark glass. The status bar starts neutral and then matches the sky. The last weather is saved on the phone; past 3 hours it stops claiming any weather. Preview any sky, time and place with `?sky=fog&time=17:30&lat=40.71&lng=-74.01` (or `&hour=17.5`, `&night=1`): **only in `vite dev`**, or in a build made with `VITE_ENABLE_SKY_PREVIEW=true` for a design review (`skyPreviewEnabled` in `weather.ts`). A normal production build ignores them, so the sky can't be faked.
- **Location, found on its own:** nothing about the sky is chosen by the user: no location button, no weather picker. `src/lib/useWhereabouts.ts` asks on first open (first-run setup and a banner say why just before the browser's prompt), then follows the user with a low-power `watchPosition` (`maximumAge` 5 min) while the tab is on screen, stopping when it's hidden. A new fix is saved on the phone (`fix` in IndexedDB) after moving about 250 m or every 5 minutes; the sky asks for fresh weather after moving 3 km or every 20 minutes (`needsRefresh`), with the place's own time zone and sun times. Pure rules live in `src/lib/location.ts` (unit-tested). When there's no position, `skySource` falls back to the **last known area** (same time zone) or the **main city of the device's time zone**, and the pin says so ("Using your last known area", "Using your time zone"; precautions are held back for a time-zone guess). While the first position is on its way there's no weather at all, so another city's sky is never shown as the user's. Blocked location shows "Allow location to match your sky. Open your browser's site settings, then reload."; Segue re-checks `navigator.permissions` when the tab comes back and on the permission's change event, and picks up by itself. The pin is a status, not a button: the area's name (`/v1/place-name`) and, once the weather is over 20 minutes old, "Updated 25 min ago" (`src/lib/locationStatus.ts`).
- **Google Calendar:** in Settings (and the first-run setup). Sign-in uses Google Identity Services in the browser with read-only scopes (`calendar.events.readonly`, plus `calendar.calendarlist.readonly` to read every calendar that's switched on; without it, just the main one); the access token lives in memory only. Today's timed, busy events (and those for the days opened on the Calendar) are saved on the phone, duplicates across calendars collapse, and they become fixed `must` blocks at re-route time (`src/lib/calendar.ts`). Free, declined, cancelled and all-day events are left out. Without a live token, a re-route uses the last sync and says how old it is. Segue never writes to the calendar.
- **Offline:** IndexedDB holds blocks, settings, today's plan, places from the last server answer, My spots and place history. When the API is unreachable, the phone re-routes with the same engine and says the hours may have changed.
- Installable: web manifest, icons (generated, see `apps/web/scripts/logo`), and a service worker that caches the app shell and opens Segue when a reminder is tapped.

## Travel time

The engine estimates door-to-door minutes per mode (with a detour factor, a walking cut-off for short hops, and a waiting buffer for jeepney, tricycle and UV trips). Rides leaving on weekdays 7–10 AM and 5–8 PM local are 1.5× longer (`trafficAware` in `geo.ts`); walking isn't affected. A real routing matrix can replace all of this through `RerouteInput.travel`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/reroute` | Rebuild the rest of today. Returns `plan`, `alternatives`, `changes`, `candidates`, `meta`. |
| GET | `/v1/places/nearby?lat&lng&category&radius&limit` | Candidates for one category. |
| GET | `/v1/weather?lat&lng` | Hourly forecast. |
| GET | `/v1/place-name?lat&lng` | A short name for the area ("Urdaneta, Makati") from OpenStreetMap's Nominatim, cached by geohash cell for 30 days and spaced a second apart; `{name: null}` when there isn't one or it fails. |
| GET | `/v1/weather/now?lat&lng` | Current conditions as one of five skies, plus feels-like, UV, gusts and the next 12 hours (rain chance, UV, feels-like), for the header and weather precautions. |
| POST | `/v1/understand` | `{text, localTime}` → blocks read from a plain-words note by Claude. Only when smart add is on; 404 otherwise. |
| GET | `/health` | Liveness, which providers are active, and whether smart add is on. |

Requests are validated with the zod schemas in `packages/schemas`, and 400 responses list the failing fields. `/v1/reroute` is rate-limited per client (default 60 an hour) and `/v1/understand` separately (default 40 an hour, counted only for valid requests, since each one costs money). Bodies are capped at 256 KB. `/v1/reroute` also accepts `favorites` (the user's saved places), which join the candidates for blocks of their kind.

**Smart add** uses `claude-opus-5-5` through the Anthropic SDK with structured output (a Zod schema), low effort, and the server-side refusal fallback. It's on when `ANTHROPIC_API_KEY` is set (or `SMART_ADD=on` with other Anthropic credentials) and off with `SMART_ADD=off`. The answer is clamped to what the schemas accept before it's returned, and the engine plans it like any other block.

## Decisions for the MVP

| Decision | Why | Later |
| --- | --- | --- |
| `node:http` instead of NestJS/Fastify | Zero framework and a tiny surface; easy to read and test | Move to Fastify or Nest when auth and more modules land |
| No database yet | The phone is the source of truth for one user | Postgres + PostGIS (`users`, `block_templates`, `day_plans`, `plan_versions`, `places`, `city_kits`, `events`) |
| In-memory cache | One instance is enough to start | Redis behind `KeyValueStore` |
| Raw IndexedDB wrapper | No dependency for 30 lines of code | Dexie if queries grow |
| Hand-written service worker | Full control of what's cached | Workbox if needed |

## Roadmap

1. **MVP (this repo):** blocks, Today view, manual re-route, places + greedy engine, installable PWA. *Gate: used for 10 real days.*
2. **Offline + context:** on-device re-route ✅, weather ✅, fallbacks ✅, explanations ✅, sync across devices ✅ (with a Segue account). *Gate: works with no signal.*
3. **Smart triggers:** My spots ✅ (City Kits per city next), nudges for leaving, running over and rain ✅, rush-hour travel ✅, Google Calendar busy times ✅ (read-only, all switched-on calendars); still to do: prompts when you move more than about 2 km or a place closes, push notifications with the app closed. *Gate: re-route p95 under 1.5 s.*
4. **Learn + scale:** place preferences from done and skipped ✅; learn durations and weights from accepts, swaps and skips; notes, hearts and invitations ✅; shared daily plans and secure links next; native wrapper (Capacitor); split the engine and gateway into their own services.

## Privacy

Notes sent to smart add go to Anthropic to be read and aren't stored by Segue; the phone only sends one when the user taps **Let Segue read it**. Calendar events are read from Google in the browser; their titles, times and locations go to the API only as part of a re-route (like any other block), and the Google token never leaves the phone. Location is sent only when re-routing, checking the sky or naming the area (the last two rounded to about 1 km on the phone and again on the server; the area name comes from OpenStreetMap's Nominatim), and the server doesn't store it. The exact position from the device is kept only on the phone. Without a Segue account, plans, past days' plans, planned-ahead items and history stay on the device; only today's items go to the API, at re-route time. With one, routines, settings (without position), saved places, place history and past days (without Google Calendar items) sync to the account's database, and notes, hearts and invitations are stored there, visible only as their rules allow ([ACCOUNTS.md](ACCOUNTS.md)). API keys stay on the server. The privacy policy at `/privacy` (`src/components/PrivacyPage.tsx`) and the privacy section on the landing page must match this paragraph, so change them together.
