/**
 * Routines on chosen days: a weekdays-only routine is planned Monday to Friday
 * and nowhere else; paused routines are never planned; one-offs only on their day.
 */
import { describe, expect, it } from 'vitest';
import { plannedToday, repeatLabel, repeatsOn, weekdayOf, type StoredBlock } from '../src/lib/model';

const r = (extra: Partial<StoredBlock> = {}): StoredBlock => ({
  id: 'read',
  title: 'Read',
  minMinutes: 30,
  maxMinutes: 30,
  priority: 'should',
  category: 'none',
  requirements: [],
  active: true,
  ...extra,
});

// 2 Nov 2026 is a Monday; 7 Nov a Saturday; 8 Nov a Sunday.
describe('routines on chosen days', () => {
  it('reads the weekday of a local date', () => {
    expect([weekdayOf('2026-11-02'), weekdayOf('2026-11-07'), weekdayOf('2026-11-08')]).toEqual([1, 6, 0]);
  });

  it('repeats every day when no days are chosen (routines saved before this change)', () => {
    expect(['2026-11-02', '2026-11-07', '2026-11-08'].every((d) => repeatsOn(r(), d))).toBe(true);
  });

  it('a weekdays routine is planned Monday to Friday only', () => {
    const b = r({ days: [1, 2, 3, 4, 5] });
    expect(['2026-11-02', '2026-11-03', '2026-11-06'].every((d) => plannedToday(b, d))).toBe(true);
    expect(plannedToday(b, '2026-11-07')).toBe(false);
    expect(plannedToday(b, '2026-11-08')).toBe(false);
  });

  it('a paused routine is never planned, whatever its days', () => {
    expect(plannedToday(r({ active: false }), '2026-11-02')).toBe(false);
    expect(plannedToday(r({ active: false, days: [1] }), '2026-11-02')).toBe(false);
  });

  it('a one-off counts only on its own date, even with days left over from being a routine', () => {
    const b = r({ date: '2026-11-03', days: [1] });
    expect(plannedToday(b, '2026-11-03')).toBe(true);
    expect(plannedToday(b, '2026-11-02')).toBe(false);
  });

  it('describes the days in plain words', () => {
    expect(repeatLabel(undefined)).toBe('Every day');
    expect(repeatLabel([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
    expect(repeatLabel([5, 4, 3, 2, 1])).toBe('Weekdays');
    expect(repeatLabel([6, 0])).toBe('Weekends');
    expect(repeatLabel([0, 1, 3, 5])).toBe('Mon, Wed, Fri, Sun');
  });
});
