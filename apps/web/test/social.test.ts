import { describe, expect, it } from 'vitest';
import type { ActivityView } from '@segue/schemas';
import { activityBlock, activityBlockId, activitySlot, conflictsFor, outOfDate } from '../src/lib/invitePlan';
import type { StoredBlock } from '../src/lib/model';
import { fingerprint, forServer, isEmpty, merge } from '../src/lib/syncMerge';
import { toIso, fromIso } from '../src/lib/when';

const block = (over: Partial<StoredBlock>): StoredBlock => ({
  id: 'b',
  title: 'Block',
  minMinutes: 30,
  maxMinutes: 60,
  priority: 'should',
  category: 'none',
  requirements: [],
  active: true,
  ...over,
});

/** An activity at a local time on a local day, so tests don't depend on the machine's zone. */
const activity = (date: string, from: string, to: string | null, over: Partial<ActivityView> = {}): ActivityView => ({
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  title: 'Study session',
  description: '',
  startsAt: toIso(date, from),
  endsAt: to ? toIso(date, to) : null,
  timezone: 'Asia/Manila',
  placeName: 'Café Ten',
  meetingNotes: '',
  status: 'active',
  sourceNoteId: null,
  updatedAt: '2026-10-25T00:00:00Z',
  ...over,
});

describe('syncing two copies of the planner', () => {
  it('keeps every routine from both, and this device wins a tie', () => {
    const local = [block({ id: 'gym', title: 'Gym 6pm' }), block({ id: 'new', title: 'Only here' })];
    const server = [block({ id: 'gym', title: 'Gym 5pm' }), block({ id: 'run', title: 'Only there' })];
    const out = merge('blocks', local, server);
    expect(out.map((b) => [b.id, b.title])).toEqual([
      ['gym', 'Gym 6pm'],
      ['run', 'Only there'],
      ['new', 'Only here'],
    ]);
  });

  it('takes the higher place counts and every past day', () => {
    expect(merge('placeHistory', { a: { done: 3, skipped: 0 } }, { a: { done: 1, skipped: 2 }, b: { done: 1, skipped: 0 } })).toEqual({
      a: { done: 3, skipped: 2 },
      b: { done: 1, skipped: 0 },
    });
    const day = (d: string, t: string) => ({ date: d, items: [{ blockId: t, title: t, start: '', end: '', status: 'done' as const }] });
    const out = merge('dayArchive', { '2026-10-20': day('2026-10-20', 'mine') }, { '2026-10-20': day('2026-10-20', 'theirs'), '2026-10-19': day('2026-10-19', 'old') });
    expect(Object.keys(out).sort()).toEqual(['2026-10-19', '2026-10-20']);
    expect(out['2026-10-20']!.items[0]!.title).toBe('mine');
  });

  it("uses the account's settings but keeps this device's position and setup", () => {
    const out = merge(
      'settings',
      { endOfDay: '20:00', energy: 'low', mode: 'walk', onboarded: true, lastLocation: { lat: 14.5, lng: 121 } },
      { endOfDay: '22:00', energy: 'high', mode: 'drive', onboarded: false },
    );
    expect(out).toMatchObject({ endOfDay: '22:00', mode: 'drive', onboarded: true, lastLocation: { lat: 14.5, lng: 121 } });
  });

  it('never sends a precise position or Google Calendar events', () => {
    const s = forServer('settings', { endOfDay: '21:00', energy: 'medium', mode: 'walk', lastLocation: { lat: 1, lng: 2 }, lastLocatedAt: 'x' });
    expect(s).toEqual({ endOfDay: '21:00', energy: 'medium', mode: 'walk' });
    const a = forServer('dayArchive', {
      d: { date: 'd', items: [{ blockId: 'gcal_1', title: 'Doctor', start: '', end: '', status: 'planned' }, { blockId: 'gym', title: 'Gym', start: '', end: '', status: 'done' }] },
    });
    expect(a.d!.items.map((i) => i.blockId)).toEqual(['gym']);
    // Moving around doesn't count as a change to sync.
    expect(fingerprint('settings', { endOfDay: '21:00', energy: 'medium', mode: 'walk', lastLocation: { lat: 9, lng: 9 } })).toBe(
      fingerprint('settings', { endOfDay: '21:00', energy: 'medium', mode: 'walk' }),
    );
  });

  it('knows an untouched device from one with plans', () => {
    expect(isEmpty('blocks', [])).toBe(true);
    expect(isEmpty('settings', { endOfDay: '21:00', energy: 'medium', mode: 'walk' })).toBe(true);
    expect(isEmpty('settings', { endOfDay: '21:00', energy: 'medium', mode: 'walk', onboarded: true })).toBe(false);
    expect(isEmpty('placeHistory', { a: { done: 1, skipped: 0 } })).toBe(false);
  });
});

describe('adding an accepted invitation to your day', () => {
  it('becomes a fixed one-off on that day, on your own clock', () => {
    const b = activityBlock(activity('2026-11-07', '15:00', '17:30'))!;
    expect(b).toMatchObject({ id: activityBlockId('0f0e0d0c-0b0a-4908-8706-050403020100'), date: '2026-11-07', fixedStart: '15:00', fixedEnd: '17:30', fixedPlace: 'Café Ten', minMinutes: 150, priority: 'must' });
    // No end: an hour.
    expect(activitySlot(activity('2026-11-07', '09:00', null))).toMatchObject({ start: '09:00', end: '10:00' });
  });

  it("can't be added without a time, or across midnight", () => {
    expect(activityBlock(activity('2026-11-07', '', null, { startsAt: null }))).toBeNull();
    expect(activitySlot({ startsAt: toIso('2026-11-07', '23:00'), endsAt: toIso('2026-11-08', '01:00') })).toBeNull();
  });

  it('says what it overlaps, on that day only', () => {
    const b = activityBlock(activity('2026-11-07', '15:00', '17:00'))!;
    const blocks = [
      block({ id: 'class', title: 'Class', fixedStart: '16:00', fixedEnd: '18:00' }), // a daily routine: every day
      block({ id: 'dentist', title: 'Dentist', fixedStart: '15:30', fixedEnd: '16:00', date: '2026-11-08' }), // another day
      block({ id: 'gym', title: 'Gym' }), // flexible: Segue can move it
      block({ id: 'paused', title: 'Paused', fixedStart: '15:00', fixedEnd: '16:00', active: false }),
    ];
    const events = [
      { id: 'e1', title: 'Team call', start: toIso('2026-11-07', '14:30')!, end: toIso('2026-11-07', '15:15')! },
      { id: 'e2', title: 'Tomorrow', start: toIso('2026-11-08', '15:00')!, end: toIso('2026-11-08', '16:00')! },
    ];
    expect(conflictsFor(b, blocks, events)).toEqual(['Class', 'Team call']);
    expect(conflictsFor({ ...b, fixedStart: '17:00', fixedEnd: '18:00' }, [], events)).toEqual([]);
  });

  it('notices when the sender changed it after you added it', () => {
    const a = activity('2026-11-07', '15:00', '17:00');
    const added = activityBlock(a)!;
    expect(outOfDate(added, a)).toBe(false);
    expect(outOfDate(added, activity('2026-11-07', '16:00', '18:00'))).toBe(true);
    expect(outOfDate(added, { ...a, placeName: 'Library' })).toBe(true);
  });

  it('reads and writes local day and time', () => {
    const iso = toIso('2026-11-07', '15:45')!;
    expect(fromIso(iso)).toEqual({ date: '2026-11-07', time: '15:45' });
    expect(toIso('', '10:00')).toBeNull();
  });
});
