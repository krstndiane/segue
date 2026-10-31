/**
 * "Tomorrow instead": take one thing off today without touching anything else.
 *
 * - A one-off moves to tomorrow (same length, same set time if it has one).
 * - A routine already comes back tomorrow, so it's just left out of today.
 * - Calendar events belong to Google Calendar and can't be postponed here.
 *
 * Nothing else in today's plan moves: the item is taken out where it was, and
 * the rest keeps its times (the same rule as Skip). Pure, so it's easy to test.
 */
import { isCalendarBlock } from './calendar';
import { localDate, type DayState, type StoredBlock } from './model';

export type PostponeResult =
  | { kind: 'moved'; blocks: StoredBlock[]; day: DayState; to: string }
  | { kind: 'left-out'; blocks: StoredBlock[]; day: DayState };

export function tomorrowOf(now: Date): string {
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  return localDate(t);
}

export function postpone(blocks: StoredBlock[], day: DayState, id: string, now: Date): PostponeResult | null {
  if (isCalendarBlock(id)) return null;
  const block = blocks.find((b) => b.id === id);
  if (!block) return null;
  const withoutIt: DayState = {
    ...day,
    plan: day.plan && { ...day.plan, items: day.plan.items.filter((i) => i.blockId !== id) },
    doneIds: day.doneIds.filter((x) => x !== id),
    skippedIds: day.skippedIds.filter((x) => x !== id),
    lockedIds: day.lockedIds.filter((x) => x !== id),
  };
  if (block.date) {
    const to = tomorrowOf(now);
    return { kind: 'moved', to, blocks: blocks.map((b) => (b.id === id ? { ...b, date: to } : b)), day: withoutIt };
  }
  const excluded = day.excludedIds ?? [];
  return { kind: 'left-out', blocks, day: { ...withoutIt, excludedIds: excluded.includes(id) ? excluded : [...excluded, id] } };
}
