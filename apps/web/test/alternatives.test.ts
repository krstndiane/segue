import { describe, expect, it } from 'vitest';
import type { Block, Place, Plan } from '@segue/engine';
import { applyAlternative, findAlternatives, forecastFromSky, refine, type AlternativesRequest } from '../src/lib/alternatives';
import { emptyDay, type PlaceCache } from '../src/lib/model';
import { nudgesFor } from '../src/lib/nudges';

const at = (hm: string) => `2026-10-27T${hm}:00+08:00`;
const iso = (hm: string) => new Date(at(hm)).toISOString();
const run: Block = { id: 'run', title: 'Run', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'] };
const park: Place = { id: 'park', name: 'Riverside Park', location: { lat: 14.598, lng: 120.984 }, category: 'park', attributes: { outdoor: true }, hours: { always: true, periods: [] }, source: 'osm' };
const gym = (id: string, source = 'osm'): Place => ({ id, name: id, location: { lat: 14.601, lng: 120.985 }, category: 'gym', attributes: { indoor: true }, hours: { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '06:00', close: '22:00' })) }, source });
const plan: Plan = {
  label: 'Balanced',
  items: [{ blockId: 'run', title: 'Run', start: iso('17:00'), end: iso('17:45'), place: { id: 'park', name: 'Riverside Park', location: park.location }, travelMinutesBefore: 5, confidence: 'verified', fixed: false, fallbacks: [] }],
  unscheduled: [],
  score: 0,
  totalTravelMinutes: 5,
};
const req: AlternativesRequest = {
  blocks: [run],
  plan,
  blockId: 'run',
  context: { now: at('16:30'), endOfDay: at('22:00'), location: { lat: 14.5995, lng: 120.9842 }, energy: 'medium', mode: 'walk', utcOffsetMinutes: 480 },
  trigger: 'rain',
};
const cache: PlaceCache = { savedAt: iso('09:00'), location: { lat: 14.5995, lng: 120.9842 }, byCategory: { park: [park], gym: [gym('Core Studio'), gym('Fake Gym', 'mock')] } };
const offline = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;

describe('other options when the server is out of reach', () => {
  it('runs the same checks on the phone with saved places, says so, and never uses made-up ones', async () => {
    const o = await findAlternatives(req, { placeCache: cache, cacheNear: true, fetchFn: offline });
    expect(o.source).toBe('device');
    expect(o.warnings[0]).toMatch(/^Offline: using places saved earlier/);
    const names = o.result.options.map((x) => x.place?.name);
    expect(names).toContain('Core Studio');
    expect(names).not.toContain('Fake Gym');
  });

  it('with nothing saved nearby, offers only what needs no place', async () => {
    const o = await findAlternatives(req, { placeCache: cache, cacheNear: false, fetchFn: offline });
    expect(o.result.options.map((x) => x.kind)).toEqual(['no-place']);
    expect(o.warnings[0]).toMatch(/only options without a place/);
  });

  it('uses the server answer when it comes back', async () => {
    const answer = { result: { blockId: 'run', title: 'Run', trigger: 'rain', options: [], excluded: [], notes: [] }, places: {}, meta: { warnings: ['x'] } };
    const ok = (async () => new Response(JSON.stringify(answer))) as unknown as typeof fetch;
    const o = await findAlternatives(req, { cacheNear: false, fetchFn: ok });
    expect(o).toMatchObject({ source: 'server', warnings: ['x'] });
  });
});

describe('changing your mind', () => {
  it('"not this place" and "only 30 minutes" recompute from the same places', async () => {
    const o = await findAlternatives(req, { placeCache: cache, cacheNear: true, fetchFn: offline });
    const without = refine(o, { avoidPlaceIds: ['Core Studio'] });
    expect(without.result.options.some((x) => x.place?.id === 'Core Studio')).toBe(false);
    const short = refine(o, { maxMinutes: 30 });
    for (const x of short.result.options) expect(x.minutes).toBeLessThanOrEqual(30);
  });
});

describe('using an option', () => {
  it('changes only that item, pins it, and stops the rain nudge for it', async () => {
    const o = await findAlternatives(req, { placeCache: cache, cacheNear: true, fetchFn: offline });
    const gymOption = o.result.options.find((x) => x.place?.id === 'Core Studio')!;
    const day = { ...emptyDay('2026-10-27'), plan };
    const next = applyAlternative(day, gymOption);
    expect(next.plan!.items[0]).toMatchObject({ blockId: 'run', start: gymOption.start, place: { id: 'Core Studio' }, confidence: 'verified', explanation: gymOption.label });
    expect(next.lockedIds).toEqual(['run']);
    const rainy = { condition: 'rain', isDay: true, phase: 'day', known: true } as const;
    const now = new Date(at('16:40'));
    expect(nudgesFor(day, now, { mode: 'walk', blocks: [{ ...run, active: true }], sky: rainy }).find((n) => n.kind === 'rain')?.action).toBe('options');
    expect(nudgesFor({ ...next, indoorIds: ['run'] }, now, { mode: 'walk', blocks: [{ ...run, active: true }], sky: rainy }).some((n) => n.kind === 'rain')).toBe(false);
  });
});

describe('the forecast on the phone', () => {
  const sky = (fetchedAt: string) => ({ condition: 'rain', isDay: true, phase: 'day', known: true, fetchedAt, details: { condition: 'rain', isDay: true, observedAt: fetchedAt, upcoming: [{ time: iso('17:00'), rainChance: 80 }] } }) as const;
  it('is used while fresh and ignored once stale', () => {
    expect(forecastFromSky(sky(iso('16:00')) as never, Date.parse(at('16:30')))).toEqual([{ time: iso('17:00'), precipitationProbability: 80 }]);
    expect(forecastFromSky(sky(iso('12:00')) as never, Date.parse(at('16:30')))).toBeUndefined();
  });
});
