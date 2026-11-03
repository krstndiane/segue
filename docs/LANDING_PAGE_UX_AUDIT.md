# Landing page UX audit (4 November 2026)

This follows the 3 November master plan, section 4 ("one path, clear labels; tell the story once; look and rhythm; motion") and replaces the 1 November "Intelligent daily planner" hero (`LANDING_PAGE_AUDIT.md`).

## Problems found

| Before | Problem |
| --- | --- |
| "Intelligent daily planner" / "Your day, planned around real life." | Clear that it's a planner, but nothing about routes, the idea that sets Segue apart |
| Two hero buttons (Get started, See how it works), plus **Continue with Google**, which was the brightest one | Three choices, and the Google button pulled the most attention |
| "How it works" in the nav scrolled the page; "See how it works" opened `/demo` | The same words did two different things |
| The rain story three times: hero mockup, "When plans change", `/demo` | Visitors couldn't tell which was the real explanation |
| "What Segue does" was empty until **Make it rain** was pressed | Looked broken |
| Every section after the hero the same light grey | Flat and long |

## Positioning

**Segue is a route-aware daily planner: it helps you organise your day and adapt when real life changes your plans.** Calendar, weather, places and Together support that.

## Hero

| | |
| --- | --- |
| Category label | **Your route-aware daily planner** |
| Headline | **Your day has a route. Segue helps you find your way.** |
| Supporting line | "Plan your stops, routines, and commitments in one place. When something changes, Segue helps you find a practical way forward." |
| Primary action | **Try Segue**, road yellow. It opens the app without a page load. A returning visitor sees **Open Segue** |
| Secondary | **How it works ↓**, outlined. It scrolls to the one explanation (`#how`) |
| Under the buttons | "Free, and it works without an account." |
| Visual | The sample day's **route** (Home → Ayala Triangle Gardens 2:00 PM, marked for rain → Class 3:30 PM, fixed) on a yellow road, above the **real Today screen** (the app's own `Timeline` component). It shows the rain suggestion, the next stop with travel, the fixed class from the calendar, and later items. Captioned "Segue's Today screen, on a sample day" |

No Google button anywhere on the page. Connecting Google Calendar happens inside the app.

## Calls to action

- One main action, named the same everywhere: the nav button, the hero, the end of the story, the final section and the footer all say **Try Segue** (or **Open Segue** for a returning visitor).
- **How it works** always scrolls to the same section.
- The full-screen demo is its own, differently named link: **Open the full-screen demo** (under the story) and **Full-screen demo** (footer).
- Nav: How it works · Features · Privacy · Try Segue. The footer uses the same destinations.

## The interactive explanation (told once)

**"One day, four steps"** on the logo's winding road. The road fills in yellow as you go, and a dashed branch (the detour) appears once something changes. One action per step:

| Step | Shows | Action |
| --- | --- | --- |
| 1. The plan | Today's route: the workout at 2 at Ayala Triangle Gardens (8 min away, outdoors), class at 3:30 (Calendar · fixed), personal time at 6 | **Make it rain** |
| 2. Something changes | "90% chance until about 5 PM, and the workout is outdoors." The workout is marked, with what Segue checks | **See options** |
| 3. Segue finds alternatives | Real options from the alternatives engine on an OpenStreetMap snapshot (for example, walk indoors at Glorietta 3: open by its listed hours, about 6 min away, leaves 47 min before class) | **Use this** |
| 4. You decide | The updated route, class unchanged, "Nothing moved until you chose" | **Try Segue** · Start over |

- Never an empty box.
- Steps already seen can be revisited; later ones can't be skipped to.
- The source is stated under the story: "A sample day: sample weather and real places from an OpenStreetMap snapshot of Makati, run through Segue's actual planner."
- The separate "When plans change" section and the plain-words box are gone, so the story isn't repeated.

## Page order and visual direction

1. **Hero:** the sky, as before.
2. **The problem** (cream): three everyday breaks, revealed one at a time, then "A calendar shows what you planned. Segue helps you find a practical way forward."
3. **How it works** (light sky blue): the story above.
4. **Five places, one day:** the five tabs with the app's own icons, described in terms of stops and routes.
5. **Plan together** (dark navy, road-yellow checks): share one stop or plan, not your calendar.
6. **Privacy:** updated for the server-kept Google connection.
7. **Start planning your day:** Try Segue.

Other details:
- **Palette** from the logo: navy `#1a2556`/`#0e1431`, road yellow `#ffd36e`/`#a77d2c`, cream `#fbf4e4`, sky blue `#e3ecfb`. There are dark-mode variants for cream and sky.
- Sections are tighter (44–80 px vertical padding).
- **Motion:**
  - The hero text comes in in order (label, headline, line, buttons), about 100 ms apart.
  - The problems fade up as they scroll into view.
  - The road fills as the steps advance.
  - All of it is turned off under `prefers-reduced-motion`.
  - It's CSS only, with no animation library.

## Checks

- **Browser test** (`pages.e2e.ts`): the headline, label and line; both hero actions above the fold; no Google button or link; the route ribbon and real Today preview; the five tabs; How it works goes to `#how`; exactly one Make it rain on the page; all four steps, with ≥2 real options and class unchanged; later steps can't be skipped to; the full-screen demo link; Try Segue opens the app. **Passes.**
- **Widths:** 1440, 1280, 820, 390 and 360 px, with no horizontal scroll. Checked in screenshots; on phones the copy and both buttons come first and the preview follows.

## First-time visitor test

**Not done yet.** It needs a person who hasn't seen Segue. Show them https://segue.pdyntech.com for five seconds, hide it, then ask:
1. What is Segue? (Expected: a daily planner built around your route, or one that adapts your day.)
2. What problem does it solve? (Expected: plans change because of rain, delays or closed places.)
3. What would you click next? (Expected: Try Segue.)

If they answer calendar, social app, chatbot or weather app, write down the word they used and give the hero another pass.
