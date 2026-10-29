/**
 * The app's own records. Blocks are stored with wall-clock times ("13:00")
 * so they repeat day to day; they become dated engine blocks at re-route time.
 */
import type {
  Block,
  Change,
  Energy,
  LatLng,
  Place,
  PlaceCategory,
  Plan,
  Priority,
  Requirement,
  TimePref,
  TravelMode,
} from '@segue/engine';

export interface StoredBlock {
  id: string;
  title: string;
  minMinutes: number;
  maxMinutes: number;
  priority: Priority;
  category: PlaceCategory;
  requirements: Requirement[];
  /** "HH:MM" local; for meetings and classes */
  fixedStart?: string;
  fixedEnd?: string;
  fixedPlace?: string;
  earliest?: string;
  latest?: string;
  timePref?: TimePref;
  energy?: Energy;
  fallback?: string;
  /** false = paused, not planned */
  active: boolean;
  /** Local "YYYY-MM-DD" for a one-off: planned that day only. Missing = a routine that repeats every day. */
  date?: string;
}

export interface Settings {
  endOfDay: string; // "HH:MM"
  energy: Energy;
  mode: TravelMode;
  /** finished the first-run setup */
  onboarded?: boolean;
  tempUnit?: 'C' | 'F';
  /** "leave now", rain and running-over reminders */
  reminders?: boolean;
  /** @deprecated read once to seed the saved fix ('fix' in the store); not written any more */
  lastLocation?: LatLng;
  /** @deprecated no longer used */
  lastLocationLabel?: string;
  /** @deprecated ISO time of the last real position fix; see `lastLocation` */
  lastLocatedAt?: string;
}

export interface DayState {
  /** local date "YYYY-MM-DD" this plan belongs to */
  date: string;
  plan?: Plan;
  alternatives: Plan[];
  changes: Change[];
  doneIds: string[];
  skippedIds: string[];
  lockedIds: string[];
  /** routines and calendar events left out of today's plan (they come back tomorrow) */
  excludedIds?: string[];
  /** weather precautions already acknowledged today, by kind */
  dismissedPrecautions?: string[];
  /** places turned down in "other options" today: not offered again today */
  declinedPlaceIds?: string[];
  /** items moved indoors (or to no place) today, so the rain nudge leaves them alone */
  indoorIds?: string[];
  generatedAt?: string;
  source?: 'server' | 'device';
  warnings: string[];
  /** when done/skipped last changed on this device (the latest change wins when devices sync) */
  progressAt?: string;
}

export interface PlaceCache {
  savedAt: string;
  location: LatLng;
  /** keyed by category so new blocks can reuse them */
  byCategory: Partial<Record<PlaceCategory, Place[]>>;
  /** came from a server running with made-up places (development only) */
  mock?: boolean;
}

export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  none: 'Anywhere',
  cafe: 'Café',
  cowork: 'Coworking space',
  library: 'Library',
  restaurant: 'Place to eat',
  gym: 'Gym',
  park: 'Park',
  grocery: 'Grocery',
  mall: 'Mall',
};

export const REQUIREMENT_LABEL: Record<Requirement, string> = {
  wifi: 'Wi-Fi',
  power: 'Power outlets',
  quiet: 'Quiet',
  outdoor: 'Outdoors',
  indoor: 'Indoors',
  food: 'Food',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  must: 'Must do',
  should: 'Should do',
  nice: "If there's time",
};

export const MODE_LABEL: Record<TravelMode, string> = {
  walk: 'Walking',
  transit: 'Train or bus',
  local: 'Jeep, trike or UV',
  drive: 'Car or ride-hail',
};

export const ENERGY_LABEL: Record<Energy, string> = { low: 'Tired', medium: 'Okay', high: 'Great' };

/** Local "YYYY-MM-DD" for a Date. */
export function localDate(d = new Date()): string {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10);
}

export function utcOffsetMinutes(d = new Date()): number {
  return -d.getTimezoneOffset();
}

/** "13:30" today (local) → ISO with offset. */
export function todayAt(hm: string, d = new Date()): string {
  const off = utcOffsetMinutes(d);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const tz = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  const [h = '0', m = '0'] = hm.split(':');
  return `${localDate(d)}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00${tz}`;
}

export function toEngineBlock(b: StoredBlock, now = new Date()): Block {
  const block: Block = {
    id: b.id,
    title: b.title,
    minMinutes: b.minMinutes,
    maxMinutes: Math.max(b.minMinutes, b.maxMinutes),
    priority: b.priority,
    category: b.category,
    requirements: b.requirements,
    timePref: b.timePref,
    energy: b.energy,
    fallback: b.fallback,
  };
  if (b.fixedStart && b.fixedEnd) {
    block.fixed = { start: todayAt(b.fixedStart, now), end: todayAt(b.fixedEnd, now), placeName: b.fixedPlace };
    block.category = 'none';
    block.requirements = [];
  }
  if (b.earliest) block.earliest = todayAt(b.earliest, now);
  if (b.latest) block.latest = todayAt(b.latest, now);
  return block;
}

/** Blocks that count today: routines, plus one-offs dated today. */
export function plannedToday(b: StoredBlock, date: string): boolean {
  return b.active && (!b.date || b.date === date);
}

/** A saved favourite place: preferred whenever a block needs that kind of place. */
export type FavoritePlace = Place;

/** What happened at each place: feeds the engine's place affinity. */
export type PlaceHistory = Record<string, { done: number; skipped: number }>;

/** 0..1 preference per place id: favourites first, then places you keep going back to. */
export function affinityFrom(history: PlaceHistory, favorites: FavoritePlace[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, h] of Object.entries(history)) {
    out[id] = Math.min(0.9, Math.max(0, 0.5 + 0.1 * h.done - 0.15 * h.skipped));
  }
  for (const f of favorites) out[f.id] = 1;
  return out;
}

export function newId(prefix = 'b'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function emptyDay(date = localDate()): DayState {
  return { date, alternatives: [], changes: [], doneIds: [], skippedIds: [], lockedIds: [], warnings: [] };
}
