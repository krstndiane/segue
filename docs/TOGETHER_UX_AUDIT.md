# Together UX audit and redesign (updated 4 November 2026)

The 1 November pass (PR #9) renamed notes to plans, added Requests, plan times, join messages and the plan card. This pass reorganises Together around coordinating plans and places with people, following the 3 November master plan ("Together, simplified: share a route or invite someone to a stop").

## Feature audit (inspected in code and tested with 3 accounts)

| Feature | State | Notes |
| --- | --- | --- |
| Profiles (name, @username, photo, about, findable or not) | Fully functional | Server-enforced privacy |
| Connections and mutuals; incoming and outgoing requests; search; blocking | Fully functional | Mutual only. No friends-of-friends |
| Shared plans (title, details, day, time, place) | Fully functional | Visibility: private, selected people, or anyone who finds you (`canSeeNote` in SQL) |
| Sharing a **route** (a chain of stops) | **Not implemented** | Routines don't have stops yet (master plan Phase 2). Today you share one plan or stop, optionally starting from a plan or routine |
| Join requests ("Can I join?") with a message, cancel, no duplicates | Fully functional | One row per person per plan; the owner is notified once |
| Approve or decline | Fully functional | Approving creates the agreed activity and invitation |
| Participant count | Fully functional (**now for everyone who can see the plan**) | A number, not names. Waiting requests stay owner-only |
| Invitations: send, accept, decline, suggest a time, cancel; status | Fully functional | Status words are now Pending, Accepted, Declined, Cancelled, Expired |
| Notifications (Updates) | Fully functional | In the app only. No push |
| Hearts | Kept as data, **removed from the interface** | On the server a join request is still a `note_interests` row (once called a heart). No heart icon or "heart" wording is left; notification settings say "Someone asks to join my plan" |
| Notes or messages | Plan details, and the optional join message | There's no chat |
| Live location sharing | Not implemented, on purpose | Only the stops people choose to share |

## Problems this pass fixes

| Problem | Effect |
| --- | --- |
| Six sections, starting with an **Overview dashboard** of counts and lists | Two places for the same things; the first screen wasn't a plan |
| "People" and "Requests" as labels | Didn't match the brief or how people talk ("Connections", "Join requests") |
| Discover cards had one button | No way to see a plan in full before asking |
| The participant count was owner-only | Others couldn't tell if a plan already had people |
| Share a plan didn't show what would be shared | Easy to worry it shares more than it does |
| "Waiting for an answer", "Can't make it" | Inconsistent with the status words in the brief |
| Leftover heart and note wording (Invitations empty state, notification settings, privacy page) | Described an older model |

## Information architecture

**Header:** "Together" and "Make time for the people and places that matter." Then **Share a plan** (filled), **Find people** (outlined), and the **Updates** bell with an unread count.

**Sections:** a compact, horizontally scrolling row of chips (`role="tablist"`), styled differently from the app's bottom navigation.

| Section | What's there | Main action |
| --- | --- | --- |
| **Discover** (opens first) | Plans shared with you, or public from people you can find. Each card shows the owner and photo, who can see it, title, details, day and time, place, how many are going, and where you stand | **Can I join?** (filled); **View plan** (outlined); **Cancel request** while pending |
| **Connections** | Search, requests received and sent, your connections, blocked | Connect / Accept |
| **Invitations** | Received (waiting, going, closed) and sent (each person's status) | **Accept** (filled) / Decline; Cancel for the sender |
| **Join requests** | People asking to join your plans, with their message (approve with the time filled in, or decline), and plans you asked to join | **Say yes** (filled) / Not this time |
| **My plans** | Your plans: who can see each, going and asking counts, archived toggle | **Review requests** when people are waiting, otherwise **Edit**. More options: Invite people, Stop sharing |

Counts sit on the tabs (invitations waiting, new join-request updates, connection requests), so there's no separate dashboard.

## Plan card and View plan

- **Card**, top to bottom:
  - owner and who can see it, with More options (owner only);
  - title and details;
  - day and time, then place;
  - "Just Ana so far" or "3 participants";
  - a divider, then the status on the left and the actions on the right, main action last.
  - On phones narrower than 420 px the actions take the full row at 44 px tall.
- **View plan** (sheet): the owner, @username and who can see it; When, Where, Who's going; details; your status; and the same single action. It ends with: "Only this plan is shared with you. Ana's calendar, routines and other plans stay private."

## Button hierarchy

- **Filled (primary):** Share a plan, Can I join?, Send request, Say yes, Accept, Review requests, Share plan, Connect.
- **Outlined (secondary):** Find people, View plan, Edit, Decline, Not this time.
- **Text, or inside More options:** Cancel request, Invite people, Stop sharing, Archive, Delete, Remove connection, Block.
- Every button calls a real endpoint. It's disabled while working, shows a toast or an inline error, and can't be submitted twice: the server keeps one row per person per plan.

## Sharing a plan

1. **Start from one of your plans or routines** (optional): the name, day, set time and place fill in.
2. Edit what, details or a message, day, time and place.
3. Choose who can see it: only me, people I choose, or anyone who finds me. Each option is explained.
4. Choose whether people can ask to join.
5. **Preview: "What they'll see"**. It shows the title, time, place and details, who will see it, and "Not your calendar, routines, other plans or location."
6. **Share plan** (or **Save privately**).

Stopping sharing makes the plan private. People who could see it lose access at once (404). Nothing in your private plan or calendar changes.

## Join flow

1. Can I join?, with an optional message (up to 280 characters).
2. The owner is notified once.
3. The owner approves (time pre-filled) or declines.
4. The asker is notified. Their card shows **You're going** or **Not this time**.
5. Approving makes an agreed activity under Invitations, and the participant count goes up for everyone who can see the plan.

A request is never shown as joining: "Request sent · waiting for Ana" stays until Ana answers.

## Mobile and desktop

- **Phone (360–430 px):** header actions full-width; section chips scroll sideways; cards full-width; no horizontal overflow (checked at 390 and 360 px); the bottom navigation stays visible.
- **Desktop:** the app's 560 px column, with the same cards.
- **Accessibility:** tablist and tabs; the bell says "Updates, 3 new"; More options closes on Escape; focus rings are visible.

## Verified (three accounts: Ana, Ben, Cy; real API and Postgres; production-style build; phone sizes)

All 11 steps passed:
- Discover opens first with the five sections.
- Ben sees Ana's plan with "Just Ana so far", opens View plan, asks with a message, cancels and asks again (one row, one notification).
- Ana sees the count on Join requests and approves with the time filled in.
- Ben's Discover card then says "2 participants".
- My plans shows the counts; Stop sharing removes Ben's access (404).
- The share preview lists exactly what's shared.
- Ana's sent invitation reads "Accepted".
- Cy, a stranger at 360 px, sees only the public plan, gets 404 for the others by id, and nothing overflows.

## Remaining limitations

- **Route sharing** (several stops as one route) needs route routines first (master plan Phase 2).
- No push notifications.
- No "available now" status.
- Participant names are visible to the owner only.
