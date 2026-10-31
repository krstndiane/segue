/**
 * The Together overview, worked out from what the server already let this
 * person see: nothing here fetches, and nothing is made up. Pure, so it's
 * easy to test.
 */
import type { InvitationView, NoteView } from '@segue/schemas';
import type { CalendarEvent } from './calendar';

export interface PlanTogether {
  invitation: InvitationView;
  /** the other people in it */
  with: InvitationView['sender'][];
  /** your own calendar events at the same time */
  clashes: string[];
}

export interface Overview {
  /** invitations waiting for your answer */
  toAnswer: InvitationView[];
  /** your plans that people asked to join, with how many asked */
  requests: NoteView[];
  /** agreed plans, soonest first (undated ones last) */
  together: PlanTogether[];
  /** plans your people shared that you can still join, today or later (undated too) */
  joinable: NoteView[];
  /** plans you asked to join, waiting for an answer */
  asked: NoteView[];
}

const active = (i: InvitationView) => i.activity.status === 'active';

export function overview(input: { invitations: InvitationView[]; mine: NoteView[]; others: NoteView[]; today: string; now: number; eventsOn: (date: string) => CalendarEvent[]; localDate: (d: Date) => string }): Overview {
  const { invitations, now, today } = input;
  const toAnswer = invitations.filter((i) => i.direction === 'received' && i.status === 'pending' && active(i));
  // Plans with requests still waiting for your answer (not ones you've already answered).
  const requests = input.mine.filter((n) => !n.archived && (n.pendingCount ?? n.heartCount ?? 0) > 0);

  // One entry per shared activity: as the host you have one row per guest.
  const byActivity = new Map<string, InvitationView[]>();
  for (const i of invitations) {
    if (i.status !== 'accepted' || !active(i)) continue;
    const end = i.activity.endsAt ?? i.activity.startsAt;
    if (end && Date.parse(end) < now) continue;
    byActivity.set(i.activity.id, [...(byActivity.get(i.activity.id) ?? []), i]);
  }
  const together: PlanTogether[] = [...byActivity.values()].map((rows) => {
    const inv = rows[0]!;
    const people = inv.direction === 'received' ? [inv.sender] : rows.map((r) => r.recipient);
    const { startsAt, endsAt } = inv.activity;
    const clashes =
      startsAt && endsAt
        ? input
            .eventsOn(input.localDate(new Date(startsAt)))
            .filter((e) => Date.parse(e.start) < Date.parse(endsAt) && Date.parse(e.end) > Date.parse(startsAt))
            .map((e) => e.title)
        : [];
    return { invitation: inv, with: people, clashes };
  });
  together.sort((a, b) => (a.invitation.activity.startsAt ?? '9999').localeCompare(b.invitation.activity.startsAt ?? '9999'));

  const current = (n: NoteView) => !n.archived && (!n.onDate || n.onDate >= today);
  const seen = new Set<string>();
  const others = input.others.filter((n) => !n.mine && current(n) && !seen.has(n.id) && seen.add(n.id));
  const joinable = others.filter((n) => n.openToJoin && (!n.interest || n.interest === 'withdrawn'));
  const asked = others.filter((n) => n.interest === 'interested');
  const byDay = (a: NoteView, b: NoteView) => (a.onDate ?? '9999').localeCompare(b.onDate ?? '9999');
  return { toAnswer, requests, together, joinable: joinable.sort(byDay), asked: asked.sort(byDay) };
}
