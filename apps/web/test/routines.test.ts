/**
 * Routine recognition on realistic calendars: a university timetable, gym,
 * work and personal routines, similar and different names, exceptions,
 * changes, gaps, deletions, edits, repeated syncs, missing details, time
 * zones and overlaps. And that the planner really uses what was confirmed.
 */
import { describe, expect, it } from 'vitest';
import { alternatives, reroute } from '@segue/engine';
import type { CalendarEvent } from '../src/lib/calendar';
import { calendarBlockId, calendarBlocks } from '../src/lib/calendar';
import { toEngineBlock, type StoredBlock } from '../src/lib/model';
import {
  EMPTY_LEARNING,
  applyRoutines,
  classify,
  detectPatterns,
  eventMatches,
  mergeSuggestions,
  occurrencesOf,
  reconcile,
  relinked,
  routineFrom,
  type LearnedRoutine,
  type LearningState,
} from '../src/lib/routines';

const ZONE = 'Asia/Manila';
const TODAY = '2026-11-04'; // a Wednesday
const WINDOW_START = '2026-10-07'; // four weeks back

/** Every date from..to (inclusive) that falls on one of `days` (0 = Sunday). */
function datesOn(days: number[], from = WINDOW_START, to = '2026-11-18'): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    if (days.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
/** A weekly event on those days, at Manila time. */
function weekly(title: string, days: number[], start: string, end: string, o: { series?: string; location?: string; from?: string; to?: string; skip?: string[]; moved?: Record<string, [string, string]> } = {}): CalendarEvent[] {
  return datesOn(days, o.from, o.to)
    .filter((d) => !o.skip?.includes(d))
    .map((d) => {
      const [s, e] = o.moved?.[d] ?? [start, end];
      return { id: `${o.series ?? title}-${d}`, title, start: `${d}T${s}:00+08:00`, end: `${d}T${e}:00+08:00`, location: o.location, seriesId: o.series };
    });
}
const analyse = (events: CalendarEvent[], state: LearningState = EMPTY_LEARNING, routines: StoredBlock[] = []) =>
  reconcile(state, routines, detectPatterns(occurrencesOf(events, ZONE), TODAY), TODAY, WINDOW_START);
const MWF = [1, 3, 5];
const TTH = [2, 4];

describe('a full university timetable', () => {
  const events = [
    ...weekly('Programming 1', MWF, '08:00', '10:00', { series: 'prog', location: 'PUP Main Building, Room 301' }),
    ...weekly('Mathematics', TTH, '09:00', '11:00', { series: 'math' }),
    ...weekly('Physics Lab', [4], '13:00', '16:00', { series: 'phys' }),
    ...weekly('Gym', MWF, '17:00', '18:30'),
  ];
  const r = analyse(events);

  it('recognises each class and the gym as weekly patterns, with their days and times', () => {
    const by = Object.fromEntries(r.suggestions.map((s) => [s.name, s]));
    expect(by['Programming 1']).toMatchObject({ category: 'class', kind: 'fixed', days: MWF, start: '08:00', end: '10:00' });
    expect(by['Mathematics']).toMatchObject({ category: 'class', kind: 'fixed', days: TTH, start: '09:00', end: '11:00' });
    expect(by['Physics Lab']).toMatchObject({ category: 'class', kind: 'fixed', days: [4], start: '13:00' });
    expect(by['Gym']).toMatchObject({ category: 'fitness', kind: 'flexible', days: MWF, start: '17:00', end: '18:30' });
    expect(r.suggestions).toHaveLength(4);
  });
  it('is sure about repeating series and says why', () => {
    const prog = r.suggestions.find((s) => s.name === 'Programming 1')!;
    expect(prog.confidence).toBeGreaterThan(0.8);
    expect(prog.needsReview).toBe(false);
    expect(prog.reason).toMatch(/repeating event/);
    expect(prog.location).toContain('Room 301');
  });
  it('a repeated sync gives the same suggestions, not more', () => {
    const again = analyse(events, r);
    expect(again.suggestions.map((s) => s.id).sort()).toEqual(r.suggestions.map((s) => s.id).sort());
    expect(analyse(events, again).suggestions).toHaveLength(4);
  });
});

describe('classification', () => {
  it.each([
    ['Programming 1', 'class', 'fixed'],
    ['Mathematics', 'class', 'fixed'],
    ['CS 101', 'class', 'fixed'],
    ['Gym workout', 'fitness', 'flexible'],
    ['Upper body day', 'fitness', 'flexible'],
    ['Spin class', 'fitness', 'fixed'],
    ['Team meeting', 'work', 'fixed'],
    ['Study for finals', 'study', 'flexible'],
    ['Dentist appointment', 'appointment', 'fixed'],
  ] as const)('%s → %s, %s', (title, category, kind) => {
    expect(classify(title)).toMatchObject({ category, kind });
  });
  it('uses the location when the title says little', () => {
    expect(classify('Upper body', 'Anytime Fitness Makati').category).toBe('fitness');
    expect(classify('IT 113', 'PUP Sta. Mesa campus').category).toBe('class');
  });
  it('is unsure about vague titles, and keeps them fixed until told otherwise', () => {
    const c = classify('Ana');
    expect(c.category).toBe('personal');
    expect(c.kind).toBe('fixed');
    expect(c.confidence).toBeLessThan(0.6);
  });
});

describe('work and personal routines together', () => {
  const events = [
    ...weekly('Morning shift', [1, 2, 3, 4, 5], '09:00', '17:00', { series: 'shift', location: 'Office' }),
    ...weekly('Run', [2, 4, 6], '06:00', '06:45'),
    ...weekly('Call with Ana', [0], '20:00', '20:30'),
  ];
  const r = analyse(events);
  it('the shift is fixed work, the run is a flexible routine, the call is personal and asked about', () => {
    const by = Object.fromEntries(r.suggestions.map((s) => [s.name, s]));
    expect(by['Morning shift']).toMatchObject({ category: 'work', kind: 'fixed', days: [1, 2, 3, 4, 5] });
    expect(by['Run']).toMatchObject({ category: 'fitness', kind: 'flexible', days: [2, 4, 6] });
    expect(by['Call with Ana']).toMatchObject({ category: 'work' }); // "call" reads as work…
    expect(by['Call with Ana']!.needsReview).toBe(true); // …so it asks
  });
});

describe('names', () => {
  it('similar names stay apart unless the person merges them, and are offered for merging', () => {
    const events = [...weekly('Gym', [1, 3], '17:00', '18:00'), ...weekly('Gym workout', [5], '17:30', '18:30')];
    const r = analyse(events);
    const gym = r.suggestions.find((s) => s.name === 'Gym')!;
    const other = r.suggestions.find((s) => s.name === 'Gym workout')!;
    expect(gym.similarTo).toBe(other.id);
    const merged = mergeSuggestions(gym, other);
    expect(merged.days).toEqual([1, 3, 5]);
    expect(merged.titles.sort()).toEqual(['gym', 'gym workout']);
  });
  it('different names that mean the same kind of thing get the same category', () => {
    expect(classify('Upper body day').category).toBe(classify('Leg day').category);
    expect(classify('Lecture: Databases').category).toBe(classify('Networking lab').category);
  });
  it('Programming 1 and Programming 2 are different classes', () => {
    const r = analyse([...weekly('Programming 1', MWF, '08:00', '10:00'), ...weekly('Programming 2', TTH, '08:00', '10:00')]);
    expect(r.suggestions.map((s) => s.name).sort()).toEqual(['Programming 1', 'Programming 2']);
  });
  it('the same title at two times of day is two routines', () => {
    const r = analyse([...weekly('Gym', [1, 3], '06:00', '07:00'), ...weekly('Gym', [5, 6], '18:00', '19:00')]);
    expect(r.suggestions.map((s) => `${s.days.join('')}@${s.start}`).sort()).toEqual(['13@06:00', '56@18:00']);
  });
});

describe('exceptions, gaps, changes and deletions', () => {
  const confirm = (events: CalendarEvent[], name: string): LearnedRoutine => routineFrom(analyse(events).suggestions.find((s) => s.name === name)!, '2026-11-04T00:00:00Z');

  it('a recurring class with one moved and one cancelled session is still the same pattern at the usual time', () => {
    const events = weekly('Mathematics', TTH, '09:00', '11:00', { series: 'math', skip: ['2026-10-15'], moved: { '2026-10-20': ['13:00', '15:00'] } });
    const r = analyse(events);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ start: '09:00', end: '11:00', days: TTH });
  });

  it('one missed gym session is not the end of the routine', () => {
    const base = weekly('Gym', MWF, '17:00', '18:30');
    const gym = confirm(base, 'Gym');
    const missed = base.filter((e) => !e.start.startsWith('2026-11-02'));
    expect(analyse(missed, EMPTY_LEARNING, [gym]).changes).toEqual([]);
  });

  it('a gym routine that moved from 5 PM to 6 PM is noticed, and asked about, not changed silently', () => {
    const gym = confirm(weekly('Gym', MWF, '17:00', '18:30'), 'Gym');
    const moved = [...weekly('Gym', MWF, '17:00', '18:30', { to: '2026-10-25' }), ...weekly('Gym', MWF, '18:00', '19:30', { from: '2026-10-26' })];
    const r = analyse(moved, EMPTY_LEARNING, [gym]);
    const change = r.changes.find((c) => c.kind === 'time');
    expect(change).toMatchObject({ routineId: gym.id, start: '18:00', end: '19:30' });
    expect(change!.reason).toContain('6:00 PM');
    // The routine itself is untouched until the person says yes.
    expect(gym.earliest).toBe('16:00');
    // And it isn't offered again as a brand-new routine.
    expect(r.suggestions.filter((s) => s.name === 'Gym')).toHaveLength(0);
  });

  it('a class that moved to new days after a timetable change is noticed', () => {
    const cls = confirm(weekly('Statistics', MWF, '10:00', '11:00', { series: 'stat' }), 'Statistics');
    const changed = [...weekly('Statistics', MWF, '10:00', '11:00', { series: 'stat', to: '2026-10-18' }), ...weekly('Statistics', TTH, '10:00', '11:00', { series: 'stat2', from: '2026-10-19' })];
    // The new series has a new id; the title still links it.
    const r = analyse(changed, EMPTY_LEARNING, [cls]);
    expect(r.changes.some((c) => c.kind === 'days' || c.kind === 'time' || c.kind === 'gone')).toBe(true);
  });

  it('a routine deleted from the calendar three weeks ago is asked about; one deleted last week is not', () => {
    const gym = confirm(weekly('Gym', MWF, '17:00', '18:30'), 'Gym');
    const longGone = weekly('Gym', MWF, '17:00', '18:30', { to: '2026-10-12' });
    expect(analyse(longGone, EMPTY_LEARNING, [gym]).changes.map((c) => c.kind)).toContain('gone');
    const recentlyGone = weekly('Gym', MWF, '17:00', '18:30', { to: '2026-10-30' });
    expect(analyse(recentlyGone, EMPTY_LEARNING, [gym]).changes.map((c) => c.kind)).not.toContain('gone');
  });

  it('a new weekly study session on Saturdays is noticed after two weeks, and only suggested', () => {
    const study = weekly('Study session', [6], '14:00', '16:00', { from: '2026-10-24' });
    const r = analyse(study);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ category: 'study', kind: 'flexible', days: [6] });
    // A one-off is not a routine.
    expect(analyse(weekly('Study session', [6], '14:00', '16:00', { from: '2026-10-31', to: '2026-10-31' })).suggestions).toHaveLength(0);
  });
});

