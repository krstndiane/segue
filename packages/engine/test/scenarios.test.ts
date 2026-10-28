/**
 * Real-life days, from the audit (docs/AUDIT.md). Each one checks that the
 * plan is valid, explainable, and never quietly loses a commitment.
 */
import { describe, expect, it } from 'vitest';
import { formatClock, reroute, toMs, type Block, type LatLng } from '../src';
import { TZ, at, context, everyDay, near, places } from './fixtures';

const clock = (iso: string) => formatClock(toMs(iso), TZ);
const commitment = (id: string, start: string, end: string, location?: LatLng): Block => ({
  id,
  title: id,
  minMinutes: 30,
  maxMinutes: 30,
  priority: 'must',
  category: 'none',
  requirements: [],
  fixed: { start: at(start), end: at(end), location },
});
const task = (id: string, minutes: number, extra: Partial<Block> = {}): Block => ({
  id,
  title: id,
  minMinutes: minutes,
  maxMinutes: minutes,
  priority: 'should',
  category: 'none',
  requirements: [],
  ...extra,
});
const item = (r: ReturnType<typeof reroute>, id: string) => r.plan.items.find((i) => i.blockId === id);
const noFlexibleOverlap = (r: ReturnType<typeof reroute>) => {
  for (const a of r.plan.items) {
    if (a.fixed) continue;
    for (const b of r.plan.items) {
      if (a === b) continue;
      expect(toMs(a.start) >= toMs(b.end) || toMs(a.end) <= toMs(b.start)).toBe(true);
    }
  }
};

