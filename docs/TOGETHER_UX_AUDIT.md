# Together UX audit and redesign (1 November 2026)

## What was there

The server side was already solid:
- mutual connections, search and blocking
- per-plan privacy (only me / people I choose / anyone who finds me)
- "Can I join?" with the owner's yes or "not this time"
- invitations (accept, decline, suggest a time, cancel)
- notifications

All of it was enforced in SQL and covered by tests. The problems were in how the screens were organised:

| Problem | Effect |
| --- | --- |
| Shared plans were called **"notes"** everywhere ("New note", "Shared a note with you") | People share *plans*. "Notes" made Together read like a notebook or a feed |
| **Two levels of tabs**: Overview / Notes / Invitations / People / Updates, and inside Notes, Mine / Shared with me / Discover / Asked | Finding "plans I can join" or "who asked to join mine" meant knowing which sub-tab hid it |
| **Requests to join your plans had no home.** They were reachable only from an Overview row or a heart count on a note card | Owners could miss requests |
| No primary action at the top of the page | "Share a plan" only appeared in the empty state |
| Plans had a day but **no time** | "Ana is studying at 2 PM" couldn't be said |
| A join request **couldn't carry a message**, and owners couldn't see how many were **going** | Less context for the owner's decision |
| Status was mixed up: after an owner said yes, the asker's card still said "Request sent" (found and fixed during testing) | A misleading state |
| Notification texts said "would like to join… Invite them when you're ready" | That described an older flow |

## New structure

**Header:** "Together", plus the line "Make time for the people who matter. You choose what to share." Then:
- **Share a plan** (primary)
- **Find people** (secondary)
- an **Updates** bell with an unread count

**Section tabs:** a scrolling row of chips, styled differently from the app's bottom navigation so the two never compete.

| Section | What's there | Main action |
| --- | --- | --- |
| **Overview** (default) | Three counts that each open their section: invitations to answer, people asking to join your plans, connections. Then "Needs your answer", "Plans together", and up to 3 of your people's plans with "See all in Discover" | Answer / Review / Can I join? |
| **Discover** | Plans shared with you, or public from people you can find. Each card shows the owner, who can see it, title, details, day and time, place, and where you stand | **Can I join?** (with an optional message), **Cancel request** |
| **Invitations** | Received (waiting / going / closed) and Sent (per activity, each person's answer) | Accept / Decline / Suggest a time; Cancel for the sender |
| **Requests** | "Asking to join your plans": each person, their message, and **Say yes** (time pre-filled from the plan) / **Not this time**, inline. "Plans you asked to join": status, and cancel | Say yes |
| **My plans** | Your plans with who can see each ("Only you", "N people you chose", "Anyone who finds you"), going and asking counts, archived toggle | **Review requests** when people are waiting, otherwise **Edit**. "More options" has Invite people and Stop sharing |
| **People** | Search, connection requests (received and sent), mutuals, blocked | Connect / Accept |
| **Updates** (the bell) | Every notification. Tapping one opens what it's about: invitations and agreed plans in Invitations, shared plans in Discover, requests in Requests | — |

The Requests tab shows a count of new request updates and marks them read when opened.

## Plan card hierarchy

1. **Top:** owner photo and name, who can see it, and "More options" (owner only).
2. **Middle:** title, details, "Tomorrow · 2:00–4:00 PM", and the place with a pin.
3. **Bottom**, after a divider: the status on the left ("Open to join", "Request sent · waiting for Ana", "You're going", "Not this time", "Not taking join requests", "1 going · 2 asking"), and the one action on the right.

## Button hierarchy

- **Primary (filled):** Share a plan, Can I join?, Send request, Say yes, Review requests, Answer, Share plan.
- **Secondary (outlined):** Find people, Edit, Not this time, Back.
- **Tertiary (text, or inside "More options"):** Cancel request, Invite people, Stop sharing, Archive, Delete.
- On phones there's at most one filled button per card. Actions in Requests sit right-aligned with a 36–44 px target.

## Flows

- **Share a plan:**
  - Optionally start from one of your own plans, which fills in the name, day and set time.
  - Fill in what, details, day, time and place.
  - Choose who can see it (with a plain explanation for each choice) and whether people can ask to join.
  - The save button says what will happen: **Share plan** or **Save privately**. Nothing in your private plan or calendar changes.
- **Can I join?:**
  - Ask, with an optional message of up to 280 characters.
  - The owner is notified once.
  - The owner says yes (with an optional time) or not this time.
  - The asker is notified.
  - A yes becomes a plan they're both in, under Invitations, marked Going.
  - The asker can cancel while it's pending. Asking twice is still one request.
- **Stop sharing** makes the plan private. People who could see it no longer can, and the server refuses them.

## Mobile and desktop

- **Phone (360–430 px):**
  - The header actions are full-width.
  - The section chips scroll sideways, with the cut-off chip hinting that there's more.
  - Cards are full-width, with no horizontal overflow at 360 px (tested).
  - The app's bottom navigation stays visible.
- **Desktop:** the app's 560 px column. The header puts the title, actions and bell on one row, and the same cards are used.
- **Accessibility:**
  - The section chips are a `tablist`.
  - The bell and counts have spoken labels ("Updates, 3 new").
  - "More options" closes on Escape, and focus rings are visible.

## Remaining limitations

- Connections are mutual only. There are no "friends of friends" suggestions; search finds people by name or @username if they allow it.
- Participant numbers are shown to the owner only ("1 going"). Others see their own status. This keeps who-is-going private by default.
- No push notifications. Updates are in the app.
- The "available now" status of other people isn't shown. Only plans they chose to share are.
