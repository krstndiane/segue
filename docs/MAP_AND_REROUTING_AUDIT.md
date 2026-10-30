# Map, place data and rerouting audit — 29 October 2026

Evidence for the "Live map and place data" and "Rerouting engine" rows of [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md). Test location: Ayala Ave, Makati (14.5547, 121.0244) and central Quezon City (14.676, 121.0437): public commercial areas, no personal location used.

## There is no in-app map

Segue shows places as names, with distance, trip time and listed hours, plus a **Directions** link that opens Google Maps at the place's coordinates (`directionsUrl` in `apps/web/src/lib/format.ts`). There are no map tiles, pins or markers, so the brief's map-pin checks (markers vs. cards, tiles loading, marker selection) don't apply. Coordinates are checked instead: every place kept is inside the search radius, and the Directions link uses the same coordinates the planner used.

## Where place data comes from

| Environment | Chain | Verified |
| --- | --- | --- |
| Live (`main`) | cache → Overpass → **mock** | `/health`: `cached(osm→mock)`. Gyms near Makati and Quezon City and libraries in Manila: every result `source: "mock"` ("Iron Box", "Night Lift", "Core Studio", "Pulse Fitness"; "City Library", "Reading Room") with invented hours. **Fabricated data in production.** |
| Candidate | cache → Overpass (2 servers, 6 s budget, then a 10-minute rest) → **Nominatim search** | Real OpenStreetMap data, below. Never mock outside `PLACES_PROVIDER=mock`. |
| Candidate + Google key | cache → Google Places (daily budget) → Overpass → Nominatim | Not tested (no key). |

### Why the live site fell back to fake places

From an ordinary home connection on 29 October 2026, the same query Segue sends got:
- `overpass-api.de`: **502** after 0.7 s, "This Overpass API server is currently at capacity. All query workers are busy and the request queue is full."
- `overpass.private.coffee`: no answer within 15 s.
- `overpass.kumi.systems`: no answer within 15 s.

So removing the mock fallback alone would have left Segue with **no** place data most of the time. Nominatim, OpenStreetMap's search service, answered every request in 0.4–1.4 s, and Render already reaches it (the live `/v1/place-name` returns "San Lorenzo, Makati").

### The Nominatim fallback, checked on real responses

16 real searches (8 kinds of place × 2 areas), run through the candidate's own parsing code:

| Search | Kept | Filtered out | Farthest | Open at 5 PM Thu / unknown hours | Nearest results |
| --- | --- | --- | --- | --- | --- |
| Ayala gym | 22 | 1 | 1951 m | 3 / 19 | Gold's Gym 287 m; Anytime Fitness 439 m (24/7); Fitness First 511 m |
| Ayala café | 34 | 6 | 1834 m | 4 / 30 | Starbucks 159 m (until 2 AM); Greyhound Café; Common Man Coffee Roasters (until 10 PM) |
| Ayala mall | 23 | 0 | 1734 m | 7 / 16 | The Link; Greenbelt 4; Glorietta 3 (until 9 PM) |
| Ayala park | 24 | 11 (8 unnamed) | 1886 m | 8 / 15 | Ayala Triangle Gardens (24/7); Greenbelt Park; Salcedo Park (6 AM–10 PM) |
| Ayala library | 2 | 0 | 281 m | 1 / 1 | Filipinas Heritage Library (Tue–Sat 10–12 and 1–6) |
| Ayala restaurant | 36 | 4 | 1997 m | 5 / 31 | The Lobby; Tower Club; Mesa |
| Ayala grocery | 34 | 3 | 1921 m | 8 / 26 | Landmark Supermarket; The Marketplace; Rustan's Fresh |
| Ayala coworking | 4 | 0 | 1294 m | 1 / 3 | The Astbury (24/7, Wi-Fi) … |
| QC gym | 10 | 0 | 1793 m | 3 / 7 | Philippine Sports Performance; Fitness Army; VNT Gym |
| QC grocery | 13 | 3 | 1971 m | 4 / 9 | Savemore Market (until 9 PM); Puregold (until 9 PM) |
| QC library / mall / park / café / restaurant | 1 / 2 / 7 / 30 / 30 | | ≤1993 m | | Quezon City Public Library; Circle C; Rosalia Village Park; OnaBrew; Lugaw Republic |
| QC coworking | 0 | 0 | | | none mapped, so the plan uses the no-place version |

