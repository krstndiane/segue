/**
 * The demo runs Segue's real alternatives engine on a sample day. These pin
 * the story it tells, so a change to the engine that breaks the demo shows up.
 */
import { describe, expect, it } from 'vitest';
import { DEMO_IDS, DEMO_PLACES, demoOptions, demoStart } from '../src/lib/demo';
import { applyAlternative, titleAfter } from '../src/lib/alternatives';

const today = new Date(2026, 10, 2, 9); // a Monday
const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m).toISOString();

describe('the demo', () => {
  it('starts as a planned day at 1:30 PM: two things done, a workout outdoors at 2, Class at 3:30 from the (sample) calendar', () => {
    const s = demoStart(today);
    expect(s.now.toISOString()).toBe(at(13, 30));
    expect(s.day.doneIds).toEqual([DEMO_IDS.study, DEMO_IDS.project]);
    const items = s.day.plan!.items;
    expect(items.find((i) => i.blockId === DEMO_IDS.workout)).toMatchObject({ start: at(14), place: { name: 'Ayala Triangle Gardens' } });
    expect(items.find((i) => i.blockId === DEMO_IDS.class)).toMatchObject({ start: at(15, 30), fixed: true });
    expect(s.raining).toBe(false);
  });

  it('only suggests anything once it rains, and then says why', () => {
    const r = demoOptions({ ...demoStart(today), raining: true });
    expect(r.problem?.text).toMatch(/chance of rain .* and Outdoor workout is outdoors/);
    expect(r.nextCommitment?.title).toBe('Class');
  });

  it('every option is indoors or later and drier, uses real snapshot places, and leaves time for Class', () => {
    const r = demoOptions({ ...demoStart(today), raining: true });
    expect(r.options.length).toBeGreaterThanOrEqual(3);
    const known = new Set(Object.values(DEMO_PLACES).flat().map((p) => p!.id));
    for (const o of r.options) {
      if (o.place) expect(known.has(o.place.id)).toBe(true);
      if (o.kind !== 'later') expect(Date.parse(o.end) + o.travelMinutes * 0).toBeLessThanOrEqual(Date.parse(at(15, 30)));
      if (o.kind !== 'later') expect(o.facts.some((f) => /Leaves \d+ min before Class/.test(f.text))).toBe(true);
    }
    // Hours are never claimed without listed hours.
    for (const o of r.options) if (o.hours?.basis === 'none') expect(o.facts.some((f) => /Open/.test(f.text) && f.kind === 'hard')).toBe(false);
  });

  it('using an option changes that item only; Class never moves; the new item is named for what it is now', () => {
    const s = { ...demoStart(today), raining: true };
    const r = demoOptions(s);
    const gym = r.options.find((o) => o.kind === 'substitute' && o.category === 'gym')!;
    const next = applyAlternative(s.day, gym);
    const w = next.plan!.items.find((i) => i.blockId === DEMO_IDS.workout)!;
    expect(w).toMatchObject({ title: 'Workout', start: gym.start, place: { id: gym.place!.id } });
    const before = s.day.plan!.items.filter((i) => i.blockId !== DEMO_IDS.workout);
    expect(next.plan!.items.filter((i) => i.blockId !== DEMO_IDS.workout)).toEqual(before);
  });

  it('"not this place" takes it out of the options', () => {
    const s = { ...demoStart(today), raining: true };
    const first = demoOptions(s).options.find((o) => o.place)!;
    expect(demoOptions(s, undefined, [first.place!.id]).options.some((o) => o.place?.id === first.place!.id)).toBe(false);
  });

  it('names a swapped item after what it became', () => {
    const base = { id: 'x', blockId: 'b', title: 'Run', category: 'park', start: at(14), end: at(15), minutes: 60, travelMinutes: 0, label: '', why: '', facts: [], tradeoffs: [] } as never as Parameters<typeof titleAfter>[0];
    expect(titleAfter({ ...base, kind: 'substitute', category: 'gym' }, 'Run')).toBe('Workout');
    expect(titleAfter({ ...base, kind: 'substitute', category: 'mall' }, 'Run')).toBe('Indoor walk');
    expect(titleAfter({ ...base, kind: 'no-place', label: 'Indoor workout where you are' }, 'Run')).toBe('Indoor workout');
    expect(titleAfter({ ...base, kind: 'later' }, 'Run')).toBe('Run');
    expect(titleAfter({ ...base, kind: 'same-kind' }, 'Run')).toBe('Run');
  });
});
