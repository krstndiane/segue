import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@segue/engine';
import { clock } from '../src/lib/format';
import { activeNudges, nudgesFor } from '../src/lib/nudges';
import { BUSY_BLOCK_ID, adjustFor } from '../src/lib/replan';
import { emptyDay, type DayState, type StoredBlock } from '../src/lib/model';

const now = new Date('2026-10-19T14:00:00+08:00');
const endOfDay = '2026-10-19T22:00:00+08:00';
const iso = (hhmm: string) => `2026-10-19T${hhmm}:00+08:00`;

describe('one-tap reasons', () => {
  it('running late starts the plan later', () => {
    expect(adjustFor('late', now, 'medium', endOfDay).start.getTime() - now.getTime()).toBe(15 * 60_000);
  });

  it("I'm tired lowers the energy", () => {
    expect(adjustFor('tired', now, 'high', endOfDay).energy).toBe('low');
  });

  it("it's raining makes every hour wet until the day ends", () => {
    const { weather } = adjustFor('rain', now, 'medium', endOfDay);
    expect(weather).toHaveLength(8);
    expect(weather!.every((h) => h.precipitationProbability === 100)).toBe(true);
  });

  it('something came up keeps the next hour free', () => {
    const [busy] = adjustFor('busy', now, 'medium', endOfDay).extraBlocks;
    expect(busy).toMatchObject({ id: BUSY_BLOCK_ID, priority: 'must', fixed: { start: now.toISOString() } });
    expect(Date.parse(busy!.fixed!.end) - now.getTime()).toBe(60 * 60_000);
  });

  it('"running over until 3:30" keeps exactly that long, and never past the end of the day', () => {
    const [busy] = adjustFor('busy', now, 'medium', endOfDay, { until: new Date(iso('15:30')), title: 'Team meeting running over' }).extraBlocks;
    expect(busy).toMatchObject({ title: 'Team meeting running over', minMinutes: 90, fixed: { end: new Date(iso('15:30')).toISOString() } });
    const [late] = adjustFor('busy', now, 'medium', endOfDay, { until: new Date(iso('23:30')) }).extraBlocks;
    expect(late!.fixed!.end).toBe(new Date(endOfDay).toISOString());
    const [past] = adjustFor('busy', now, 'medium', endOfDay, { until: new Date(iso('13:00')) }).extraBlocks;
    expect(Date.parse(past!.fixed!.end) - now.getTime()).toBe(60 * 60_000);
  });

  it("I'm somewhere else asks for a fresh position, and no reason changes nothing", () => {
    expect(adjustFor('elsewhere', now, 'medium', endOfDay).refreshLocation).toBe(true);
    expect(adjustFor(null, now, 'medium', endOfDay)).toEqual({ start: now, energy: 'medium', extraBlocks: [], refreshLocation: false });
  });
});

const item = (id: string, start: string, end: string, extra: Partial<PlanItem> = {}): PlanItem => ({
  blockId: id,
  title: id,
  start: iso(start),
  end: iso(end),
  travelMinutesBefore: 0,
  confidence: 'no-place',
  fixed: false,
  fallbacks: [],
  ...extra,
});
const place = { id: 'p', name: 'Café Uno', location: { lat: 14.6, lng: 121 } };
const dayWith = (items: PlanItem[], extra: Partial<DayState> = {}): DayState => ({
  ...emptyDay('2026-10-19'),
  plan: { label: 'Best', items, unscheduled: [], score: 0, totalTravelMinutes: 0 },
  ...extra,
});
const run: StoredBlock = { id: 'run', title: 'Run', minMinutes: 30, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'], active: true };

describe('nudges', () => {
  it('says when to leave for the next stop, ten minutes ahead', () => {
    const day = dayWith([item('coffee', '14:30', '15:30', { place, travelMinutesBefore: 12 })]);
    const [leave] = nudgesFor(day, now, { mode: 'walk', blocks: [] });
    expect(leave).toMatchObject({ kind: 'leave', action: 'directions' });
    expect(leave!.body).toContain('Café Uno');
    expect(activeNudges([leave!], now)).toHaveLength(0); // leave at 14:18, heads-up from 14:08
    expect(activeNudges([leave!], new Date(iso('14:10')))).toHaveLength(1);
    expect(leave!.title).toBe(`Leave by ${clock(iso('14:18'))}`);
    const late = nudgesFor(day, new Date(iso('14:20')), { mode: 'walk', blocks: [] })[0]!;
    expect(late.title).toBe('Time to leave');
  });

  it('adds the top weather tip to the leave reminder', () => {
    const day = dayWith([item('coffee', '14:30', '15:30', { place, travelMinutesBefore: 12 })]);
    const [leave] = nudgesFor(day, now, { mode: 'walk', blocks: [], tip: 'Bring an umbrella' });
    expect(leave!.body).toMatch(/Café Uno.*\. Bring an umbrella\.$/);
  });

  it('asks about something that ran over, but not a fixed meeting', () => {
    const day = dayWith([item('work', '12:00', '13:50'), item('mtg', '12:00', '13:30', { fixed: true })]);
    const over = nudgesFor(day, now, { mode: 'walk', blocks: [] }).filter((n) => n.kind === 'over');
    expect(over.map((n) => n.item?.blockId)).toEqual(['work']);
    const done = nudgesFor({ ...day, doneIds: ['work'] }, now, { mode: 'walk', blocks: [] });
    expect(done.some((n) => n.kind === 'over')).toBe(false);
  });

  it('flags an outdoor plan when it is actually raining', () => {
    const day = dayWith([item('run', '16:00', '16:45', { place })]);
    const rainy = { condition: 'rain', isDay: true, phase: 'day', known: true } as const;
    expect(nudgesFor(day, now, { mode: 'walk', blocks: [run], sky: rainy }).some((n) => n.kind === 'rain')).toBe(true);
    expect(nudgesFor(day, now, { mode: 'walk', blocks: [run], sky: { ...rainy, preview: true } }).some((n) => n.kind === 'rain')).toBe(false);
    expect(nudgesFor(day, now, { mode: 'walk', blocks: [run], sky: { ...rainy, condition: 'clear' } }).some((n) => n.kind === 'rain')).toBe(false);
  });
});
