# Product and landing page audit (1 November 2026)

This covers the audit of what a first-time visitor saw on the live site, `main` at `f0a67f6`, and what branch `product-demo` changes.

## What went wrong before

| # | Problem on the live landing page | Why it mattered |
| --- | --- | --- |
| 1 | The hero showed a drawn "phone" with invented venues and times (`PhoneMock`). | The page showed an interface Segue doesn't have and places that aren't real. |
| 2 | The headline "Re-route your day in one tap" assumed you already knew what re-routing a day means. | Visitors couldn't tell what the product does. |
| 3 | A weather switcher (Clear / Storm…) changed the drawing, not a plan. | It looked interactive but showed nothing about how Segue decides. |
| 4 | Feature lists used generic phrases. | They said nothing about rain, fixed commitments or opening hours, which are what makes Segue different. |
| 5 | The main button was Google sign-in. If Google refused, the visitor hit an error and had nowhere to go. | This is what happened in the failed demo (see GOOGLE_INTEGRATION_AUDIT.md). |
| 6 | There was no way to see a re-route without making a plan first. | A visitor needed several minutes of setup before seeing the point of the product. |

## What the landing page does now

Every part of the page that shows the product uses the real component and the real engine. Sample data is labelled where it appears.

| Section | Content |
| --- | --- |
| Hero | "Your day changes. Segue knows what to do next." This sits next to the real Today screen running on the sample day, with the caption "Segue's Today screen, on a sample day". The main button is **See how it works**, which opens `/demo`. Under it are Google sign-in and "start without signing up". |
| Problem | "You planned your day. Then the day happened." This gives four concrete ways a day breaks. |
| How it works | 01 Plan, 02 Context, 03 Adapt. Step 01 has a live box where typing "Groceries before 8" shows how Segue reads it ("Before 8 PM"), using the real parser. |
| The example | A workout at 2, class at 3:30, then rain. "Make it rain" runs the real alternatives engine on the sample day. It shows what Segue checks, the options, and the adjusted day, with Class marked **Unchanged**. The footer says "Sample scenario" and links to the full demo. |
| Capabilities | Five capabilities, each tied to something the product actually does: Google Calendar (read-only), real places nearby, weather, one tap to finish, and Together. |
| Privacy | Read-only calendar access, no selling of data, and works without an account. |
| Final call to action | "See a day go sideways, and how Segue handles it", with links to the demo and the app. |

Removed: `PhoneMock`, the weather switcher, and the generic step, feature and reason lists, together with their CSS.

## Error states

- Google sign-in that doesn't finish now says so in plain words. The message names the "Access blocked" case and offers **Try the demo** and **Use Segue without Google** (`calendarErrorMessage`, `Landing.tsx`).
- The demo never depends on Google. It runs without the API, and its live-places option falls back with a message.

## Checks

| Check | Result |
| --- | --- |
| Landing page browser test: headline, live preview, plain-words box, rain example, option switch, links into the demo and the app | PASS |
| Production-style build at 1280 px and 390 px: console errors, broken images, horizontal scroll | PASS (0 / 0 / 0) |
| Screenshots reviewed at desktop and phone size | PASS |
| First-time visitor evaluation by someone unfamiliar with Segue | **UNVERIFIED.** Needs a person; the script is in DEMO_READINESS.md. |