describe('a meeting you can no longer reach in time', () => {
  it('stays in the plan, says how late you will be, and nothing is squeezed in before it', () => {
    const r = reroute({
      blocks: [commitment('Client meeting', '14:30', '15:30', near(12000, 0)), task('Email', 30)],
      candidates: {},
      context: context({ mode: 'local' }),
    });
    const meeting = item(r, 'Client meeting')!;
    expect(clock(meeting.start)).toBe('2:30 PM');
    expect(meeting.conflict).toMatch(/^You can't get there by 2:30 PM: about \d+ min late$/);
    expect(r.plan.items[0]!.blockId).toBe('Client meeting');
    expect(r.plan.unscheduled).toEqual([]);
    noFlexibleOverlap(r);
  });

  it('says plainly when you would only get there after it has ended', () => {
    // On foot, 9 km takes longer than the whole visit.
    const r = reroute({ blocks: [commitment('Site visit', '14:20', '15:00', near(9000, 0))], candidates: {}, context: context({ mode: 'walk' }) });
    expect(item(r, 'Site visit')!.conflict).toBe("You can't get there before it ends at 3:00 PM");
  });

  it('is not flagged when you can get there on time', () => {
    const r = reroute({ blocks: [commitment('Standup', '15:00', '15:30', near(500, 0))], candidates: {}, context: context() });
    expect(item(r, 'Standup')!.conflict).toBeUndefined();
  });
});

describe('two commitments at the same time', () => {
  it('keeps both, flags both, and plans other things around them', () => {
    const r = reroute({
      blocks: [commitment('Class', '15:00', '16:00'), commitment('Dentist', '15:30', '16:30'), task('Read', 60)],
      candidates: {},
      context: context(),
    });
    expect(item(r, 'Class')!.conflict).toBe('Overlaps Dentist (3:30 PM–4:30 PM)');
    expect(item(r, 'Dentist')!.conflict).toBe('Overlaps Class (3:00 PM–4:00 PM)');
    expect(r.plan.unscheduled).toEqual([]);
    noFlexibleOverlap(r);
  });

  it('flags a short event tucked inside a long one against the long one', () => {
    const r = reroute({
      blocks: [commitment('Workshop', '15:00', '18:00'), commitment('Call', '15:30', '16:00'), commitment('Check-in', '17:00', '17:15')],
      candidates: {},
      context: context(),
    });
    expect(item(r, 'Check-in')!.conflict).toBe('Overlaps Workshop (3:00 PM–6:00 PM)');
  });
});

describe('"Something came up" right before a meeting', () => {
  it('keeps the meeting and flags the overlap instead of dropping it', () => {
    const busy: Block = { ...commitment('Something came up', '14:40', '15:40'), id: 'busy_now' };
    const r = reroute({
      blocks: [busy, commitment('Client meeting', '15:00', '16:00'), task('Write report', 120)],
      candidates: {},
      context: context({ now: at('14:40') }),
    });
    expect(item(r, 'Client meeting')!.conflict).toMatch(/Overlaps Something came up/);
    const report = item(r, 'Write report')!;
    expect(toMs(report.start)).toBeGreaterThanOrEqual(toMs(at('16:00')));
    noFlexibleOverlap(r);
  });
});

describe('an overbooked day', () => {
  it('keeps the must-do, fills what fits, and says what did not fit and why', () => {
    const r = reroute({
      blocks: [task('Report', 240, { priority: 'must' }), task('Study', 180), task('Clean', 120, { priority: 'nice' }), task('Read', 90, { priority: 'nice' })],
      candidates: {},
      context: context({ now: at('16:00') }),
    });
    expect(item(r, 'Report')).toBeDefined();
    const left = r.plan.unscheduled.map((u) => u.blockId);
    expect(left.length).toBeGreaterThan(0);
    for (const u of r.plan.unscheduled) expect(u.reason).toBe('Not enough time left before 10:00 PM');
    noFlexibleOverlap(r);
  });
});

describe('deadlines', () => {
  it('says how much time is missing for a task due soon', () => {
    const r = reroute({
      blocks: [task('Submit', 60, { priority: 'must', latest: at('17:00') }), task('Gym', 60, { priority: 'nice' })],
      candidates: {},
      context: context({ now: at('16:30') }),
    });
    expect(r.plan.unscheduled).toEqual([{ blockId: 'Submit', title: 'Submit', reason: 'Needs 60 min, but only 30 min left before 5:00 PM' }]);
  });

  it('puts a task due today before its deadline, ahead of one with no deadline', () => {
    const r = reroute({
      blocks: [task('Errand', 120), task('Submit', 60, { priority: 'must', latest: at('15:30') })],
      candidates: {},
      context: context(),
    });
    expect(toMs(item(r, 'Submit')!.end)).toBeLessThanOrEqual(toMs(at('15:30')));
    expect(item(r, 'Errand')).toBeDefined();
  });

  it('says a missed morning routine is over, not that the day is full', () => {
    const r = reroute({ blocks: [task('Morning run', 30, { latest: at('09:00') })], candidates: {}, context: context() });
    expect(r.plan.unscheduled[0]!.reason).toBe('Its window ended at 9:00 AM');
  });
});

describe('places that are closed', () => {
  it('says every place is closed instead of blaming the time', () => {
    const gym: Block = { id: 'gym', title: 'Gym', minMinutes: 60, maxMinutes: 60, priority: 'should', category: 'gym', requirements: [] };
    const r = reroute({ blocks: [gym], candidates: { gym: [{ ...places.gymLate, hours: everyDay('06:00', '09:00') }] }, context: context() });
    expect(r.plan.unscheduled[0]!.reason).toBe('Every gym nearby is closed for the rest of today');
  });
});

describe('a long trip', () => {
  it('counts the travel and still starts the commitment on time when you can make it', () => {
    const r = reroute({
      blocks: [commitment('Site visit', '17:00', '18:00', near(6000, 0)), task('Pack', 30)],
      candidates: {},
      context: context({ mode: 'drive' }),
    });
    const visit = item(r, 'Site visit')!;
    expect(visit.travelMinutesBefore).toBeGreaterThan(0);
    expect(visit.conflict).toBeUndefined();
    noFlexibleOverlap(r);
  });
});
