/**
 * How two copies of the planner come together when this device and your
 * account both changed. Pure functions, so the rules are easy to test.
 *
 * - Routines, one-offs and saved places: every item from both, by id. When
 *   both have the same item, this device's copy wins (it's the edit you just
 *   made). Something deleted on one device while the other still has it may
 *   come back; that's safer than losing it.
 * - Place history: the higher counts.
 * - Past days: every day from both; this device's copy of a day wins.
 * - Settings: the account's, apart from anything only this device knows.
 * - Today's done and skipped: the latest day wins, and on the same day the
 *   latest change wins (so an undo on one device sticks on the others).
 */
import type { SyncKey, TodayProgress } from '@segue/schemas';
import type { DayArchive } from './days';
import type { FavoritePlace, PlaceHistory, Settings, StoredBlock } from './model';

export interface Synced {
  blocks: StoredBlock[];
  settings: Settings;
  favorites: FavoritePlace[];
  placeHistory: PlaceHistory;
  dayArchive: DayArchive;
  today: TodayProgress | null;
}

export const SYNC_KEYS: SyncKey[] = ['blocks', 'settings', 'favorites', 'placeHistory', 'dayArchive', 'today'];

const notCalendar = (ids: string[]) => ids.filter((id) => !id.startsWith('gcal_'));

/** What goes to the server: never a precise position, never Google Calendar events. */
export function forServer<K extends SyncKey>(key: K, value: Synced[K]): Synced[K] {
  if (key === 'settings') {
    const { lastLocation: _a, lastLocationLabel: _b, lastLocatedAt: _c, ...rest } = value as Settings;
    return rest as Synced[K];
  }
  if (key === 'today') {
    const t = value as TodayProgress | null;
    return (t ? { ...t, done: notCalendar(t.done), skipped: notCalendar(t.skipped) } : t) as Synced[K];
  }
  if (key === 'dayArchive') {
    const out: DayArchive = {};
    for (const [date, day] of Object.entries(value as DayArchive)) out[date] = { ...day, items: day.items.filter((i) => !i.blockId.startsWith('gcal_')) };
    return out as Synced[K];
  }
  return value;
}

/** A cheap fingerprint of what would be sent, to tell whether anything changed. */
export const fingerprint = <K extends SyncKey>(key: K, value: Synced[K]) => JSON.stringify(forServer(key, value));

export function isEmpty<K extends SyncKey>(key: K, value: Synced[K] | undefined): boolean {
  if (value == null) return true;
  if (key === 'settings') return !(value as Settings).onboarded;
  if (key === 'today') return !(value as TodayProgress).updatedAt;
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value as object).length === 0;
}

function byId<T extends { id: string }>(local: T[], server: T[]): T[] {
  const mine = new Map(local.map((x) => [x.id, x]));
  const out = server.map((s) => mine.get(s.id) ?? s);
  const known = new Set(server.map((s) => s.id));
  return [...out, ...local.filter((l) => !known.has(l.id))];
}

export function merge<K extends SyncKey>(key: K, local: Synced[K], server: Synced[K]): Synced[K] {
  switch (key) {
    case 'blocks':
    case 'favorites':
      return byId(local as { id: string }[], server as { id: string }[]) as Synced[K];
    case 'placeHistory': {
      const a = local as PlaceHistory;
      const b = server as PlaceHistory;
      const out: PlaceHistory = { ...b };
      for (const [id, h] of Object.entries(a)) {
        const s = b[id];
        out[id] = s ? { done: Math.max(h.done, s.done), skipped: Math.max(h.skipped, s.skipped) } : h;
      }
      return out as Synced[K];
    }
    case 'dayArchive':
      return { ...(server as DayArchive), ...(local as DayArchive) } as Synced[K];
    case 'today':
      return newerProgress(local as TodayProgress | null, server as TodayProgress | null) as Synced[K];
    case 'settings': {
      const l = local as Settings;
      const s = server as Settings;
      // The account wins; this device keeps its own last position (never on the server) and setup state.
      return { ...l, ...s, lastLocation: l.lastLocation, lastLocationLabel: l.lastLocationLabel, lastLocatedAt: l.lastLocatedAt, onboarded: !!(l.onboarded || s.onboarded) } as Synced[K];
    }
  }
  return server;
}

/** The later day, and on the same day the later change. Ties keep this device's. */
export function newerProgress(local: TodayProgress | null, server: TodayProgress | null): TodayProgress | null {
  if (!local) return server;
  if (!server) return local;
  if (local.date !== server.date) return local.date > server.date ? local : server;
  return Date.parse(server.updatedAt) > Date.parse(local.updatedAt) ? server : local;
}

/** Applying the server's settings keeps this device's own position fields. */
export function fromServer<K extends SyncKey>(key: K, server: Synced[K], local: Synced[K]): Synced[K] {
  if (key !== 'settings') return server;
  const l = local as Settings;
  return { ...(server as Settings), lastLocation: l.lastLocation, lastLocationLabel: l.lastLocationLabel, lastLocatedAt: l.lastLocatedAt } as Synced[K];
}
