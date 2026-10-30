import { describe, expect, it } from 'vitest';
import { forServer, isEmpty, merge, newerProgress } from '../src/lib/syncMerge';

const p = (date: string, updatedAt: string, done: string[] = [], skipped: string[] = []) => ({ date, done, skipped, updatedAt });

describe("today's done and skipped, across devices", () => {
  it('the latest change wins on the same day, so an undo sticks', () => {
    const doneOnPhone = p('2026-10-30', '2026-10-30T01:00:00Z', ['read']);
    const undoneOnLaptop = p('2026-10-30', '2026-10-30T01:05:00Z', []);
    expect(merge('today', doneOnPhone, undoneOnLaptop)).toEqual(undoneOnLaptop);
    expect(merge('today', undoneOnLaptop, doneOnPhone)).toEqual(undoneOnLaptop);
  });

  it('a newer day replaces yesterday, whichever device has it', () => {
    expect(newerProgress(p('2026-10-29', '2026-10-29T15:00:00Z', ['x']), p('2026-10-30', '2026-10-30T00:01:00Z'))!.date).toBe('2026-10-30');
    expect(newerProgress(null, p('2026-10-30', '2026-10-30T00:01:00Z'))!.date).toBe('2026-10-30');
  });

  it('calendar events never leave the device, and nothing marked means nothing to sync', () => {
    expect(forServer('today', p('2026-10-30', '2026-10-30T01:00:00Z', ['read', 'gcal_1'], ['gcal_2']))).toEqual(p('2026-10-30', '2026-10-30T01:00:00Z', ['read'], []));
    expect(isEmpty('today', null)).toBe(true);
  });
});
