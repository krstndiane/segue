# Routine learning (4 November 2026)

When someone's Google Calendar is connected, Segue learns the shape of their week. It recognises classes, work, a regular gym time, study habits and appointments, asks them to confirm, and plans around what they confirm. Fixed commitments are never moved. Flexible routines get a window they can move within.

## How it fits the existing system (audit)

| Existing piece | How routine learning uses it |
| --- | --- |
| Google Calendar reads (`useCalendar`, server-kept or browser-only) | Reads a longer window (4 weeks back, 15 days ahead) through the same connection. It never opens Google's window: the read is skipped if a tap would be needed |
| Events (`parseEvents`) | Now carries Google's **`recurringEventId`** (as `seriesId`), on both the server path (`apps/api/src/social/google.ts`) and the browser path |
| Calendar events in the plan (`calendarBlocks`) | Unchanged. Events stay fixed blocks unless a confirmed flexible routine stands in for one |
| Routines (`StoredBlock` with days, time window, duration; the Routines tab and form) | **A confirmed recognised routine is an ordinary routine**, with a `learned` link (source, category, fixed or flexible, series ids, titles, usual start, confirmed date). There's no second routine system, and editing it uses the usual form |
| Planner (`rerouteDay`, `engineBlocksFor`) | Both paths call `applyRoutines` before the engine (below) |

## The parts (`apps/web/src/lib/routines.ts`, pure and deterministic)

1. **Ingestion** (`occurrencesOf`): timed, busy events become an occurrence with:
   - the local date and weekday, read in the person's time zone;
   - start and end in minutes;
   - a normalised title (lower case, punctuation gone; numbers kept, so Programming 1 and Programming 2 differ);
   - the series id and location.
2. **Detection** (`detectPatterns`):
   - **Grouping:** occurrences are grouped by series, or by normalised title (a series pulls in renamed instances), then split by time of day. "Gym" at 7 AM and "Gym" at 5 PM are separate patterns.
   - **Which days count:** a weekday counts if it appears in at least half the weeks the pattern was seen.
   - **Times:** start and end are medians, so one moved session doesn't shift the pattern.
   - **Consistency:** occurrences ÷ (weeks × days) over the span the pattern was seen.
   - **Minimum:** two occurrences in different weeks, or a recurring series.
3. **Classification** (`classify`): weighted word lists over the title, then location hints. Categories are class, fitness, work, study, appointment and personal.
   - Course codes ("CS 101") and subjects count as classes.
   - Gym, workout, "upper body", "leg day" and similar count as fitness.
   - The default kind is **fixed** for class, work and appointment, and **flexible** for fitness and study.
   - Exceptions are fixed: fitness that's booked ("Spin class", "PT", "coach") and study with an exam or presentation.
   - Vague titles are personal, fixed and low-confidence.
   - Descriptions are not read: the server doesn't pass them on, by design.
4. **Confidence:** from consistency, the number of occurrences, whether it's a series and how many weeks it spans, combined with the classification's confidence.
   - Below 0.7 the card says "Not sure about this one" and asks.
   - Nothing becomes a routine without the person's confirmation.
5. **Profile:** confirmed routines (see above), plus the learning state on the device (IndexedDB `routineLearning`):
   - pending suggestions;
   - noticed changes;
   - what was turned down (keys, series, titles);
   - what was dismissed;
   - when it last ran.
