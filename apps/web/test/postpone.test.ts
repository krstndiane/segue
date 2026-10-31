/**
 * "Move to tomorrow" and "Not today": one thing comes off today, nothing else moves.
 */
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@segue/engine';
import { emptyDay, type DayState, type StoredBlock } from '../src/lib/model';
import { postpone, tomorrowOf } from '../src/lib/postpone';

const NOW = new Date(2026, 10, 2, 10, 0); // 2 Nov 2026, 10:00 local
const block = (id: string, extra: Partial<StoredBlock> = {}): StoredBlock => ({
  id,
  title: id,
  minMinutes: 30,
  maxMinutes: 30,
  priority: 'should',
  category: 'none',
  requirements: [],
  active: true,
  ...extra,
});
const item = (blockId: string, h: number): PlanItem => ({
  blockId,
  title: blockId,
  start: new Date(2026, 10, 2, h).toISOString(),
  end: new Date(2026, 10, 2, h, 30).toISOString(),
  travelMinutesBefore: 0,
  confidence: 'no-place',
  fixed: false,
  fallbacks: [],
});
const blocks = [block('groceries', { date: '2026-11-02' }), block('read'), block('class', { date: '2026-11-02', fixedStart: '15:30', fixedEnd: '17:00' })];
const day = (): DayState => ({
  ...emptyDay('2026-11-02'),
  plan: { label: 'Balanced', items: [item('read', 11), item('groceries', 13), item('class', 15)], unscheduled: [], score: 0, totalTravelMinutes: 0 },
  lockedIds: ['groceries'],
});

describe('postpone', () => {
  it('moves a one-off to tomorrow and leaves every other item where it was', () => {
    const r = postpone(blocks, day(), 'groceries', NOW)!;
    expect(r.kind).toBe('moved');
    expect(r.blocks.find((b) => b.id === 'groceries')!.date).toBe('2026-11-03');
    expect(r.day.plan!.items.map((i) => [i.blockId, i.start])).toEqual(day().plan!.items.filter((i) => i.blockId !== 'groceries').map((i) => [i.blockId, i.start]));
    expect(r.day.lockedIds).not.toContain('groceries');
  });

  it('keeps a set time when it moves (same time tomorrow)', () => {
    const r = postpone(blocks, day(), 'class', NOW)!;
    const moved = r.blocks.find((b) => b.id === 'class')!;
    expect([moved.date, moved.fixedStart, moved.fixedEnd]).toEqual(['2026-11-03', '15:30', '17:00']);
  });

  it('leaves a routine out today only: the routine itself is unchanged', () => {
    const r = postpone(blocks, day(), 'read', NOW)!;
    expect(r.kind).toBe('left-out');
    expect(r.blocks).toBe(blocks);
    expect(r.day.excludedIds).toEqual(['read']);
    expect(r.day.plan!.items.some((i) => i.blockId === 'read')).toBe(false);
  });

  it('does nothing for calendar events or unknown items', () => {
    expect(postpone(blocks, day(), 'gcal_abc', NOW)).toBeNull();
    expect(postpone(blocks, day(), 'nope', NOW)).toBeNull();
  });

  it('works out tomorrow across a month end', () => {
    expect(tomorrowOf(new Date(2026, 9, 31, 23, 30))).toBe('2026-11-01');
  });
});
