import { describe, expect, it } from 'vitest';
import { formatClock, isOpenThroughout, reroute, toMs, type Place } from '../src';
import { TZ, at, blocks, context, places } from './fixtures';

const clock = (iso: string) => formatClock(toMs(iso), TZ);
const findItem = (r: ReturnType<typeof reroute>, id: string) => r.plan.items.find((i) => i.blockId === id);

const allCandidates: Record<string, Place[]> = {
  'deep-work': [places.cafeGood, places.cafeNoWifi, places.cafeFar],
  dinner: [places.diner],
  gym: [places.gymClosesEarly, places.gymLate],
  walk: [places.park],
};

describe('reroute', () => {
  it('builds a feasible plan with every block', () => {
    const r = reroute({
      blocks: [blocks.deepWork, blocks.dinner, blocks.gym, blocks.call],
      candidates: allCandidates,
      context: context(),
    });
    expect(r.plan.unscheduled).toEqual([]);
    expect(r.plan.items.map((i) => i.blockId).sort()).toEqual(['call', 'deep-work', 'dinner', 'gym']);
    // Items are in order and never overlap.
    for (let i = 1; i < r.plan.items.length; i++) {
      expect(toMs(r.plan.items[i]!.start)).toBeGreaterThanOrEqual(toMs(r.plan.items[i - 1]!.end));
    }
  });

  it('never uses a place that lacks a hard requirement', () => {
    const r = reroute({ blocks: [blocks.deepWork], candidates: allCandidates, context: context() });
    expect(findItem(r, 'deep-work')?.place?.id).toBe('cafe-good');
  });

  it('skips a gym that closes before you can get there', () => {
    const r = reroute({ blocks: [blocks.gym], candidates: allCandidates, context: context({ now: at('14:40') }) });
    const gym = findItem(r, 'gym')!;
    expect(gym.place?.id).toBe('gym-late');
    expect(clock(gym.start)).toBe('4:00 PM');
    expect(gym.explanation).toMatch(/opens at 4:00 PM/);
  });

  it('falls back to the no-place version when no gym is open', () => {
    const r = reroute({
      blocks: [blocks.gym],
      candidates: { gym: [places.gymClosesEarly] },
      context: context({ now: at('15:30') }),
    });
    const gym = findItem(r, 'gym')!;
    expect(gym.place).toBeUndefined();
    expect(gym.confidence).toBe('no-place');
    expect(gym.explanation).toMatch(/Bodyweight workout/);
  });

  it('prefers an open place over the fallback, even when it is a ride away', () => {
    const r = reroute({
      blocks: [{ ...blocks.gym, priority: 'nice' as const }],
      candidates: { gym: [places.gymLate] },
      context: context({ now: at('16:00'), mode: 'local' }),
    });
    expect(findItem(r, 'gym')?.place?.id).toBe('gym-late');
  });

  it('says why a block was dropped when its window has passed', () => {
    const r = reroute({ blocks: [blocks.dinner], candidates: allCandidates, context: context({ now: at('20:40') }) });
    expect(r.plan.unscheduled[0]?.reason).toMatch(/window ended at 8:30 PM/);
  });

  it('says how much time is missing when the window is still open but too short', () => {
    const r = reroute({ blocks: [blocks.dinner], candidates: allCandidates, context: context({ now: at('20:10') }) });
    expect(r.plan.unscheduled[0]?.reason).toBe('Needs 45 min, but only 20 min left before 8:30 PM');
  });

  it('keeps fixed blocks exactly where they are and plans around them', () => {
    const r = reroute({
      blocks: [blocks.meeting, blocks.deepWork, blocks.dinner],
      candidates: allCandidates,
      context: context(),
    });
    const meeting = findItem(r, 'meeting')!;
    expect(meeting.start).toBe(new Date(at('17:00')).toISOString());
    expect(meeting.end).toBe(new Date(at('18:00')).toISOString());
    const dinner = findItem(r, 'dinner')!;
    expect(toMs(dinner.start)).toBeGreaterThanOrEqual(toMs(meeting.end));
  });

  it('respects time windows', () => {
    const r = reroute({ blocks: [blocks.dinner], candidates: allCandidates, context: context() });
    const dinner = findItem(r, 'dinner')!;
    expect(toMs(dinner.start)).toBeGreaterThanOrEqual(toMs(at('17:30')));
    expect(toMs(dinner.end)).toBeLessThanOrEqual(toMs(at('20:30')));
  });

  it('moves an outdoor block away from rain', () => {
    const rainyLate = [
      ...['14', '15', '16'].map((h) => ({ time: at(`${h}:00`), precipitationProbability: 5 })),
      ...['17', '18', '19', '20', '21'].map((h) => ({ time: at(`${h}:00`), precipitationProbability: 90 })),
    ];
    const r = reroute({
      blocks: [{ ...blocks.walk, timePref: 'evening' as const }],
      candidates: allCandidates,
      context: context({ weather: rainyLate }),
    });
    const walk = findItem(r, 'walk')!;
    // Either it moved before the rain, or it switched to the indoor fallback.
    const dry = toMs(walk.start) < toMs(at('17:00')) || walk.confidence === 'no-place';
    expect(dry).toBe(true);
  });

  it('reports when a must block cannot fit', () => {
    const r = reroute({
      blocks: [blocks.deepWork],
      candidates: allCandidates,
      context: context({ now: at('21:00') }),
    });
    expect(r.plan.items).toHaveLength(0);
    expect(r.plan.unscheduled[0]?.blockId).toBe('deep-work');
    expect(r.plan.unscheduled[0]?.reason).toMatch(/stays open long enough/);
  });

  it('explains a place switch when the old place closed', () => {
    const first = reroute({ blocks: [blocks.gym], candidates: allCandidates, context: context({ now: at('13:00') }) });
    expect(findItem(first, 'gym')?.place?.id).toBe('gym-early');

    const second = reroute({
      blocks: [blocks.gym],
      candidates: allCandidates,
      context: context({ now: at('14:45') }),
      previous: first.plan,
    });
    const change = second.changes.find((c) => c.blockId === 'gym')!;
    expect(change.kind).toBe('place-changed');
    expect(change.message).toMatch(/Night Lift/);
    expect(findItem(second, 'gym')?.explanation).toMatch(/Switched to Night Lift/);
  });

  it('keeps locked items in place', () => {
    const first = reroute({ blocks: [blocks.deepWork, blocks.dinner], candidates: allCandidates, context: context() });
    const lockedDinner = findItem(first, 'dinner')!;
    const second = reroute({
      blocks: [blocks.deepWork, blocks.dinner],
      candidates: allCandidates,
      context: context({ now: at('15:00'), location: places.cafeFar.location }),
      previous: first.plan,
      lockedBlockIds: ['dinner'],
    });
    const dinner = findItem(second, 'dinner')!;
    expect(dinner.start).toBe(lockedDinner.start);
    expect(dinner.place?.id).toBe(lockedDinner.place?.id);
  });

  it('ignores blocks that are already done', () => {
    const r = reroute({
      blocks: [blocks.deepWork, blocks.call],
      candidates: allCandidates,
      context: context(),
      doneBlockIds: ['deep-work'],
    });
    expect(r.plan.items.map((i) => i.blockId)).toEqual(['call']);
  });

  it('offers fallbacks that are open during the slot', () => {
    const r = reroute({ blocks: [blocks.deepWork], candidates: allCandidates, context: context() });
    const item = findItem(r, 'deep-work')!;
    const placeFallbacks = item.fallbacks.filter((f) => f.kind === 'place');
    for (const f of placeFallbacks) {
      const p: Place = Object.values(places).find((x) => x.id === f.place?.id)!;
      expect(p.attributes.wifi).not.toBe(false);
      if (p.hours) expect(isOpenThroughout(p.hours, toMs(item.start), toMs(item.end), TZ)).toBe(true);
    }
    expect(item.fallbacks.some((f) => f.kind === 'no-place')).toBe(true);
  });

  it('is deterministic', () => {
    const input = { blocks: [blocks.deepWork, blocks.dinner, blocks.gym, blocks.call], candidates: allCandidates, context: context() };
    expect(reroute(input)).toEqual(reroute(input));
  });

  it('returns distinct alternatives', () => {
    const r = reroute({
      blocks: [blocks.deepWork, blocks.dinner, blocks.gym, blocks.call, blocks.walk],
      candidates: allCandidates,
      context: context({ now: at('16:30') }),
    });
    const sigs = [r.plan, ...r.alternatives].map((p) => JSON.stringify(p.items.map((i) => [i.blockId, i.start, i.place?.id])));
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});
