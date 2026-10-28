# Segue

**A day planner that re-routes itself when life goes off-script.**

Calendars assume you stay put. When you're always moving city to city, one missed ride or a closed café breaks the whole day. Tell Segue what you want to do in plain words ("Gym 1h after 5pm", "Lunch with Ana 12:30 at Greenbelt"), and it finds the time and the place. When something changes, tap **Re-route from here**, optionally say what happened (*running late*, *it's raining*, *I'm tired*), and it rebuilds the rest of the day around where you are, what's open, the weather, rush hour and your Google Calendar.

> *Segue* (n.) — in music, moving from one piece into the next without a pause.

## Live site

- **App:** https://segue.pdyntech.com/app
- **Privacy:** https://segue.pdyntech.com/privacy

`main` is the only branch and the one that is live. Every push to `main` redeploys the site: Vercel builds the web app and Render runs the API.

**Accounts (optional):** sign in to keep your plans on every device, share notes, heart a friend's note to say you'd like to join, and send invitations. See [docs/ACCOUNTS.md](docs/ACCOUNTS.md) for how it works and how to set up Supabase.

## What's in the box

| Path | What it is |
| --- | --- |
| `packages/engine` | The re-routing engine. Pure TypeScript, no I/O, so it runs on the server **and** offline on the phone. Greedy insertion + local search, opening hours, travel time, rain, energy, fallbacks, explanations, and plan diffs. |
| `packages/schemas` | Zod schemas for every request and record. |
| `packages/providers` | Places (OpenStreetMap, Google Places, mock), weather (Open-Meteo with a MET Norway fallback and a server-side cache), and the Places Gateway cost controls: geohash cache, fallback chain, daily budget. |
| `apps/api` | HTTP API (`POST /v1/reroute`, `POST /v1/alternatives`, `POST /v1/assistant`, `POST /v1/understand`, `GET /v1/places/nearby`, `GET /v1/weather`, `GET /v1/weather/now`, `GET /health`, and the account routes under `/v1/me`, `/v1/state`, `/v1/notes`, `/v1/invitations`, `/v1/notifications`). Zero-framework Node server with validation, CORS and rate limits; Postgres for accounts. |
| `apps/web` | Installable PWA (React + Vite). First-run setup, plain-words adding, a day timeline with swipe gestures, one-tap re-route with reasons, nudges and reminders, My spots, Google Calendar, an animated weather sky, undo, and offline re-route on the device. |
| `docs/ARCHITECTURE.md` | How it fits together, and the roadmap. |
| `docs/AUDIT.md` | The October 2026 audit: what works, what was fixed, what is open, and what to do next. |
| `docs/DEPLOYMENT_READINESS.md` | Release decision, scorecard, test report and the steps before deploying. With `MAP_AND_REROUTING_AUDIT.md` and `RELEASE_BLOCKERS.md`. |

## Quick start

Requires Node 20+ and pnpm 10.

```bash
pnpm install
cp .env.example .env          # optional, defaults work

# Terminal 1 — API on :8787 (free OpenStreetMap data by default)
pnpm dev:api

# Terminal 2 — web app on :5173
pnpm dev:web
```

Open http://localhost:5173 for the landing page, or http://localhost:5173/app for the app. A first visit to the app walks through a three-step setup; **Try an example day** fills in a starter day (deep work, lunch, gym, groceries, a call).

**No network or rate-limited?** Run the API with made-up places:

```bash
PLACES_PROVIDER=mock pnpm dev:api
```

**Using Google Places** (better hours and ratings, paid):

```bash
PLACES_PROVIDER=google GOOGLE_PLACES_API_KEY=... pnpm dev:api
```

Google calls are capped per day (`GOOGLE_DAILY_BUDGET`, default 500) and fall back to OpenStreetMap, then mock data.

**Connecting Google Calendar** (meetings and classes become fixed blocks the day is planned around):

