import { describe, expect, it } from 'vitest';
import type { InvitationView, NoteView, PublicProfile } from '@segue/schemas';
import { localDate } from '../src/lib/model';
import { overview } from '../src/lib/togetherOverview';

const person = (name: string): PublicProfile => ({ id: name, username: name.toLowerCase(), displayName: name, avatar: null, bio: '' });
const me = person('Me');
const ana = person('Ana');
const ben = person('Ben');
const today = '2026-10-30';
const now = new Date(2026, 9, 30, 9).getTime();
const at = (h: number, d = 30) => new Date(2026, 9, d, h).toISOString();

const note = (id: string, extra: Partial<NoteView> = {}): NoteView => ({
  id,
  author: ana,
  title: id,
  body: '',
  visibility: 'selected',
  onDate: today,
  placeName: null,
  createdAt: at(8),
  updatedAt: at(8),
  archived: false,
  mine: false,
  openToJoin: true,
  ...extra,
});
let n = 0;
const inv = (activityId: string, extra: Partial<InvitationView> & { startsAt?: string | null; endsAt?: string | null; title?: string; active?: boolean } = {}): InvitationView => ({
  id: `inv${++n}`,
  activity: {
    id: activityId,
    title: extra.title ?? activityId,
    description: '',
    startsAt: extra.startsAt === undefined ? at(15) : extra.startsAt,
    endsAt: extra.endsAt === undefined ? at(16) : extra.endsAt,
    timezone: 'Asia/Manila',
    placeName: null,
    meetingNotes: '',
    status: extra.active === false ? 'cancelled' : 'active',
    updatedAt: at(8),
  } as InvitationView['activity'],
  sender: ana,
  recipient: me,
  direction: 'received',
  status: 'pending',
  expiresAt: null,
  respondedAt: null,
  changedFields: [],
  counter: null,
  createdAt: at(8),
  updatedAt: at(8),
  ...extra,
});
const run = (x: Partial<Parameters<typeof overview>[0]>) => overview({ invitations: [], mine: [], others: [], today, now, eventsOn: () => [], localDate, ...x });

describe('the Together overview', () => {
  it('lists what needs your answer: invitations waiting, and requests to join your plans', () => {
    const o = run({ invitations: [inv('study'), inv('old', { active: false })], mine: [note('Run', { mine: true, author: me, heartCount: 2 }), note('Quiet', { mine: true, author: me, heartCount: 0 })] });
    expect(o.toAnswer.map((i) => i.activity.id)).toEqual(['study']);
    expect(o.requests.map((x) => x.title)).toEqual(['Run']);
  });

  it('shows agreed plans once each, soonest first, with everyone in them, and skips ones that are over or cancelled', () => {
    const o = run({
      invitations: [
        inv('lunch', { status: 'accepted', startsAt: at(12), endsAt: at(13) }),
        // You're the host of "hike": one row per guest becomes one plan with both of them.
        inv('hike', { status: 'accepted', direction: 'sent', sender: me, recipient: ana, startsAt: at(7, 31), endsAt: at(10, 31) }),
        inv('hike', { status: 'accepted', direction: 'sent', sender: me, recipient: ben, startsAt: at(7, 31), endsAt: at(10, 31) }),
        inv('breakfast', { status: 'accepted', startsAt: at(7), endsAt: at(8) }),
        inv('someday', { status: 'accepted', startsAt: null, endsAt: null }),
        inv('called-off', { status: 'accepted', active: false }),
      ],
    });
    expect(o.together.map((p) => [p.invitation.activity.id, p.with.map((x) => x.displayName)])).toEqual([
      ['lunch', ['Ana']],
      ['hike', ['Ana', 'Ben']],
      ['someday', ['Ana']],
    ]);
  });

  it("flags an agreed plan that clashes with your calendar, but doesn't move anything", () => {
    const o = run({ invitations: [inv('coffee', { status: 'accepted', startsAt: at(15), endsAt: at(16) })], eventsOn: (d) => (d === today ? [{ id: 'e', title: 'Client call', start: at(15), end: at(16) }] : []) });
    expect(o.together[0]!.clashes).toEqual(['Client call']);
  });

  it('shows plans you can join, ones you asked about, and leaves out past, archived, closed and answered ones', () => {
    const o = run({
      others: [
        note('Study', { onDate: '2026-10-31' }),
        note('Jog'),
        note('Any day', { onDate: null }),
        note('Asked', { hearted: true, interest: 'interested' }),
        note('Yesterday', { onDate: '2026-10-29' }),
        note('Closed', { openToJoin: false }),
        note('Old', { archived: true }),
        note('Going', { interest: 'accepted' }),
        note('No', { interest: 'not_now' }),
        note('Jog'), // the same note from two lists
      ],
    });
    expect(o.joinable.map((x) => x.title)).toEqual(['Jog', 'Study', 'Any day']);
    expect(o.asked.map((x) => x.title)).toEqual(['Asked']);
  });

  it('is empty, not made up, when nobody has shared anything', () => {
    expect(run({})).toEqual({ toAnswer: [], requests: [], together: [], joinable: [], asked: [] });
  });
});