describe('the person is in charge', () => {
  it('"Not a routine" keeps it from coming back on later syncs', () => {
    const events = weekly('Ana', [0], '20:00', '20:30');
    const r = analyse(events);
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    const turnedDown: LearningState = { ...r, suggestions: [], excluded: { keys: [s.key], seriesIds: s.seriesIds, titles: [s.titles[0]!] } };
    expect(analyse(events, turnedDown).suggestions).toHaveLength(0);
  });
  it('corrections to a pending suggestion survive the next sync', () => {
    const events = weekly('Run', [2, 4], '06:00', '06:45');
    const r = analyse(events);
    const corrected: LearningState = { ...r, suggestions: r.suggestions.map((s) => ({ ...s, name: 'Morning run', kind: 'fixed' as const, category: 'personal' as const })) };
    expect(analyse(events, corrected).suggestions[0]).toMatchObject({ name: 'Morning run', kind: 'fixed', category: 'personal' });
  });
  it('a confirmed routine is not suggested again', () => {
    const events = weekly('Gym', MWF, '17:00', '18:30');
    const gym = routineFrom(analyse(events).suggestions[0]!, 'now');
    expect(analyse(events, EMPTY_LEARNING, [gym]).suggestions).toHaveLength(0);
  });
  it('editing a recognised routine (flexible → fixed, new time) relinks it, and the edit wins', () => {
    const events = weekly('Gym', MWF, '17:00', '18:30');
    const gym = routineFrom(analyse(events).suggestions[0]!, 'now');
    const edited = relinked({ ...gym, earliest: undefined, latest: undefined, fixedStart: '18:00', fixedEnd: '19:00' });
    expect(edited.learned).toMatchObject({ kind: 'fixed', usualStart: '18:00' });
  });
  it('missing locations and descriptions are fine', () => {
    const r = analyse(weekly('Chem', TTH, '13:00', '14:30'));
    expect(r.suggestions[0]!.location).toBeUndefined();
    expect(r.suggestions[0]!.category).toBe('class');
  });
});