Checks that held for every search: names are real and plausible; ids are unique (`osm:node/…`, the same ids as Overpass, so the two sources never double up); coordinates are valid and within the 2 km radius; results are sorted nearest first. Results whose map tag doesn't match are dropped: a covered court named "Don Zanoni Memorial Gym" and a school called "Little Gym" fell out of an earlier text query. Unnamed parks are dropped. An exact tag search (`[leisure=fitness_centre]`) found 23 fitness centres where the word "gym" found 3. The fixture `packages/engine/test/makati-osm.json` keeps a sample (OpenStreetMap contributors, ODbL).

### Opening hours and status

What Segue says comes from **listed** hours only, never real-time availability:

| Case | Behaviour (tested) |
| --- | --- |
| Listed, open at arrival | "Open from 5:00 PM until 9:00 PM by its listed hours" |
| Listed, closed | Left out: "Closed for the rest of today by its listed hours" |
| Closes before the activity could finish | Left out: "Closes at 5:00 PM, too soon for 1 h after you'd arrive" |
| Different hours on different days | Day-by-day periods (SM Makati 10–9 on weekdays, 10–10 on weekends) |
| Split shifts | Filipinas Heritage Library 10–12 and 1–6: a two-hour study starts at 1:00 PM |
| Past midnight | Starbucks 6:30 AM–2:00 AM read correctly |
| No hours listed | Offered, but "Opening hours aren't listed, so check before you go"; plan confidence "unconfirmed" |
| Temporarily closed (Google status, or OSM `opening_hours=closed`) | Never planned |
| Time zone | Hours are read in the user's offset (Manila +8). Places within the search radius share it. |

**Limitation:** only about 10–30% of places in these areas have hours in OpenStreetMap, and some entries are stale ("ASpace (moved to the Astbury, Poblaciion)" is still mapped). Google Places would give far better hours; it's paid and capped by `GOOGLE_DAILY_BUDGET`.

### Failure behaviour (production API build, no network)

`/health` OK. A re-route still plans, with "Couldn't reach live map data for gyms right now, so those plans use their no-place version." and "No weather forecast right now…". `GET /v1/places/nearby` answers **503** `places_unavailable` (it answered 500 before the fix). `/health.placesStatus` shows the last failure. No made-up places at any point.

## Rerouting

All scenarios run in `packages/engine/test/realWorld.test.ts` on the real Makati places (Thursday 29 Oct, local travel mode, dinner at Greenbelt 6:30 PM). The fixed-meeting regression also runs through the **production API build**.

| # | Scenario | Result | What Segue produced |
| --- | --- | --- | --- |
| — | **Fixed meeting, "Something came up" at 2:40 PM** | **PASS** (5/5 checks) | Meeting kept, 3:00–4:00 PM, "⚠ Overlaps Something came up (2:40–3:40 PM)"; "Write report" 4:00–6:00 PM (not 3:40); no "dropped" change |
| — | Two overlapping calendar events | PASS | Both kept: "Class ⚠ Overlaps Dentist (3:30–4:30 PM)" and the reverse |
| — | Meeting you can't reach in time | PASS | "You can't get there by 2:20 PM: about N min late", or "You can't get there before it ends at 3:00 PM" when you'd arrive after it ends (wording fixed in this audit) |
| 1 | Sudden rain before a 5 PM run, dinner 6:30 PM | PASS | "90% chance of rain around 5:00 PM (forecast), and Run is outdoors" → Walk indoors at Glorietta 3 (open until 9 PM by listed hours, leaves 40 min before dinner); Work out at Anytime Fitness (24 h by listed hours); indoor workout where you are; the run at Ayala Triangle Gardens at 7:35 PM when the forecast says 10% |
| 2 | Planned gym closed | PASS | "You said Gold's Gym isn't available" → Anytime Fitness (about 8 min away) 5:10–5:55 PM, leaves 14 min before dinner; a bodyweight workout; options after dinner. Gold's Gym listed as excluded for that reason. With 35 min left before dinner: only a shorter workout that finishes in time. |
| 3 | Two hours of study | PASS | "Study 2h" needs no place (planned where you are). "Somewhere quiet" goes to the Filipinas Heritage Library at 1:00 PM, respecting its lunch break. |
| 4 | Meeting runs late | PASS | Dinner unchanged; report moved to 4:30–6:00 PM |
| 5 | Not enough time | PASS | Not squeezed in: "Needs 120 min, but only 90 min left before 7:00 PM" |
| 6 | No viable alternative | PASS | No options; "Nothing nearby fits today…"; each gym: "Only 20 min left before 10:00 PM, and it takes 45 min" (reason fixed in this audit) |
| 7 | Missing or stale data | PASS | Gyms without hours: confidence "unconfirmed", "Opening hours not confirmed — check before you go"; "No current forecast, so rain isn't factored in" |
| 8 | User rejects a suggestion | PASS | The rejected place isn't offered again that day |
| 9 | Maps and weather down | PASS | Dinner kept; only the no-place option offered; "No current forecast, so Segue can't say when the rain will stop" |

