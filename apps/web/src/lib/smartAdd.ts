/**
 * "Ask in your own words": when the phone's own parser isn't sure, the user
 * can tap to let the server (Claude) read the note. Only the note and the
 * local time are sent.
 */
import type { PlaceCategory, Priority, Requirement, TimePref } from '@segue/engine';
import { localDate, newId, type StoredBlock } from './model';
import { API_URL } from './reroute';

/** Mirrors UnderstoodBlock in apps/api/src/understand.ts. */
interface UnderstoodBlock {
  title: string;
  minutes: number;
  priority: Priority;
  category: PlaceCategory;
  requirements: Requirement[];
  fixedStart: string | null;
  fixedEnd: string | null;
  place: string | null;
  earliest: string | null;
  latest: string | null;
  timePref: TimePref | null;
  repeatsDaily: boolean;
}

const FALLBACK: Partial<Record<PlaceCategory, string>> = {
  cafe: 'Work wherever you are',
  cowork: 'Work wherever you are',
  library: 'Read wherever you are',
  restaurant: 'Grab something to go',
  gym: 'Bodyweight workout where you are',
  park: 'Walk around the block',
  grocery: 'Order delivery',
  mall: 'Order online',
};

interface Health {
  smartAdd?: boolean;
  assistant?: 'ai' | 'basic';
}
let health: Promise<Health> | null = null;

/** What this server offers. Asked once per session. */
function serverHealth(): Promise<Health> {
  health ??= fetch(`${API_URL}/health`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => {
      health = null; // try again later, e.g. when back online
      return {};
    });
  return health;
}

/** Whether this server can read notes. */
export const smartAddAvailable = (): Promise<boolean> => serverHealth().then((b) => b.smartAdd === true);

/** Whether the planning assistant can use AI here (it also needs a Segue account). */
export const assistantAiAvailable = (): Promise<boolean> => serverHealth().then((b) => b.assistant === 'ai');

export function toStoredBlock(u: UnderstoodBlock, now: Date): StoredBlock {
  const b: StoredBlock = {
    id: newId(),
    title: u.title,
    minMinutes: Math.max(5, Math.round((u.minutes * 0.75) / 5) * 5),
    maxMinutes: u.minutes,
    priority: u.priority,
    category: u.category,
    requirements: u.requirements,
    fallback: FALLBACK[u.category],
    active: true,
  };
  if (!u.repeatsDaily) b.date = localDate(now);
  if (u.fixedStart && u.fixedEnd) {
    b.fixedStart = u.fixedStart;
    b.fixedEnd = u.fixedEnd;
    if (u.place) b.fixedPlace = u.place;
  } else {
    if (u.earliest) b.earliest = u.earliest;
    if (u.latest) b.latest = u.latest;
    if (u.timePref) b.timePref = u.timePref;
    if (u.place) b.title = `${b.title} at ${u.place}`.slice(0, 80);
  }
  return b;
}

/** Blocks read from a note, or a plain-words error. */
export async function askSmartAdd(text: string, now = new Date()): Promise<StoredBlock[]> {
  const localTime = `${now.toLocaleDateString('en', { weekday: 'long' })} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/understand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, localTime }),
    });
  } catch {
    throw new Error("Couldn't reach Segue. Check your connection and try again.");
  }
  if (res.status === 429) throw new Error("That's a lot of notes for one hour. Add this one by hand for now.");
  if (!res.ok) throw new Error("Couldn't read that note right now. Try shorter words, or add it by hand.");
  const body = (await res.json()) as { blocks: UnderstoodBlock[] };
  if (!body.blocks.length) throw new Error("Didn't find anything to plan in that note.");
  return body.blocks.map((u) => toStoredBlock(u, now));
}