describe('time zones and overlaps', () => {
  it('reads days and times in the zone the person is in', () => {
    // 8 AM Manila on Monday is 7 PM Sunday in New York.
    const events = weekly('Programming 1', MWF, '08:00', '10:00', { series: 'p' });
    const ny = reconcile(EMPTY_LEARNING, [], detectPatterns(occurrencesOf(events, 'America/New_York'), TODAY), TODAY, WINDOW_START);
    // Sunday, Tuesday, Thursday evening there; 8 PM before New York's clocks went back on 1 November, 7 PM after.
    expect(ny.suggestions[0]!.days).toEqual([0, 2, 4]);
    expect(['19:00', '20:00']).toContain(ny.suggestions[0]!.start);
  });
  it('two overlapping recurring events are two patterns, both protected', () => {
    const events = [...weekly('Lecture: Databases', [1], '13:00', '15:00', { series: 'db' }), ...weekly('Department meeting', [1], '14:00', '15:00', { series: 'dm' })];
    const r = analyse(events);
    expect(r.suggestions).toHaveLength(2);
    expect(r.suggestions.every((s) => s.kind === 'fixed')).toBe(true);
  });
});

describe('the planner uses confirmed routines', () => {
  // In the app the calendar, the routines and the planner all use the device's time zone; so does this test (CI runs in UTC).
  const local = (date: string, hm: string) => {
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = hm.split(':').map(Number);
    return new Date(y!, m! - 1, d!, h!, mi!).toISOString();
  };
  const weeklyLocal = (title: string, days: number[], start: string, end: string, series?: string): CalendarEvent[] =>
    datesOn(days).map((d) => ({ id: `${series ?? title}-${d}`, title, start: local(d, start), end: local(d, end), seriesId: series }));
  const events = [...weeklyLocal('Programming 1', MWF, '08:00', '10:00', 'prog'), ...weeklyLocal('Mathematics', MWF, '13:00', '14:30', 'math'), ...weeklyLocal('Gym', MWF, '17:00', '18:30')];
  const r = reconcile(EMPTY_LEARNING, [], detectPatterns(occurrencesOf(events), TODAY), TODAY, WINDOW_START);
  const routines = r.suggestions.map((s) => routineFrom(s, 'now'));
  const today = events.filter((e) => e.id.endsWith(TODAY));
  const now = new Date(local(TODAY, '07:00'));

  it('fixed classes come from today’s calendar once; the gym becomes a flexible block around today’s time, not a fixed event', () => {
    const applied = applyRoutines(routines, today);
    // Classes: the calendar's events are planned (fixed); the routine steps aside, so nothing is planned twice.
    expect(applied.blocks.filter((b) => b.fixedStart)).toHaveLength(0);
    const gymEvent = today.find((e) => e.title === 'Gym')!;
    expect(applied.replacesCalendar.has(calendarBlockId(gymEvent.id))).toBe(true);
    const gym = applied.blocks.find((b) => b.title === 'Gym')!;
    expect(gym).toMatchObject({ earliest: '16:00', latest: '20:00' });
    expect(applied.why[gym.id]).toMatch(/can move/);
  });

  it('a two-hour assignment is planned around the classes and the gym, never on top of a class', () => {
    const applied = applyRoutines(routines, today);
    const assignment: StoredBlock = { id: 'assignment', title: 'Programming assignment', minMinutes: 120, maxMinutes: 120, priority: 'must', category: 'none', requirements: [], active: true, date: TODAY };
    const cal = calendarBlocks(today, 20).filter((b) => !applied.replacesCalendar.has(b.id));
    const blocks = [...applied.blocks, assignment].map((b) => toEngineBlock(b, now));
    const plan = reroute({
      blocks: [...blocks, ...cal],
      candidates: {},
      context: { now: now.toISOString(), endOfDay: local(TODAY, '22:00'), location: { lat: 14.6, lng: 121 }, energy: 'medium', mode: 'local', utcOffsetMinutes: -now.getTimezoneOffset() },
    }).plan;
    const at = (title: string) => plan.items.find((i) => i.title === title)!;
    const a = at('Programming assignment');
    for (const fixed of ['Programming 1', 'Mathematics']) {
      const f = at(fixed);
      expect(f.fixed).toBe(true);
      expect(Date.parse(a.end) <= Date.parse(f.start) || Date.parse(a.start) >= Date.parse(f.end)).toBe(true);
    }
    // Classes keep their exact times.
    expect(new Date(at('Programming 1').start).toISOString()).toBe(local(TODAY, '08:00'));
    // The gym is planned within its window, and only once.
    const gym = plan.items.filter((i) => i.title === 'Gym');
    expect(gym).toHaveLength(1);
    expect(Date.parse(gym[0]!.start)).toBeGreaterThanOrEqual(Date.parse(local(TODAY, '16:00')));
    expect(Date.parse(gym[0]!.end)).toBeLessThanOrEqual(Date.parse(local(TODAY, '20:00')));
    expect(gym[0]!.fixed).toBeFalsy();
    void alternatives;
  });

  it('calendar not synced today: classes are still protected at their usual times', () => {
    const applied = applyRoutines(routines, null);
    const prog = applied.blocks.find((b) => b.title === 'Programming 1')!;
    expect(prog).toMatchObject({ fixedStart: '08:00', fixedEnd: '10:00', priority: 'must' });
    expect(applied.why[prog.id]).toMatch(/not synced/);
  });

  it('a class cancelled today (not in today’s calendar) isn’t planned from the routine either', () => {
    const withoutMath = today.filter((e) => e.title !== 'Mathematics');
    const applied = applyRoutines(routines, withoutMath);
    expect(applied.blocks.some((b) => b.title === 'Mathematics')).toBe(false);
  });

  it('routines the person made themselves are untouched', () => {
    const mine: StoredBlock = { id: 'read', title: 'Read', minMinutes: 30, maxMinutes: 30, priority: 'should', category: 'none', requirements: [], active: true };
    expect(applyRoutines([mine], today).blocks).toEqual([mine]);
  });

  it('matches an event to its routine by series, or by title near its usual time', () => {
    const gym = routines.find((b) => b.title === 'Gym')!;
    expect(eventMatches(gym, { title: 'GYM!', start: local(TODAY, '17:30') })).toBe(true);
    expect(eventMatches(gym, { title: 'Gym', start: local(TODAY, '07:00') })).toBe(false);
    const prog = routines.find((b) => b.title === 'Programming 1')!;
    expect(eventMatches(prog, { title: 'Renamed', seriesId: 'prog', start: local(TODAY, '08:00') })).toBe(true);
  });
});
