/**
 * "Move tasks up" after a skip. Skipping never moves anything by itself; this
 * runs only when the user asks, and only proposes: nothing changes until they
 * apply it.
 *
 * It keeps the day as the user planned it, in the same order, at the same
 * places and for the same lengths, and only lets things start earlier where
 * that's realistic: after the trip from the previous stop (estimated, rush
 * hour included), not before an item's own "not before" time, inside a
 * place's listed opening hours when they're known, and never into a set-time
 * commitment, a calendar event, a pinned item or something already underway,
 * which all stay exactly where they are. Pure, so it's easy to test.
 */
import { earliestOpenStart, estimateTravelMinutes, trafficAware, type LatLng, type Place, type Plan, type PlanItem, type TravelMode } from '@segue/engine';
import { isCalendarBlock } from './calendar';

export interface Move {
  blockId: string;
  title: string;
  from: string;
  to: string;
}

export type MoveUpResult =
  | { kind: 'moves'; moves: Move[]; plan: Plan; stamp: string }
  | { kind: 'nothing'; reason: string }
  | { kind: 'blocked'; reason: string };

export interface MoveUpContext {
  now: number;
  /** where the user is now */
  location: LatLng;
  mode: TravelMode;
  utcOffsetMinutes: number;
  /** each item's "not before" time, from its block */
  earliest: Record<string, string | undefined>;
  /** places the phone knows, for listed opening hours */
  places: Place[];
  /** items the user pinned at their time */
  pinned: string[];
}

/** Fingerprint of the times and places on a plan: a proposal is stale once this changes. */
export const planStampOf = (plan: Plan | undefined, finished: string[]) =>
  `${(plan?.items ?? []).map((i) => `${i.blockId}@${i.start}-${i.end}:${i.place?.id ?? ''}`).join('|')}#${[...finished].sort().join(',')}`;

const STEP = 5 * 60_000;
const roundUp = (ms: number) => Math.ceil(ms / STEP) * STEP;
const iso = (ms: number) => new Date(ms).toISOString();

export function moveUp(current: Plan, finished: string[], c: MoveUpContext): MoveUpResult {
  const done = new Set(finished);
  const pinned = new Set(c.pinned);
  const hoursOf = new Map(c.places.map((p) => [p.id, p.hours]));
  const travel = trafficAware(estimateTravelMinutes, c.utcOffsetMinutes);
  const items = [...current.items].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

  let cursor = roundUp(c.now);
  let here = c.location;
  const out: PlanItem[] = [];
  const moves: Move[] = [];
  for (const it of items) {
    if (done.has(it.blockId)) {
      out.push(it);
      continue;
    }
    const start = Date.parse(it.start);
    const end = Date.parse(it.end);
    const length = end - start;
    const trip = it.place ? travel(here, it.place.location, c.mode, cursor) : 0;
    const stays = it.fixed || isCalendarBlock(it.blockId) || pinned.has(it.blockId) || start <= c.now;
    let next = it;
    if (!stays) {
      let earliest = Math.max(roundUp(cursor + trip * 60_000), c.earliest[it.blockId] ? Date.parse(c.earliest[it.blockId]!) : 0);
      const hours = it.place ? hoursOf.get(it.place.id) : undefined;
      if (hours && earliest < start) {
        // Only as early as the place is open for the whole visit (listed hours).
        const open = earliestOpenStart(hours, earliest, length / 60_000, end, c.utcOffsetMinutes);
        earliest = open === null ? start : roundUp(open);
      }
      if (earliest <= start - STEP) {
        next = { ...it, start: iso(earliest), end: iso(earliest + length), travelMinutesBefore: trip, explanation: 'Moved up after you skipped something' };
        moves.push({ blockId: it.blockId, title: it.title, from: it.start, to: next.start });
      }
    }
    // Whatever stays put must still be reachable in time from the stop before it.
    if (next === it && !it.conflict && cursor + trip * 60_000 > start + 60_000 && out.some((o) => !done.has(o.blockId))) {
      return { kind: 'blocked', reason: `Moving things up would leave too little time to get to ${it.title}, so your schedule stays as it is.` };
    }
    out.push(next);
    cursor = Math.max(cursor, Date.parse(next.end));
    if (next.place) here = next.place.location;
  }

  if (!moves.length) {
    return { kind: 'nothing', reason: 'Nothing can start earlier without clashing with a set time, a trip or opening hours, so your schedule stays as it is.' };
  }
  return { kind: 'moves', moves, plan: { ...current, items: out }, stamp: planStampOf(current, finished) };
}
