/**
 * Alternatives for one item: only options the user can actually act on,
 * checked against the rest of the day, with the reasons spelled out.
 */
import { describe, expect, it } from 'vitest';
import { alternatives, formatClock, reroute, toMs, type AlternativesInput, type Block, type Place, type Plan, type WeatherHour } from '../src';
import { TZ, at, context, everyDay, near } from './fixtures';

const clock = (iso: string) => formatClock(toMs(iso), TZ);
const gym = (id: string, metersNorth: number, hours: Place['hours'], extra: Partial<Place> = {}): Place => ({
  id,
  name: id,
  location: near(metersNorth, 0),
  category: 'gym',
  attributes: { indoor: true },
  hours,
  source: 'osm',
  ...extra,
});
const mall = (id: string, metersNorth: number): Place => ({ id, name: id, location: near(metersNorth, 0), category: 'mall', attributes: { indoor: true }, hours: everyDay('10:00', '21:00'), source: 'osm' });
const run: Block = { id: 'run', title: 'Run', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'] };
const workout: Block = { id: 'gym', title: 'Gym', minMinutes: 60, maxMinutes: 60, priority: 'should', category: 'gym', requirements: [] };
const dinner: Block = { id: 'dinner', title: 'Dinner with Ana', minMinutes: 60, maxMinutes: 60, priority: 'must', category: 'none', requirements: [], fixed: { start: at('18:30'), end: at('19:30'), location: near(800, 0) } };
const park: Place = { id: 'park', name: 'Riverside Park', location: near(-300, 0), category: 'park', attributes: { outdoor: true }, hours: { always: true, periods: [] }, source: 'osm' };

/** Plan the day first, as the app does, then ask for alternatives. */
function setup(blocks: Block[], places: AlternativesInput['places'], ctx = context({ now: at('16:30') }), extra: Partial<AlternativesInput> = {}) {
  const candidates = Object.fromEntries(blocks.map((b) => [b.id, places[b.category] ?? []]));
  // The plan was made before anything changed: no forecast of the rain yet.
  const plan: Plan = reroute({ blocks, candidates, context: { ...ctx, weather: undefined } }).plan;
  return { plan, run: (blockId: string, more: Partial<AlternativesInput> = {}) => alternatives({ blocks, plan, blockId, context: ctx, places, ...extra, ...more }) };
}
const overlapsNothing = (r: ReturnType<typeof alternatives>, plan: Plan) => {
  for (const o of r.options) {
    for (const it of plan.items) {
      if (it.blockId === o.blockId) continue;
      expect(toMs(o.start) >= toMs(it.end) || toMs(o.end) <= toMs(it.start)).toBe(true);
    }
  }
};

describe('a gym that is open and fits', () => {
  it('is offered with its hours, the trip, and the room left before dinner', () => {
    const day = setup([workout, dinner], { gym: [gym('Core Studio', 600, everyDay('06:00', '22:00'))] });
    const r = day.run('gym', { trigger: 'manual' });
    const o = r.options.find((x) => x.place?.id === 'Core Studio')!;
    expect(o.kind).toBe('same-kind');
    expect(o.hours).toMatchObject({ status: 'open', basis: 'listed-hours' });
    expect(o.facts.map((f) => f.text)).toContain(`Open from ${clock(o.start)} until 10:00 PM by its listed hours`);
    expect(o.next).toMatchObject({ title: 'Dinner with Ana', start: new Date(at('18:30')).toISOString() });
    expect(o.next!.spareMinutes).toBeGreaterThanOrEqual(0);
    expect(o.facts.some((f) => f.text.startsWith('Leaves') && f.text.includes('Dinner with Ana at 6:30 PM'))).toBe(true);
    overlapsNothing(r, day.plan);
  });
});

describe('gyms that are closed, close too soon, or are too far', () => {
  it('leaves them out and says exactly why', () => {
    const places = {
      gym: [
        gym('Shut', 300, everyDay('06:00', '15:00')),
        gym('Early Close', 400, everyDay('06:00', '17:00')),
        gym('Far Away', 9000, everyDay('06:00', '23:00')),
        gym('Paused', 500, everyDay('06:00', '23:00'), { temporarilyClosed: true }),
      ],
    };
    const r = setup([workout, dinner], places, context({ now: at('16:30'), mode: 'walk' })).run('gym');
    const why = Object.fromEntries(r.excluded.map((e) => [e.label, e.reason]));
    expect(why['Shut']).toBe('Closed for the rest of today by its listed hours');
    expect(why['Early Close']).toBe('Closes at 5:00 PM, too soon for 1 h after you\'d arrive');
    expect(why['Paused']).toBe('Listed as temporarily closed');
    expect(why['Far Away']).toMatch(/^About \d+ min away: too far|Wouldn't leave time for Dinner with Ana/);
    expect(r.options.every((o) => !['Shut', 'Early Close', 'Paused', 'Far Away'].includes(o.place?.id ?? ''))).toBe(true);
    // The home version still fits.
    expect(r.options.map((o) => o.kind)).toContain('no-place');
  });
});

describe('a place with no listed hours', () => {
  it('can be offered, but never claimed open', () => {
    const r = setup([workout], { gym: [gym('Mystery Gym', 400, null)] }).run('gym');
    const o = r.options.find((x) => x.place?.id === 'Mystery Gym')!;
    expect(o.hours).toMatchObject({ status: 'unknown', basis: 'none' });
    expect(o.facts).toContainEqual({ kind: 'unknown', text: "Opening hours aren't listed, so check before you go" });
    expect(o.why).not.toMatch(/^Open/);
  });
});

describe('studying', () => {
  it('can happen right where you are, with no café required', () => {
    const study: Block = { id: 'study', title: 'Study', minMinutes: 120, maxMinutes: 120, priority: 'should', category: 'none', requirements: [] };
    const r = setup([study], {}).run('study');
    expect(r.options).toHaveLength(1);
    expect(r.options[0]).toMatchObject({ kind: 'same-kind', category: 'none', travelMinutes: 0 });
    expect(r.options[0]!.place).toBeUndefined();
  });

  it('a café that is too far for the time left is excluded; a closer library is offered instead', () => {
    const cafeBlock: Block = { id: 'study', title: 'Study', minMinutes: 90, maxMinutes: 90, priority: 'should', category: 'cafe', requirements: ['wifi'], latest: at('19:00') };
    const places = {
      cafe: [{ id: 'far-cafe', name: 'Far Café', location: near(12000, 0), category: 'cafe' as const, attributes: { wifi: true }, hours: everyDay('07:00', '23:00'), source: 'osm' }],
      library: [{ id: 'lib', name: 'City Library', location: near(400, 0), category: 'library' as const, attributes: { wifi: true }, hours: everyDay('08:00', '20:00'), source: 'osm' }],
    };
    const r = setup([cafeBlock], places, context({ now: at('16:30'), mode: 'walk' })).run('study', { trigger: 'closed' });
    expect(r.excluded.find((e) => e.label === 'Far Café')?.reason).toMatch(/too far to fit 1 h 30 min before 7:00 PM/);
    const lib = r.options.find((o) => o.place?.id === 'lib')!;
    expect(lib.kind).toBe('substitute');
    expect(lib.label).toBe('Study at City Library instead');
    expect(lib.facts).toContainEqual({ kind: 'hard', text: 'Finishes by 7:00 PM, as you wanted' });
  });
});

describe('sudden rain before an outdoor run', () => {
  const rain = (fromHm: string, toHm: string, pct: number, after: number): WeatherHour[] => {
    const out: WeatherHour[] = [];
    for (let h = 16; h <= 22; h++) {
      const hm = `${String(h).padStart(2, '0')}:00`;
      out.push({ time: new Date(at(hm)).toISOString(), precipitationProbability: hm >= fromHm && hm < toHm ? pct : after });
    }
    return out;
  };

  it('offers a gym, a mall walk, a home workout, and the run once it should be drier, around dinner', () => {
    const ctx = context({ now: at('16:30'), weather: rain('16:00', '18:00', 90, 10), mode: 'drive' });
    const places = { park: [park], gym: [gym('Core Studio', 700, everyDay('06:00', '22:00'))], mall: [mall('Town Center', 900)] };
    const day = setup([run, dinner], places, ctx);
    const r = day.run('run', { trigger: 'rain' });
    expect(r.problem?.text).toMatch(/% chance of rain around .* \(forecast\), and Run is outdoors/);
    const kinds = r.options.map((o) => o.kind);
    expect(kinds).toContain('substitute');
    expect(kinds).toContain('no-place');
    expect(r.options.some((o) => o.label === 'Work out at Core Studio instead')).toBe(true);
    const indoors = r.options.find((o) => o.kind === 'substitute')!;
    expect(indoors.facts).toContainEqual({ kind: 'preference', text: "Indoors, so the rain doesn't matter" });
    const later = r.options.find((o) => o.kind === 'later');
    if (later) {
      expect(toMs(later.start)).toBeGreaterThanOrEqual(toMs(at('18:00')));
      expect(later.rainChance).toBeLessThan(50);
    }
    // Nothing is offered that would run into dinner.
    overlapsNothing(r, day.plan);
  });

  it('offers an indoor workout at home, not a walk outside', () => {
    const ctx = context({ now: at('16:30'), weather: rain('16:00', '19:00', 90, 10) });
    const r = setup([run], { park: [park] }, ctx).run('run', { trigger: 'rain' });
    const home = r.options.find((o) => o.kind === 'no-place')!;
    expect(home.label).toBe('Indoor workout where you are');
    expect(home.facts).toContainEqual({ kind: 'preference', text: "Indoors, so the rain doesn't matter" });
  });

  it('does not call it a problem when the forecast says rain is unlikely then', () => {
    const ctx = context({ now: at('16:30'), weather: rain('16:00', '16:00', 90, 10) });
    const r = setup([run], { park: [park] }, ctx).run('run', { trigger: 'rain' });
    expect(r.problem?.kind).toBe('tip');
    expect(r.problem?.text).toMatch(/when rain looks unlikely \(10%, forecast\)/);
  });

  it('takes the user at their word when they say it is raining, and makes no promise without a forecast', () => {
    const ctx = context({ now: at('16:30') });
    const r = setup([run], { park: [park], gym: [gym('Core Studio', 700, everyDay('06:00', '22:00'))] }, ctx).run('run', {
      trigger: 'rain',
      rainingUntil: new Date(at('18:30')).toISOString(),
    });
    expect(r.problem).toEqual({ kind: 'preference', text: "You said it's raining, and Run is outdoors" });
    expect(r.options.some((o) => o.kind === 'later')).toBe(false);
    expect(r.notes).toContainEqual({ kind: 'unknown', text: "No current forecast, so Segue can't say when the rain will stop" });
  });

  it('never suggests outdoor exercise in dangerous weather', () => {
    const ctx = context({ now: at('16:30'), weather: rain('16:00', '23:00', 95, 95) });
    const r = setup([run], { park: [park], gym: [gym('Core Studio', 700, everyDay('06:00', '22:00'))] }, ctx).run('run', {
      trigger: 'rain',
      hazardUntil: new Date(at('20:00')).toISOString(),
    });
    expect(r.problem?.text).toMatch(/Dangerous weather is expected until about 8:00 PM/);
    for (const o of r.options) expect(o.category === 'park' && toMs(o.start) < toMs(at('20:00'))).toBe(false);
  });
});

describe('not enough time before the next commitment', () => {
  it('offers a shorter version that fits, and says what is given up', () => {
    const ctx = context({ now: at('17:40') });
    const r = setup([workout, dinner], { gym: [gym('Core Studio', 300, everyDay('06:00', '22:00'))] }, ctx).run('gym');
    const short = r.options.find((o) => o.kind === 'shorter');
    expect(short).toBeDefined();
    expect(toMs(short!.end)).toBeLessThanOrEqual(toMs(at('18:30')));
    expect(short!.tradeoffs[0]).toMatch(/min instead of 1 h$/);
  });

  it('says plainly when nothing fits at all', () => {
    const tight: Block = { id: 'report', title: 'Report', minMinutes: 120, maxMinutes: 120, priority: 'must', category: 'none', requirements: [], latest: at('17:00') };
    const r = setup([tight], {}, context({ now: at('16:30') })).run('report');
    expect(r.options).toEqual([]);
    expect(r.notes.at(-1)).toEqual({ kind: 'hard', text: "There's no free stretch of 2 h left today around your other plans" });
  });
});

describe('commitments', () => {
  it('are never replaced or moved', () => {
    const r = setup([dinner], {}).run('dinner');
    expect(r.options).toEqual([]);
    expect(r.problem?.text).toBe('Dinner with Ana is a set-time commitment, so Segue won\'t move or replace it');
  });
});

describe('the user stays in charge', () => {
  it('does not offer a place they turned down again', () => {
    const places = { gym: [gym('Core Studio', 300, everyDay('06:00', '22:00')), gym('Pulse', 500, everyDay('06:00', '22:00'))] };
    const r = setup([workout], places).run('gym', { avoidPlaceIds: ['Core Studio'] });
    expect(r.options.some((o) => o.place?.id === 'Core Studio')).toBe(false);
    expect(r.excluded).toContainEqual({ label: 'Core Studio', placeId: 'Core Studio', reason: 'You turned it down earlier' });
  });

  it('respects "I only have 30 minutes"', () => {
    const r = setup([workout], { gym: [gym('Core Studio', 300, everyDay('06:00', '22:00'))] }).run('gym', { maxMinutes: 30 });
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) expect(o.minutes).toBeLessThanOrEqual(30);
  });

  it('is deterministic', () => {
    const day = setup([workout, dinner], { gym: [gym('Core Studio', 300, everyDay('06:00', '22:00'))] });
    expect(day.run('gym')).toEqual(day.run('gym'));
  });
});
