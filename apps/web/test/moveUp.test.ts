/**
 * Skipping never moves anything; "Move tasks up" only when asked: the same
 * things, in the same order, earlier where that's realistic.
 */
import { describe, expect, it } from 'vitest';
import type { Place, Plan, PlanItem } from '@segue/engine';
import { moveUp, planStampOf, type MoveUpContext } from '../src/lib/moveUp';

const at = (hm: string) => `2026-10-30T${hm}:00+08:00`;
const ms = (s: string) => Date.parse(s);
/** The same instant as `at`, as the planner writes it. */
const z = (hm: string) => new Date(at(hm)).toISOString();
const HOME = { lat: 14.5547, lng: 121.0244 };
const item = (id: string, s: string, e: string, extra: Partial<PlanItem> = {}): PlanItem => ({ blockId: id, title: id, start: at(s), end: at(e), travelMinutesBefore: 0, confidence: 'no-place', fixed: false, fallbacks: [], ...extra });
const plan = (items: PlanItem[]): Plan => ({ label: 'Balanced', items, unscheduled: [], score: 0, totalTravelMinutes: 0 });
const ctx = (now: string, extra: Partial<MoveUpContext> = {}): MoveUpContext => ({ now: ms(at(now)), location: HOME, mode: 'local', utcOffsetMinutes: 480, earliest: {}, places: [], pinned: [], ...extra });

/** The brief's day: Study 8–9, Review 9–10, Project 10–11. */
const day = plan([item('Study programming', '08:00', '09:00'), item('Review notes', '09:00', '10:00'), item('Work on a project', '10:00', '11:00')]);
const SKIPPED = ['Study programming'];

describe('Move tasks up (only when asked)', () => {
  it('skipping alone changes nothing: working out a proposal leaves the plan as it is', () => {
    const before = JSON.stringify(day);
    moveUp(day, SKIPPED, ctx('07:50'));
    expect(JSON.stringify(day)).toBe(before);
  });

  it('after skipping the 8 AM study, offers the rest earlier, in the same order', () => {
    const r = moveUp(day, SKIPPED, ctx('07:50'));
    expect(r.kind).toBe('moves');
    if (r.kind !== 'moves') return;
    expect(r.moves.map((m) => [m.title, m.from, m.to])).toEqual([
      ['Review notes', at('09:00'), z('07:50')],
      ['Work on a project', at('10:00'), z('08:50')],
    ]);
    // The skipped item keeps its record; nothing is shorter, nothing overlaps.
    expect(r.plan.items.find((i) => i.blockId === 'Study programming')).toEqual(day.items[0]);
    const rest = r.plan.items.filter((i) => i.blockId !== 'Study programming');
    for (const i of rest) expect(ms(i.end) - ms(i.start)).toBe(60 * 60_000);
    expect(ms(rest[1]!.start)).toBeGreaterThanOrEqual(ms(rest[0]!.end));
  });

  it('respects "not before" times', () => {
    const r = moveUp(day, SKIPPED, ctx('07:50', { earliest: { 'Review notes': at('08:00'), 'Work on a project': at('09:30') } }));
    expect(r.kind === 'moves' && r.moves.map((m) => [m.title, m.to])).toEqual([
      ['Review notes', z('08:00')],
      ['Work on a project', z('09:30')],
    ]);
  });

  it('never moves a set-time class, a calendar event, a pinned item or something underway', () => {
    const p = plan([
      item('Study programming', '08:00', '09:00'),
      item('Class', '09:00', '10:00', { fixed: true }),
      item('gcal_standup', '10:00', '10:30'),
      item('Pinned call', '11:00', '11:30'),
      item('Read', '12:00', '13:00'),
    ]);
    const r = moveUp(p, SKIPPED, ctx('07:50', { pinned: ['Pinned call'] }));
    const after = r.kind === 'moves' ? r.plan.items : p.items;
    for (const id of ['Class', 'gcal_standup', 'Pinned call']) expect(after.find((i) => i.blockId === id)).toEqual(p.items.find((i) => i.blockId === id));
    // Read can come up to right after the pinned call, not before it.
    expect(r.kind === 'moves' && r.moves.map((m) => [m.title, m.to])).toEqual([['Read', z('11:30')]]);
    const underway = moveUp(day, SKIPPED, ctx('09:10'));
    expect(underway.kind === 'moves' ? underway.moves.map((m) => m.title) : []).not.toContain('Review notes');
  });

  it('counts the trip from where you are, and leaves room to reach a set-time class', () => {
    const far = { lat: 14.6507, lng: 121.0494 }; // UP Diliman from Makati: a real trip
    const p = plan([item('Study programming', '08:00', '09:00'), item('Library', '09:00', '10:00', { place: { id: 'lib', name: 'UP Library', location: far }, travelMinutesBefore: 40 }), item('Class', '10:30', '12:00', { fixed: true, place: { id: 'up', name: 'UP Diliman', location: far } })]);
    const r = moveUp(p, SKIPPED, ctx('06:30'));
    expect(r.kind).toBe('moves');
    if (r.kind !== 'moves') return;
    const lib = r.plan.items.find((i) => i.blockId === 'Library')!;
    expect(lib.travelMinutesBefore).toBeGreaterThan(10);
    expect(ms(lib.start)).toBeGreaterThanOrEqual(ms(at('06:30')) + lib.travelMinutesBefore * 60_000);
    expect(r.plan.items.find((i) => i.blockId === 'Class')).toEqual(p.items[2]);
  });

  it('only as early as a place is open, by its listed hours', () => {
    const gym: Place = { id: 'gym', name: 'Gym', location: HOME, category: 'gym', attributes: {}, hours: { periods: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day: d, open: '08:30', close: '22:00' })) }, source: 'osm' };
    const p = plan([item('Study programming', '08:00', '09:00'), item('Workout', '09:00', '10:00', { place: { id: 'gym', name: 'Gym', location: HOME } })]);
    const r = moveUp(p, SKIPPED, ctx('07:50', { places: [gym] }));
    expect(r.kind === 'moves' && r.moves.map((m) => [m.title, m.to])).toEqual([['Workout', z('08:30')]]);
  });

  it('says so, and keeps the schedule, when nothing can start earlier', () => {
    const tight = plan([item('Study programming', '08:00', '09:00'), item('Class', '09:00', '10:00', { fixed: true })]);
    expect(moveUp(tight, SKIPPED, ctx('07:50'))).toMatchObject({ kind: 'nothing', reason: expect.stringMatching(/schedule stays as it is/) });
  });

  it('a proposal goes stale when the plan or what is finished changes', () => {
    const a = planStampOf(day, SKIPPED);
    expect(planStampOf(day, SKIPPED)).toBe(a);
    expect(planStampOf(day, [...SKIPPED, 'Review notes'])).not.toBe(a);
    expect(planStampOf(plan([...day.items.slice(0, 2), item('Work on a project', '10:30', '11:30')]), SKIPPED)).not.toBe(a);
    const r = moveUp(day, SKIPPED, ctx('07:50'));
    expect(r.kind === 'moves' && r.stamp).toBe(a);
  });
});
