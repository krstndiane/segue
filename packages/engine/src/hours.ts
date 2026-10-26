import { DAY, MINUTE, localParts, parseHm } from './time';
import type { OpeningHours, Place } from './types';

interface Interval {
  start: number;
  end: number;
}

/**
 * Concrete open intervals (epoch ms) overlapping [fromMs, toMs].
 * Expands the weekly schedule over the local days that window touches,
 * including the day before (for periods that run past midnight).
 */
export function openIntervals(
  hours: OpeningHours,
  fromMs: number,
  toMs: number,
  utcOffsetMinutes: number,
): Interval[] {
  if (hours.always) return [{ start: fromMs, end: toMs }];
  const out: Interval[] = [];
  const first = localParts(fromMs, utcOffsetMinutes);
  for (let midnight = first.midnight - DAY; midnight <= toMs; midnight += DAY) {
    const day = localParts(midnight, utcOffsetMinutes).day;
    for (const p of hours.periods) {
      if (p.day !== day) continue;
      const open = parseHm(p.open);
      let close = parseHm(p.close);
      if (close <= open) close += 24 * 60; // runs past midnight
      const start = midnight + open * MINUTE;
      const end = midnight + close * MINUTE;
      if (end > fromMs && start < toMs) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged.at(-1);
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

/** True when the place is open for the whole of [startMs, endMs]. */
export function isOpenThroughout(
  hours: OpeningHours,
  startMs: number,
  endMs: number,
  utcOffsetMinutes: number,
): boolean {
  return openIntervals(hours, startMs, endMs, utcOffsetMinutes).some(
    (iv) => iv.start <= startMs && iv.end >= endMs,
  );
}

/**
 * Earliest start ≥ arriveMs at which the place stays open for `durationMin`,
 * searching until `latestEndMs`. Returns null when there is none.
 */
export function earliestOpenStart(
  hours: OpeningHours,
  arriveMs: number,
  durationMin: number,
  latestEndMs: number,
  utcOffsetMinutes: number,
): number | null {
  const need = durationMin * MINUTE;
  for (const iv of openIntervals(hours, arriveMs, latestEndMs, utcOffsetMinutes)) {
    const start = Math.max(iv.start, arriveMs);
    if (start + need <= iv.end && start + need <= latestEndMs) return start;
  }
  return null;
}

/** When does this place next close after `ms`? null if unknown/never. */
export function closingTimeAfter(
  hours: OpeningHours,
  ms: number,
  utcOffsetMinutes: number,
): number | null {
  if (hours.always) return null;
  const iv = openIntervals(hours, ms, ms + 1, utcOffsetMinutes).find((i) => i.start <= ms && i.end > ms);
  return iv ? iv.end : null;
}

/**
 * What Segue can honestly say about a place at a moment. Listed hours are the
 * venue's published hours, not live availability, so "open" means "open by
 * its listed hours".
 */
export type OpenStatus = 'open' | 'closed' | 'unknown' | 'temporarily-closed';

export interface OpenStatusInfo {
  status: OpenStatus;
  /** when it closes next (open), or null for 24/7 */
  closesAt?: number | null;
  /** when it opens next within a week (closed) */
  opensAt?: number | null;
}

export function openStatusAt(place: Pick<Place, 'hours' | 'temporarilyClosed'>, ms: number, utcOffsetMinutes: number): OpenStatusInfo {
  if (place.temporarilyClosed) return { status: 'temporarily-closed' };
  const hours = place.hours;
  if (!hours) return { status: 'unknown' };
  if (hours.always) return { status: 'open', closesAt: null };
  if (!hours.periods.length) return { status: 'unknown' };
  const ivs = openIntervals(hours, ms, ms + 7 * DAY, utcOffsetMinutes);
  const now = ivs.find((iv) => iv.start <= ms && iv.end > ms);
  if (now) return { status: 'open', closesAt: now.end };
  const next = ivs.find((iv) => iv.start > ms);
  return { status: 'closed', opensAt: next?.start ?? null };
}