**Defects found by running on real places, all fixed and covered by tests:**
- With rain, it offered two mall walks at the same complex (Glorietta, Glorietta 3) and not the 24/7 gym 300 m away. Options now cover a gym *and* a mall walk, and places within 150 m of each other count as one trip.
- A shorter option could end exactly at dinner time, leaving no time to travel. The planner's 5-minute grace now never applies to alternatives.
- Exclusion reasons were wrong for a place you said was unavailable, and for when the day itself had run out.
- Two branches of the same chain looked identical. They now show how far each is.

## Plain-language requests

| Request | Before this audit | Now |
| --- | --- | --- |
| "I need to study for two hours." | Quick add: 1 h 30 min (didn't read "two"), title kept "I need to…". Assistant: "didn't catch that". | Quick add: "Study", 2 h, anywhere. Assistant: explains that adding happens in the Add bar. |
| "Find a gym near me that's open now." | Assistant described the gym already in the plan | Searches: only places open by listed hours, or with unknown hours (said as such) |
| "It's raining; what can I do instead of running?" | Options for the outdoor item (rain) | same |
| "Move my workout because my meeting is running late." | Options for the workout (late) | same |
| "I need to finish this report before 7 PM." | Assistant echoed the item | "Yes: … 2 h 30 min before 7 PM", or how much it misses by |
| "Find somewhere quiet near my next meeting." | Answered "what's next" | Searches libraries near where you're planning from. Near the meeting itself isn't supported yet. |
| "I only have 30 minutes before class." | Echoed the class | "Class is at 2:30 PM, in 30 min. Nothing else is planned before it, so the 30 min is free." (or what's planned and too long, with a button for shorter options) |
| "Can I still make it to the gym?" | Planned time, trip, listed-hours status | same |
| "Reorganize my day without moving my meetings." | Opens the proposal; set times never move | same |

Quick add keeps activity, duration, deadline ("before 7 PM" → latest 19:00), fixed time and requirements apart, and only asks for a place when one is named or needed. Parsed blocks go through the same schema validation as everything else before planning.

## Production checks (30 October 2026, after the release)

Run against the live API (`main` = `c6817f2`) from a browser, with its real place searches and live weather, Friday 30 Oct, Ayala Ave Makati, dinner at Greenbelt 6:30 PM.

| # | Scenario | Result | What the live API produced |
| --- | --- | --- | --- |
| — | Fixed meeting, "Something came up" at 2:40 PM | **PASS** | Client meeting kept 3:00–4:00 PM with "Overlaps Something came up"; report 4:00–6:00 PM; nothing dropped |
| 1–2 | Rain before a 5 PM run | **PASS WITH LIMITATIONS** | "You said it's raining, and Run is outdoors" → walk indoors at Greenbelt 4 (41 min spare before dinner), The Shops Ayala Triangle Gardens, work out at Fitness First, or indoors where you are. All real (`osm`), none late. It wasn't actually raining, so the forecast path wasn't exercised live |
| 3 | Planned gym unavailable / hours unknown | **PASS** | "You said Movement in Play isn't available" → Elorde Top Team, Torre Yoga and Wellness, a bodyweight workout, or a shorter Fitness First visit before dinner. Hours "unknown" for all, said as such |
| 4 | 30 minutes before class | **PASS** | "A shorter version where you are (30 min)" 5:00–5:30 PM, then options after class. Nothing overlaps the class |
| 5 | Deadline | **PASS** | "Needs 120 min, but only 90 min left before 7:00 PM" |
| 6 | Meeting runs late | **PASS** | Report moved to 4:30–6:00 PM, dinner unchanged |
| 7 | Nothing feasible | **PASS** | "Not enough time left before 10:00 PM" |
| 8 | Map source unavailable | **PASS** | Observed for real on 29 Oct (Nominatim 429): 503 with a plain message, no made-up places |
| 9 | Rejected suggestion | **PASS** | Elorde Top Team rejected → not offered again |
| 10 | Offline | **UNVERIFIED live** | Covered by browser tests only |

Opening hours: none of the places offered in these checks had listed hours, so every suggestion said to check before going. That's the main quality limit of OpenStreetMap data here.
