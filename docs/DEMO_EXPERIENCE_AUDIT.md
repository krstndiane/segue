# Demo experience (1 November 2026)

The guided demo is at **`/demo`**. It needs no account, no Google and no network.

## What it is built from

| Part | Real or sample |
| --- | --- |
| Today screen (timeline, ✓, Skip, details, nudges) | **Real.** The same `Timeline` component the app uses |
| Options after rain | **Real engine.** `alternatives()` with trigger `rain`, the same code the app runs |
| Applying an option, "Move tasks up" | **Real.** `applyAlternative`, `moveUp` |
| The day: study and project (done), outdoor workout 2:00–2:45 PM at Ayala Triangle Gardens, Class 3:30–5:00 PM (fixed), personal time 6–7 PM, with the clock at 1:30 PM | **Sample.** In memory only |
| Weather: 90% chance of rain from 1 to 5 PM | **Sample.** Shown as "Sample weather" and "(sample forecast)" |
| Class | **Sample calendar event.** Labelled "not your Google Calendar" |
| Places (park, gym, mall near Ayala Avenue, Makati) | **Real places, as a snapshot.** From OpenStreetMap on 29 Oct 2026 (ODbL), with hours as listed there. Labelled "Sample places (OpenStreetMap snapshot)". Optionally refreshed live from Segue's API. |
| Map | Real coordinates drawn to scale with a scale bar and rings every 500 m. It says it is "not a street map", so no streets or tiles are made up. |

## The guided flow

There are four stages, shown at the top: **The plan → Something changes → Segue's options → You decide**.

1. **The plan.**
   - Introduces fixed items (Calendar, Set time) and flexible ones.
   - **Make it rain** starts the scenario.
2. **Something changes.**
   - The sky turns to rain.
   - The real nudge appears on the timeline: "It's raining, and Outdoor workout is outdoors".
3. **Segue's options.** Three or more options, each giving:
   - the place
   - the distance and travel time
   - hours confidence
   - a reason
   - "Leaves N min before Class at 3:30 PM"

   There is a map of all of them, and the visitor can choose:
   - **Use this**
   - **Not this place** (drops it and shows the next)
   - **Use live places near Ayala instead**
   - **Keep my original plan**
4. **You decide.**
   - The timeline changes only the workout. Its title becomes "Workout" or "Indoor walk".
   - Class stays at 3:30 PM, which the page says.
   - **Undo** is available.

Visitors can also mark items ✓, Skip (nothing else moves), or ask to **Move tasks up**, which previews the change before applying it. **Restart demo** puts everything back. **Plan my own day** opens the app.

## Failure behaviour

| Failure | Behaviour | Tested |
| --- | --- | --- |
| API unreachable | The demo runs fully. The live-places option says "Live map data isn't available right now, so this still uses the sample snapshot." | Browser test (the test build has no API) |
| Google unavailable or refused | Not used by the demo | By design |
| Weather service | Not used; the weather is a sample | By design |
| Fonts unreachable | Falls back to system fonts | Seen in every local build |

## Fixes made while testing

- The options card was unstyled; it now uses the app's own `.alternatives` styles.
- The class marker letter "C" clashed with option C, so the class marker has no letter now.
- The title still said "Outdoor workout" after switching to a gym; the title now follows the option.
- At 360 px the header was 30 px too wide, and the "Demo · sample data" badge was hidden on phones. Now the header wraps and the badge is always visible, which a test checks.

## Tests

| Test | Result |
| --- | --- |
| Unit (`demo.test.ts`, 6, plus `alternatives.test.ts`) | PASS 12/12 |
| Browser: full first visit, Keep original plan, live-places fallback, Done/Skip/Move up/Restart, 360 px phone | PASS 5/5 |
| No page errors during the first-visit test | PASS |