6. **Scheduling** (`applyRoutines`, used for today's plan):

   | Confirmed routine | Today's calendar has it | Calendar loaded, but not today | Calendar not loaded today |
   | --- | --- | --- | --- |
   | Fixed (class, shift) | The calendar's event is planned at today's real time, fixed and never moved; the routine steps aside (no duplicate) | Not planned: that occurrence was cancelled or moved | Planned at its usual time, protected |
   | Flexible (gym, study) | Planned as a **flexible** block around today's actual time (1 h before to 1.5 h after), in place of the fixed event | Not planned today | Planned in its usual window |

   - Routines the person made themselves are untouched.
   - Today shows a **Routine** tag and why it's there, for example: "Your routine: around 5:00 PM, can move if the day needs it", or "Your class routine: fixed, never moved".
   - Events a flexible routine stands in for are not reported as calendar changes.
7. **Change detection** (`reconcile`): runs on every analysis and compares the calendar with what's confirmed.
   - **Moved time:** the last two weeks show at least 2 occurrences, 30 minutes or more from the usual time, so it asks: "has been at 6:00 PM lately, not 5:00 PM", with **Move it to 6:00 PM** or **Keep it as it is**.
   - **Moved days:** the recent days are consistent and differ from the routine's, so it asks.
   - **Gone:** nothing for three weeks and nothing coming up, so it asks to remove it. **One missed session is not enough.**
   - **New pattern:** for example, a study session every Saturday for two weeks is suggested, not saved.
   - **Duplicates:** pending suggestions are refreshed in place by key, and corrections to them are kept, so repeated syncs never duplicate anything. Confirmed and turned-down patterns aren't suggested again.

No AI calls are made. Everything is deterministic. A language model could later help name or classify ambiguous events, but schedule protection does not depend on one.

## When it runs

- **When:** after a successful calendar sync (connecting, Sync now, the 15-minute refresh), at most every 6 hours.
- **Without a popup:** with the server-kept connection it always can; in browser-only mode, while the token from that visit lasts.
- **On disconnect:** Google Calendar's pending suggestions are cleared. Confirmed routines stay, because they belong to the person.

## In the app

- **Routines:** "We've started learning your weekly routine." The first time it shows, it says this. Later it reads "Segue noticed something in your calendar". Each card shows:
  - the category and Fixed or Flexible;
  - the name;
  - the days, times and place;
  - why ("A repeating event in your calendar, Monday, Wednesday, Friday around 8:00 AM.");
  - an "unsure" marking when it's not sure.

  The actions on each card:
  - **Save routine**;
  - **Change**: name, category, fixed or flexible (with what each means), days and times, then Save;
  - **Not a routine**: never suggested again;
  - **Merge them**: offered when two suggestions look like the same thing, for example "Gym" and "Gym workout" at about the same time;
  - **Save the N Segue is sure about**: one button for the confident ones.

  Noticed changes show **Move it to … / Keep it as it is**, or **Remove the routine / Keep it**. Confirmed routines show their category, Fixed or Flexible, and "From your Google Calendar". **Your week** lists Monday to Sunday with each day's routines. **Add a routine** works as before, for manual routines.
- **Today:** a nudge when there's something to review, and the Routine tags described above.
- **Plan:** confirmed routines are included automatically; there's nothing to re-enter.
- **Calendar:** future days don't count a learned routine twice when that day's calendar already has it. Calendar events and Segue's plans keep their own markers.
- **Together:** nothing from routines or the calendar is shared. Sharing is still one plan at a time, chosen by the person.

## Privacy

The analysis runs on the device. It reads titles, days, times and places, never descriptions. Pending suggestions stay on the device. Confirmed routines are kept like any routine the person adds: on the device, and in their account if they have one. The privacy policy says this.

## Tests

- **`apps/web/test/routines.test.ts`** (38 tests):
  - a full university timetable (recurring series and typed events, with days, times, location and confidence);
  - repeated syncs (same suggestions, no growth);
  - classification of every example in the brief, location hints, and vague titles;
  - work plus personal routines;
  - similar names (merge offer), different names with the same meaning, Programming 1 vs 2, and the same title at two times of day;
  - a recurring class with a moved and a cancelled session;
  - one missed gym session (no change), the gym moving from 5 to 6 PM (asked, not applied, not re-suggested), a timetable change to new days, deletion (three weeks: asked; one week: not), and a new Saturday study session (two weeks: suggested; a one-off: not);
  - turning one down (never back), corrections surviving a sync, confirmed not re-suggested, and an edited routine relinked;
  - missing locations;
  - time zones (Manila vs New York, across New York's daylight-saving change);
  - two overlapping recurring events;
  - the **real engine** planning a 2-hour assignment: never over a class, classes at their exact times, the gym once and flexible within its window;
  - the calendar not synced (classes still protected), a class cancelled today (not planned), manual routines untouched, and event matching by series or by title near the usual time.
- **Browser** (`pages.e2e.ts`, "routine learning"), with a fake Google Calendar timetable:
  - connect while getting started, then the Today nudge, then the review;
  - check the classes, gym and the unsure "Ana";
  - turn one down, correct one and save, save the sure ones;
  - see the origin and Fixed/Flexible labels and Your week;
  - reload: no duplicates;
  - add a 2-hour assignment and re-plan;
  - check the stored plan: classes once each at their exact times, Mathematics from today's calendar (not doubled by the routine), the gym once and flexible within its window, the assignment clear of both classes, the Routine tag on Today, and no false "calendar changed" notice.

## Known limitations

- The analysis needs the calendar to be readable without a tap: always with the server-kept connection, and in browser-only mode only during that visit's hour.
- Descriptions aren't used, by privacy choice. Classification uses titles and locations.
- The learning state is per device. Confirmed routines sync with an account.
- Merging is for pending suggestions. To combine two confirmed routines, edit one and remove the other.
- Change detection looks at the last two weeks of a four-week window. Changes older than that need a fresh look, which happens on the next analysis.
- Recurring events with complex rules are handled through Google's expanded instances (`singleEvents=true`). Segue doesn't read RRULEs itself.
