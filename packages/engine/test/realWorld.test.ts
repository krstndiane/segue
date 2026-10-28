/**
 * The re-route scenarios from the deployment-readiness audit, on real places
 * around Ayala Ave, Makati (OpenStreetMap via Nominatim, fetched 2026-10-29,
 * see makati-osm.json). Thursday 29 October 2026, Manila time.
 *
 * Each scenario checks feasibility (travel, listed hours, the next commitment,
 * windows) and honesty (unknowns said as unknowns), and logs a one-line summary.
 */
import { describe, expect, it } from 'vitest';
import { alternatives, formatClock, reroute, toMs, type Block, type Place, type Plan, type WeatherHour } from '../src';
import real from './makati-osm.json';

const TZ = 480;
const AYALA = { lat: 14.5547, lng: 121.0244 };
const P = real as unknown as Record<'gym' | 'mall' | 'park' | 'cafe' | 'library', Place[]>;
const at = (hm: string) => `2026-10-29T${hm}:00+08:00`;
const clock = (iso: string) => formatClock(toMs(iso), TZ);
const ctx = (now: string, extra: Record<string, unknown> = {}) => ({ now: at(now), endOfDay: at('22:00'), location: AYALA, energy: 'medium' as const, mode: 'local' as const, utcOffsetMinutes: TZ, ...extra });
const say = (label: string, lines: string[]) => console.log(`SCENARIO ${label}\n  ${lines.join('\n  ')}`);
const greenbelt = { lat: 14.55326, lng: 121.023183 };
const dinner: Block = { id: 'dinner', title: 'Dinner with Ana', minMinutes: 60, maxMinutes: 60, priority: 'must', category: 'none', requirements: [], fixed: { start: at('18:30'), end: at('19:30'), location: greenbelt, placeName: 'Greenbelt' } };
const noOverlap = (plan: Plan, o: { start: string; end: string; blockId: string }) => {
  for (const it of plan.items) if (it.blockId !== o.blockId) expect(toMs(o.start) >= toMs(it.end) || toMs(o.end) <= toMs(it.start)).toBe(true);
};
const rainUntil = (fromH: number, toH: number): WeatherHour[] =>
  Array.from({ length: 10 }, (_, i) => 14 + i).map((h) => ({ time: new Date(at(`${String(h).padStart(2, '0')}:00`)).toISOString(), precipitationProbability: h >= fromH && h < toH ? 90 : 10 }));

