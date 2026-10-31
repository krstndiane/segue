# Demo readiness (1 November 2026)

| | |
| --- | --- |
| Demo URL | **https://segue.pdyntech.com/demo** (live) |
| Before merge | The Vercel preview for the `product-demo` pull request, at `/demo` |
| Deploy commit | `034b710` (merge of #7), deployed by Vercel on 1 Nov 2026 |
| How to start it | Open `/demo`, or press **See how it works** on the landing page. No account or setting is needed |
| How to reset | Press **Restart demo** at the top. Reloading the page also starts over, because nothing is saved |
| Sample data isolated | **Yes.** The demo's day lives in memory in the demo page only. It never reads or writes the app's stored plan (IndexedDB) or an account, and it never calls Google. Its only network request is opt-in: **Use live places near Ayala instead** reads public places from Segue's API, sends no personal data, and saves nothing. Every sample is labelled: "Demo · sample data", "Sample weather", "(sample forecast)", "Sample calendar", "Sample places (OpenStreetMap snapshot)", "Sample scenario" |

## Status

| Requirement | Status |
| --- | --- |
| Isolated, labelled sample data | PASS |
| Guided flow: intro, plan with fixed and flexible items, rain, options with a map, distance, travel, hours, Class protected | PASS |
| Accept, view another option, keep the plan, undo | PASS |
| "Why this option" is explained | PASS (each option's reason, and "Leaves N min before Class") |
| Reset / rehearsal | PASS |
| Works with the API, weather and Google unavailable | PASS (tested with no API) |
| Live places refresh | PASS WITH LIMITATIONS. Depends on Segue's API on Render. Otherwise it says so and keeps the snapshot. Render's free tier can take about a minute to wake up. On Vercel preview links it always falls back, because the API's `CORS_ORIGINS` only allows `segue.pdyntech.com`. That was checked: from the live origin the API returned 15 park, gym and mall places in 0.1–1.1 s, and from the preview the request was refused and the fallback message showed |
| No dead buttons or debug output | PASS (every control tested; 0 console errors) |
| Desktop and phone (1280, 390, 360 px) | PASS |
| Landing page explains the product | PASS |
| Google sign-in for the owner on the live site | PASS |
| Google sign-in for other accounts | **UNVERIFIED.** It depends on the Audience setting in Google Cloud (see GOOGLE_INTEGRATION_AUDIT.md). The demo doesn't need it |
| Deployed demo on the Vercel preview (`segue-git-product-demo-…vercel.app/demo`) | PASS. It loads, rain and options work, the map draws, and the live-places fallback message shows. Checked in dark mode |
| Deployed demo checked on the live site | PASS. Rain, options, map and Use this all work, and Class stays at 3:30 PM. **Live places from OpenStreetMap load.** No broken images; the landing page's rain example and demo link work |
| First-time user evaluation | **UNVERIFIED.** Needs a person who hasn't seen Segue |

## Rehearsal (5 minutes, the day before)

1. Open `/demo` on the presenting laptop and on a phone. Confirm the badge says "Demo · sample data".
2. Press **Make it rain**, then **See what Segue suggests**. Confirm the map and at least three options appear.
3. Press **Use this** on the gym. Confirm Class still says 3:30 PM, then press **Undo**.
4. Press **Restart demo**.
5. If you'll show Google sign-in, sign in with the account you'll present with, on `segue.pdyntech.com` and not a preview link. Make sure that account is a test user, or that the app is published.
6. Have the fallback ready: if Google refuses on stage, say "the demo uses a sample calendar" and continue in `/demo`.

## First-time user evaluation (for a person to run)

Give someone who hasn't seen Segue the landing page and say nothing. Afterwards, ask:

1. In one sentence, what does Segue do?
2. What happened when it rained? What did Segue change, and what did it leave alone?
3. Why did it suggest the option it did?
4. Was anything you saw real data about you? (The expected answer is no: it's all sample data.)
5. Was any button confusing, or did any do nothing?

Write down where they hesitated. If any answer to 1 to 3 is wrong, that part of the page needs work.