1. In [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable the **Google Calendar API**.
2. Under **Google Auth Platform → Branding/Audience**, set up the consent screen. While the app is in *Testing*, add your own Google account as a test user.
3. Under **Data Access**, add the scopes `openid`, `email`, `profile` (for **Continue with Google** on the landing page), `https://www.googleapis.com/auth/calendar.events.readonly` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (the last lets Segue read every calendar you have switched on; without it, only your main one).
4. Under **Clients**, create an OAuth client of type **Web application**. Add `http://localhost:5173` (and your production URL) to **Authorized JavaScript origins**. No redirect URI is needed.
5. Put the client ID in `apps/web/.env`:

   ```bash
   cp apps/web/.env.example apps/web/.env   # then set VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   ```

6. Restart `pnpm dev:web`. On the landing page, **Continue with Google** signs you up and connects your calendar in one step; inside the app, the **Plan** tab (or Settings) has **Connect** for the Google Calendar screen.

Segue only reads today's timed events, and never changes your calendar. Sign-in happens in the browser and the short-lived token stays in memory, so the API never sees it. To let other people connect, Google has to verify the app for this scope (publish the consent screen and submit it for review).

**Smart add** ("Let Segue read it" for notes the phone can't parse) needs an Anthropic API key on the server:

```bash
ANTHROPIC_API_KEY=... pnpm dev:api     # SMART_ADD=off turns it off again
```

**Places in production** come from OpenStreetMap (or Google Places with a key): Overpass first, then Nominatim search when the Overpass servers are busy. Segue never fills in made-up places outside `PLACES_PROVIDER=mock`. `OVERPASS_URLS` (comma-separated) overrides the Overpass servers; `NOMINATIM_USER_AGENT` should name you and a contact (Nominatim's policy); update the privacy policy if you change providers. After a deploy, `/health` → `placesStatus` shows which source answered last. For dependable opening hours and coverage, Google Places (`PLACES_PROVIDER=google`, paid, capped by `GOOGLE_DAILY_BUDGET`) is the upgrade.

**The planning assistant** works without any AI. To let Claude word its answers for signed-in users, the API needs `ANTHROPIC_API_KEY` (the same key as smart add) and Supabase sign-in checks; `ASSISTANT_MODEL` (default `claude-haiku-5-5`), `ASSISTANT_RATE_LIMIT` (per account per hour, default 60) and `ASSISTANT_DAILY_CAP` (all users, default 500) control cost. Each answer is one short model call with a small snapshot of today; set a monthly spend limit in the Anthropic Console first.

## Deploying

The web app is static, so it goes on Vercel. The API is a long-running Node server that keeps its rate limits and places cache in memory, so it goes on a normal Node host (Render, see `render.yaml`), not on serverless functions.

**API on Render** (Blueprint: New → Blueprint → pick this repo):

1. Set `CORS_ORIGINS` to the web app's address (for example `https://segue.example.com`). Set `ANTHROPIC_API_KEY` only after setting a monthly spend limit in the Anthropic Console; leave it empty to keep smart add off.
2. Open `https://<your-service>.onrender.com/health`. It should answer `{"ok":true,...}`.
3. **Check the rate limit sees real visitors.** Make several requests that each send a different made-up first address, and confirm they still share one allowance:

   ```bash
   for i in 1 2 3 4; do curl -s -o /dev/null -w "%{http_code} " -H "x-forwarded-for: 9.9.9.$i" "https://<your-service>.onrender.com/v1/weather/now?lat=14.6&lng=121"; done
   ```

   With `READ_RATE_LIMIT=3` set for the test you should see `200 200 200 429`. If they all return `200`, the server is keying on the wrong address: raise `TRUSTED_PROXY_HOPS` to 2, or set `CLIENT_IP_HEADER` to the header your host documents. Then set `READ_RATE_LIMIT` back to `300`.

**Web on Vercel** (New Project → import the repo; the live site deploys from `main`, so keep **Production Branch** set to `main`):

1. Set **Root Directory** to `apps/web`. `apps/web/vercel.json` supplies the build output, the single-page-app rewrite and the security headers.
2. Set `VITE_API_URL` to the API's address and `VITE_GOOGLE_CLIENT_ID` to your OAuth client ID. Both are baked in at build time, so redeploy after changing them.
3. Add the production domain to **Authorized JavaScript origins** on your Google OAuth client, and to **Authorized domains** under Branding. Preview URLs change on every deploy, so test Google sign-in on the real domain.
4. In `apps/web/vercel.json`, change the `connect-src` entry `https://*.onrender.com` to your API's exact address.

## Scripts

```bash
pnpm test        # all unit, scenario, property and API tests
pnpm e2e         # browser tests of the main flows (first time: pnpm --filter @segue/web exec playwright install chromium)
pnpm typecheck   # strict TypeScript across the monorepo
pnpm build       # web → apps/web/dist, API → apps/api/dist/server.js
pnpm --filter @segue/engine bench   # engine speed on a busy day
```

## How a re-route works

1. The app sends your blocks, location, time, energy and travel mode to `POST /v1/reroute`.
2. The API looks up nearby places per category (cache first), plus the hourly forecast.
3. The engine filters out places that are closed or lack what a block needs. It then builds a plan greedily (must-dos first) and improves it with a short local search.
4. It returns the best plan, up to two alternatives ("Less travel", "Get more done"), a per-block change list, and the places it used so the phone can re-route offline next time.
5. If the API can't be reached, the phone runs the same engine against those saved places and says so.

## Status

This is the Phase 1 MVP from the architecture doc, with parts of Phase 2 (offline re-route, weather, fallbacks, explanations). Google Calendar events can be brought in as fixed blocks. Next up: accounts and sync (Postgres + PostGIS), City Kits, and location and closure triggers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

Copyright 2026 Kristina Diane Aviles. Licensed under the [Apache License 2.0](LICENSE).
