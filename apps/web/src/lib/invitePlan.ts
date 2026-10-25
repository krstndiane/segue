/**
 * Bringing an accepted invitation into your own day. Nothing is added unless
 * you ask; when you do, it becomes a fixed block on that date, and Segue
 * first tells you what it overlaps. Each person's travel and re-routing stay
 * their own: the block only says when and where the shared activity is.
 */
import type { ActivityView } from '@segue/schemas';
import type { CalendarEvent } from './calendar';
import { localDate, type StoredBlock } from './model';

/** The block id for an activity, so it's added once and can be updated later. */
export const activityBlockId = (activityId: string) => `act_${activityId.replace(/-/g, '').slice(0, 24)}`;

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Local date, start and end of an activity on this device's clock; null when it has no time yet or runs past midnight. */
export function activitySlot(a: Pick<ActivityView, 'startsAt' | 'endsAt'>): { date: string; start: string; end: string; minutes: number } | null {
  if (!a.startsAt) return null;
  const start = new Date(a.startsAt);
  const end = a.endsAt ? new Date(a.endsAt) : new Date(start.getTime() + 60 * 60_000);
  if (localDate(start) !== localDate(new Date(end.getTime() - 1))) return null;
  return { date: localDate(start), start: hhmm(start), end: hhmm(end), minutes: Math.round((end.getTime() - start.getTime()) / 60_000) };
}

export function activityBlock(a: ActivityView): StoredBlock | null {
  const slot = activitySlot(a);
  if (!slot) return null;
  return {
    id: activityBlockId(a.id),
    title: a.title,
    minMinutes: slot.minutes,
    maxMinutes: slot.minutes,
    priority: 'must',
    category: 'none',
    requirements: [],
    fixedStart: slot.start,
    fixedEnd: slot.end,
    fixedPlace: a.placeName ?? undefined,
    active: true,
    date: slot.date,
  };
}

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

/**
 * What a fixed block would overlap on its date: other fixed routines and
 * one-offs, and that day's calendar events (when this device has them).
 */
export function conflictsFor(block: StoredBlock, blocks: StoredBlock[], events: CalendarEvent[] = []): string[] {
  if (!block.fixedStart || !block.fixedEnd || !block.date) return [];
  const s = toMin(block.fixedStart);
  const e = toMin(block.fixedEnd);
  const out: string[] = [];
  for (const b of blocks) {
    if (b.id === block.id || !b.active || !b.fixedStart || !b.fixedEnd) continue;
    if (b.date && b.date !== block.date) continue;
    if (toMin(b.fixedStart) < e && toMin(b.fixedEnd) > s) out.push(b.title);
  }
  for (const ev of events) {
    const es = new Date(ev.start);
    if (localDate(es) !== block.date) continue;
    const em = new Date(ev.end);
    if (es.getHours() * 60 + es.getMinutes() < e && (localDate(em) !== block.date ? 24 * 60 : em.getHours() * 60 + em.getMinutes()) > s) out.push(ev.title);
  }
  return out;
}

/** The block in your day no longer matches the activity (the sender changed the time or place). */
export function outOfDate(existing: StoredBlock, a: ActivityView): boolean {
  const fresh = activityBlock(a);
  if (!fresh) return false;
  return existing.date !== fresh.date || existing.fixedStart !== fresh.fixedStart || existing.fixedEnd !== fresh.fixedEnd || existing.title !== fresh.title || (existing.fixedPlace ?? null) !== (fresh.fixedPlace ?? null);
}
