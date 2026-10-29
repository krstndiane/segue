/**
 * Google Calendar → fixed blocks. Pure, so it's easy to test: the network
 * and sign-in live in googleCalendar.ts. Events become fixed blocks for the
 * day, which the engine plans around and never moves. Segue only reads the
 * calendar; it never writes to it.
 */
import type { Block } from '@segue/engine';

/** One timed event from today, as Segue keeps it. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO timestamps */
  start: string;
  end: string;
  location?: string;
}

/** An all-day event (a holiday, a birthday, a trip): shown on the day, never blocks time. */
export interface AllDayEvent {
  id: string;
  title: string;
}

/** Saved on the phone. The access token is never saved; it lives in memory only. */
export interface CalendarState {
  connected: boolean;
  /** local "YYYY-MM-DD" the events belong to */
  date?: string;
  events: CalendarEvent[];
  allDay?: AllDayEvent[];
  syncedAt?: string;
}

export const EMPTY_CALENDAR: CalendarState = { connected: false, events: [] };

/** The parts of a Google Calendar API event that matter here. */
export interface GoogleEvent {
  id: string;
  /** shared across calendars for the same meeting */
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** One page of a Calendar API events list. */
export interface GoogleEventPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

const PREFIX = 'gcal_';
// Limits from the API's block schema (packages/schemas).
const MAX_ID = 64;
const MAX_TITLE = 80;
const MIN_MINUTES = 5;
const MAX_MINUTES = 720;

export const isCalendarBlock = (blockId: string) => blockId.startsWith(PREFIX);

/** Short, stable block id: Google ids for recurring events can be long. */
export function calendarBlockId(eventId: string): string {
  if (PREFIX.length + eventId.length <= MAX_ID) return PREFIX + eventId;
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < eventId.length; i++) h = Math.imul(h ^ eventId.charCodeAt(i), 0x01000193);
  return `${PREFIX}${eventId.slice(0, 40)}_${(h >>> 0).toString(16)}`;
}

/**
 * Keeps the events that make you busy: timed, not cancelled, not marked
 * "free", and not ones you declined. All-day events (birthdays, holidays)
 * don't block time, so they're left out.
 */
export function parseEvents(items: GoogleEvent[], dayStart: string, dayEnd: string): CalendarEvent[] {
  const from = Date.parse(dayStart);
  const to = Date.parse(dayEnd);
  const out: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const e of items) {
    if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
    if (!e.start?.dateTime || !e.end?.dateTime) continue;
    if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
    // Events that run over midnight count only for the part inside today.
    const start = Math.max(Date.parse(e.start.dateTime), from);
    const end = Math.min(Date.parse(e.end.dateTime), to);
    if (!(end - start >= MIN_MINUTES * 60_000)) continue;
    // The same meeting can show up on more than one calendar.
    const key = `${e.iCalUID ?? e.id}|${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: e.id,
      title: (e.summary?.trim() || 'Busy').slice(0, MAX_TITLE),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      location: e.location?.trim() || undefined,
    });
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** All-day events that cover the local day `dayKey` ("YYYY-MM-DD"). Google's end date is exclusive. */
export function parseAllDay(items: GoogleEvent[], dayKey: string): AllDayEvent[] {
  const out: AllDayEvent[] = [];
  const seen = new Set<string>();
  for (const e of items) {
    if (e.status === 'cancelled' || !e.start?.date || e.start.dateTime) continue;
    if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) continue;
    const end = e.end?.date ?? e.start.date;
    if (!(e.start.date <= dayKey && (end > dayKey || end === e.start.date))) continue;
    const key = e.iCalUID ?? e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: e.id, title: (e.summary?.trim() || 'Busy').slice(0, MAX_TITLE) });
  }
  return out;
}

/**
 * How today's calendar compares with today's plan: events not planned around
 * yet, events whose time changed in Google Calendar, and planned calendar
 * items that are no longer there. Events the user chose to leave out don't count.
 */
export interface CalendarDiff {
  missing: CalendarEvent[];
  changed: CalendarEvent[];
  gone: { blockId: string; title: string }[];
}

export function calendarDiff(events: CalendarEvent[], plan: { items: { blockId: string; title: string; start: string; end: string }[]; unscheduled: { blockId: string; title: string }[] } | null | undefined, excludedIds: string[] = []): CalendarDiff {
  const out: CalendarDiff = { missing: [], changed: [], gone: [] };
  if (!plan) return out;
  const excluded = new Set(excludedIds);
  const planned = new Map(plan.items.filter((i) => isCalendarBlock(i.blockId)).map((i) => [i.blockId, i]));
  const unscheduled = new Set(plan.unscheduled.filter((u) => isCalendarBlock(u.blockId)).map((u) => u.blockId));
  const current = new Set<string>();
  for (const e of events) {
    const id = calendarBlockId(e.id);
    current.add(id);
    if (excluded.has(id) || unscheduled.has(id)) continue;
    const p = planned.get(id);
    if (!p) out.missing.push(e);
    else if (Date.parse(p.start) !== Date.parse(e.start) || Date.parse(p.end) !== Date.parse(e.end)) out.changed.push(e);
  }
  for (const [id, p] of planned) if (!current.has(id)) out.gone.push({ blockId: id, title: p.title });
  return out;
}

/** Fixed engine blocks for the events, keeping within `room` blocks. */
export function calendarBlocks(events: CalendarEvent[], room: number): Block[] {
  return events.slice(0, Math.max(0, room)).map((e) => {
    const minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000)));
    return {
      id: calendarBlockId(e.id),
      title: e.title,
      minMinutes: minutes,
      maxMinutes: minutes,
      priority: 'must',
      category: 'none',
      requirements: [],
      fixed: { start: e.start, end: e.end, placeName: e.location?.slice(0, MAX_TITLE) },
    };
  });
}

/** Start and end of a local day, as ISO timestamps for the Calendar API. */
export function dayBounds(date: Date): { start: string; end: string } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