describe('real places around Ayala, Makati', () => {
  it('1. sudden rain before a 5:00 PM run, dinner at 6:30: indoor options that fit, with honest hours', () => {
    const run: Block = { id: 'run', title: 'Run', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'], earliest: at('17:00') };
    const plan = reroute({ blocks: [run, dinner], candidates: { run: P.park }, context: ctx('16:30') }).plan;
    expect(plan.items.find((i) => i.blockId === 'run')?.place).toBeDefined();
    const r = alternatives({ blocks: [run, dinner], plan, blockId: 'run', context: ctx('16:30', { weather: rainUntil(16, 19) }), places: { park: P.park, gym: P.gym, mall: P.mall }, trigger: 'rain' });
    say('1 rain', [`problem: ${r.problem?.text}`, ...r.options.map((o) => `${o.label} ${clock(o.start)}–${clock(o.end)} | ${o.why}`), ...r.notes.map((n) => `note: ${n.text}`)]);
    expect(r.problem?.text).toMatch(/90% chance of rain .* \(forecast\), and Run is outdoors/);
    expect(r.options.some((o) => o.kind === 'substitute' && o.category === 'gym')).toBe(true);
    for (const o of r.options) {
      noOverlap(plan, o);
      // Anything with a place before dinner leaves time to get to Greenbelt.
      if (toMs(o.start) < toMs(at('18:30'))) expect(o.next?.title).toBe('Dinner with Ana');
      // "Open" is only claimed from listed hours.
      if (o.why.startsWith('Open')) expect(o.hours?.basis).toBe('listed-hours');
      if (o.place && o.hours?.basis === 'none') expect(o.facts.some((f) => f.kind === 'unknown')).toBe(true);
    }
  });

  it('2. the planned gym is closed: other gyms that fit, and the ones that do not, with reasons', () => {
    const workout: Block = { id: 'gym', title: 'Workout', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'gym', requirements: [] };
    const plan = reroute({ blocks: [workout, dinner], candidates: { gym: P.gym }, context: ctx('17:00') }).plan;
    const planned = plan.items.find((i) => i.blockId === 'gym')!.place!;
    const r = alternatives({ blocks: [workout, dinner], plan, blockId: 'gym', context: ctx('17:00'), places: { gym: P.gym }, trigger: 'closed' });
    say('2 gym closed', [`planned: ${planned.name}`, `problem: ${r.problem?.text}`, ...r.options.map((o) => `${o.label} ${clock(o.start)}–${clock(o.end)} | ${o.why}`), ...r.excluded.map((e) => `excluded ${e.label}: ${e.reason}`)]);
    expect(r.problem?.text).toBe(`You said ${planned.name} isn't available`);
    expect(r.options.every((o) => o.place?.id !== planned.id)).toBe(true);
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) noOverlap(plan, o);

    // Ten minutes before a 45-minute window closes: nothing is squeezed in that can't fit before dinner.
    const late = alternatives({ blocks: [workout, dinner], plan, blockId: 'gym', context: ctx('17:55'), places: { gym: P.gym }, trigger: 'closed' });
    say('2b gym closed, little time', late.options.map((o) => `${o.label} ${clock(o.start)}–${clock(o.end)} (${o.minutes} min)`));
    for (const o of late.options) if (toMs(o.start) < toMs(at('18:30'))) expect(toMs(o.end)).toBeLessThanOrEqual(toMs(at('18:30')));
  });

  it('3. studying for two hours needs no café; asking for quiet finds the library and respects its lunch break', () => {
    const study: Block = { id: 'study', title: 'Study', minMinutes: 120, maxMinutes: 120, priority: 'should', category: 'none', requirements: [] };
    const anywhere = reroute({ blocks: [study], candidates: {}, context: ctx('11:30') }).plan.items[0]!;
    expect(anywhere.place).toBeUndefined();
    const quiet: Block = { ...study, category: 'library', requirements: ['quiet'] };
    const lib = reroute({ blocks: [quiet], candidates: { study: P.library }, context: ctx('11:30') }).plan.items[0]!;
    say('3 study', [`anywhere: ${clock(anywhere.start)}–${clock(anywhere.end)}, no place`, `quiet: ${lib.place?.name ?? 'no place'} ${clock(lib.start)}–${clock(lib.end)} (${lib.explanation ?? ''})`]);
    if (lib.place?.id === 'osm:node/255061938') {
      // Filipinas Heritage Library: 10–12 and 1–6 on Thursdays. Two hours can't fit before noon.
      expect(toMs(lib.start)).toBeGreaterThanOrEqual(toMs(at('13:00')));
      expect(toMs(lib.end)).toBeLessThanOrEqual(toMs(at('18:00')));
    }
  });

  it('4. a meeting runs late: commitments stay, only flexible work moves', () => {
    const meeting: Block = { id: 'meet', title: 'Client meeting', minMinutes: 60, maxMinutes: 60, priority: 'must', category: 'none', requirements: [], fixed: { start: at('15:00'), end: at('16:00') } };
    const report: Block = { id: 'report', title: 'Write report', minMinutes: 90, maxMinutes: 90, priority: 'must', category: 'none', requirements: [] };
    const before = reroute({ blocks: [meeting, report, dinner], candidates: {}, context: ctx('14:00') }).plan;
    // It's 4:30 and the meeting just ended: re-plan from now.
    const after = reroute({ blocks: [meeting, report, dinner], candidates: {}, context: ctx('16:30'), previous: before, doneBlockIds: ['meet'] });
    say('4 meeting ran late', after.plan.items.map((i) => `${clock(i.start)}–${clock(i.end)} ${i.title}${i.fixed ? ' (set time)' : ''}${i.conflict ? ` ⚠ ${i.conflict}` : ''}`));
    const d = after.plan.items.find((i) => i.blockId === 'dinner')!;
    expect([d.start, d.end]).toEqual([new Date(at('18:30')).toISOString(), new Date(at('19:30')).toISOString()]);
    const rep = after.plan.items.find((i) => i.blockId === 'report')!;
    expect(toMs(rep.start)).toBeGreaterThanOrEqual(toMs(at('16:30')));
    noOverlap(after.plan, rep);
  });

  it('5. not enough time: never squeezed in, and the reason is the real one', () => {
    const tight: Block = { id: 'report', title: 'Finish report', minMinutes: 120, maxMinutes: 120, priority: 'must', category: 'none', requirements: [], latest: at('19:00') };
    const r = reroute({ blocks: [tight, dinner], candidates: {}, context: ctx('17:30') });
    say('5 insufficient time', [...r.plan.items.map((i) => `${clock(i.start)}–${clock(i.end)} ${i.title}`), ...r.plan.unscheduled.map((u) => `not planned: ${u.title} — ${u.reason}`)]);
    expect(r.plan.items.some((i) => i.blockId === 'report')).toBe(false);
    expect(r.plan.unscheduled[0]!.reason).toBe('Needs 120 min, but only 90 min left before 7:00 PM');
  });

  it('6. no viable alternative: says so, invents nothing', () => {
    const workout: Block = { id: 'gym', title: 'Workout', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'gym', requirements: [] };
    const late = { ...ctx('21:40'), endOfDay: at('22:00') };
    const plan = reroute({ blocks: [workout], candidates: { gym: P.gym }, context: ctx('20:00') }).plan;
    const r = alternatives({ blocks: [workout], plan, blockId: 'gym', context: late, places: { gym: P.gym }, trigger: 'missed' });
    say('6 nothing fits', [`options: ${r.options.length}`, ...r.notes.map((n) => `note: ${n.text}`), ...r.excluded.slice(0, 3).map((e) => `excluded ${e.label}: ${e.reason}`)]);
    expect(r.options).toEqual([]);
    expect(r.notes.some((n) => n.kind === 'hard')).toBe(true);
  });

  it('7. missing data lowers confidence instead of inventing it', () => {
    const workout: Block = { id: 'gym', title: 'Workout', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'gym', requirements: [] };
    const unknownOnly = P.gym.filter((p) => !p.hours);
    const plan = reroute({ blocks: [workout], candidates: { gym: unknownOnly }, context: ctx('17:00') });
    const it0 = plan.plan.items[0]!;
    say('7 missing hours/forecast', [`${it0.title} at ${it0.place?.name}: confidence ${it0.confidence}; ${it0.explanation}`]);
    expect(it0.confidence).toBe('unconfirmed');
    expect(it0.explanation).toMatch(/Opening hours not confirmed/);
    const r = alternatives({ blocks: [workout], plan: plan.plan, blockId: 'gym', context: ctx('17:00'), places: { gym: unknownOnly }, trigger: 'manual' });
    expect(r.notes.map((n) => n.text)).toContain("No current forecast, so rain isn't factored in");
    for (const o of r.options) if (o.place) expect(o.hours?.status).toBe('unknown');
  });

  it('8. a rejected place is not offered again', () => {
    const workout: Block = { id: 'gym', title: 'Workout', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'gym', requirements: [] };
    const plan = reroute({ blocks: [workout], candidates: { gym: P.gym }, context: ctx('17:00') }).plan;
    const first = alternatives({ blocks: [workout], plan, blockId: 'gym', context: ctx('17:00'), places: { gym: P.gym } });
    const rejected = first.options.find((o) => o.place)!.place!.id;
    const second = alternatives({ blocks: [workout], plan, blockId: 'gym', context: ctx('17:00'), places: { gym: P.gym }, avoidPlaceIds: [rejected] });
    say('8 rejection', [`rejected ${rejected}`, ...second.options.map((o) => o.label)]);
    expect(second.options.some((o) => o.place?.id === rejected)).toBe(false);
  });

  it('9. maps and weather down: commitments kept, only what needs no place offered, and it says why', () => {
    const run: Block = { id: 'run', title: 'Run', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'], earliest: at('17:00') };
    const offline = reroute({ blocks: [run, dinner], candidates: {}, context: ctx('16:30') });
    const r = alternatives({ blocks: [run, dinner], plan: offline.plan, blockId: 'run', context: ctx('16:30'), places: {}, trigger: 'rain', rainingUntil: new Date(at('18:00')).toISOString() });
    say('9 offline', [...offline.plan.items.map((i) => `${clock(i.start)}–${clock(i.end)} ${i.title} ${i.explanation ?? ''}`), ...r.options.map((o) => `option: ${o.label}`), ...r.notes.map((n) => `note: ${n.text}`)]);
    expect(offline.plan.items.some((i) => i.blockId === 'dinner')).toBe(true);
    expect(r.options.every((o) => !o.place)).toBe(true);
    expect(r.options.length).toBeGreaterThan(0);
  });
});
