# Release readiness: `product-demo` (1 November 2026)

**Recommendation: READY TO MERGE AFTER REVIEW.** The code is tested. For Google sign-in to work for anyone except the owner, the owner must change one setting in Google Cloud (see GOOGLE_INTEGRATION_AUDIT.md).

| | |
| --- | --- |
| Base | `main` = `f0a67f6` (live) |
| Branch | `product-demo` (see the pull request for the commit) |
| What changes | Rebuilt landing page, the new `/demo`, plainer Google error messages, option titles that follow the chosen option |
| API, database, environment variables | **No changes.** No migrations and no new dependencies |
| Assistant | Still off `main`. The build check passes on a production-style build |
| Merged or deployed by this work | **Nothing.** The owner merges |

## Checks (run locally on the branch)

| Check | Result |
| --- | --- |
| Typecheck: engine, schemas, providers, api, web | PASS |
| Engine / schemas / providers unit tests | 65/65, 7/7, 70/70 |
| API (Postgres 16) | 109/109 |
| Web unit tests | 233/235. The 2 sky-preview tests need `import.meta.env.DEV` and pass in CI (unchanged from before) |
| Browser tests (whole suite, Pixel 7 profile) | 33/33 |
| Production-style build, then `check-build.mjs` (no in-development features) | PASS |
| Production-style build at 1280 and 390 px, on `/` and `/demo` | 0 console errors, 0 broken images, no horizontal scroll |
| CI on the pull request | See the PR. CI logs aren't readable from here |

## After merge (owner)

1. Wait for Vercel to deploy `main`.
2. Open https://segue.pdyntech.com and https://segue.pdyntech.com/demo on a laptop and a phone, and run the rehearsal in DEMO_READINESS.md.
3. In Google Cloud → Audience, add test users or publish the app.

## Rollback

Revert the merge commit on `main`. Nothing outside the web app changed, so there is no data to roll back.
