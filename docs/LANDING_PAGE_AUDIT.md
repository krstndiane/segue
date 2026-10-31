# Landing page audit (1 November 2026)

## Previous messaging problems

| Before | Problem |
| --- | --- |
| Kicker: "A day planner for days that don't go to plan". Headline: "Your day changes. Segue knows what to do next." | It led with *change*. A first-time visitor had to infer that Segue is a planner at all |
| Main button: "See how it works" (demo); Google sign-in second | There was no plain "Get started" into the product itself |
| A five-item "What's inside" list of integrations | It read as a feature list, not as what you can do |
| Together sat at the same level as the core planner | Social features risked looking like the product |

## New positioning

**Segue is an intelligent daily planner.** Rerouting, context and Together support that.

## Hero (first screen, no scrolling)

| Element | Content |
| --- | --- |
| Category label | **Intelligent daily planner** |
| Headline | **Your day, planned around real life.** |
| Explanation | "Segue organizes your tasks, routines and Google Calendar into one realistic day. When it rains, a meeting runs late or a place is closed, it suggests what to do next, and you decide." |
| Primary call to action | **Get started**: opens the app, no account needed (or "Continue as {name}" for a returning account) |
| Secondary call to action | **See how it works**: the one-minute guided sample day at `/demo` |
| Optional | "Use Google Calendar? Bring it in from the start:" with the Continue with Google button |
| Visual | The **real Today screen** (the app's own `Timeline` component), drawn live on the sample day. It shows the rain suggestion, the next task with Done / Skip / Directions / Details, the class from the calendar at 3:30 PM, later items and the done count. Captioned "Segue's Today screen, on a sample day" |

The browser test checks that both calls to action sit above the fold, and that the headline, label and explanation are present.

## Page narrative

1. **Hero:** the daily planner, as above.
2. **The problem:** "You planned your day. Then the day happened." Three everyday breaks, then: "You planned to work out outside. Then it started raining, and your class is still at 3:30. Now what? A calendar shows what you planned. Segue helps with what to do next."
3. **How it works:** **Plan** (with the live plain-words box: type "Groceries before 8"), **Understand** (calendar, weather, real places and hours, travel, order), and **Adapt**.
4. **Inside Segue: five places, one day.** Today, Plan, Calendar, Routines and Together, each with the app's own bottom-navigation icon and what you can do there.
5. **When plans change:** the rain scenario on the real alternatives engine ("Make it rain"). It covers detecting the affected activity, real places, feasibility, the class kept, and you choose.
6. **Plan together:** a short supporting section with three points, smaller than the core sections.
7. **Privacy:** what's stored where.
8. **Final call to action:** "Start planning your day", with Get started and See how it works.

## Product visuals used

- **Hero:** no static screenshots. The phone frame renders the app's real `Timeline` component on the labelled sample day, so it can't drift from the actual interface.
- **Five tabs:** use the same SVG icons as the app's bottom navigation (`NAV_ICONS`).
- **Rain example:** runs the real `alternatives()` engine on sample places from an OpenStreetMap snapshot, and says so.

## Responsive checks

At 1440, 1280, 820, 390 and 360 px there is no horizontal scroll and no broken images, and the hero calls to action stay above the fold on desktop. On phones the hero text and both buttons come first and the preview follows.

## First-time visitor evaluation

**UNVERIFIED.** This needs a person who hasn't seen Segue. The five-second test:
1. Show them https://segue.pdyntech.com for five seconds, then hide it.
2. Ask what the product does. The expected answer is something like "a daily planner that adjusts your day".
3. If they say calendar, social app, chatbot or maps, note the word they used. The hero needs another pass.
