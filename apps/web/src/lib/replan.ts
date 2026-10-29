/**
 * One-tap re-route reasons. Each one is a small, explainable change to what
 * the engine is told, so "I'm tired" or "It's raining" just works without a form.
 */
import type { Block, Energy, WeatherHour } from '@segue/engine';

export type ReplanReason = 'late' | 'rain' | 'tired' | 'elsewhere' | 'busy';

export const REASONS: { id: ReplanReason; label: string; hint: string }[] = [
  { id: 'late', label: 'Running late', hint: 'Starts the rest of the day 15 minutes from now.' },
  { id: 'rain', label: "It's raining", hint: 'Moves outdoor plans inside where it can.' },
  { id: 'tired', label: "I'm tired", hint: 'Puts lighter things first.' },
  { id: 'elsewhere', label: "I'm somewhere else", hint: 'Finds where you are now and plans from there.' },
  { id: 'busy', label: 'Something came up', hint: 'Keeps the next hour free.' },
];

export const BUSY_BLOCK_ID = 'busy_now';
const LATE_MINUTES = 15;
const BUSY_MINUTES = 60;

export interface ReplanAdjustments {
  /** when the plan should start */
  start: Date;
  energy: Energy;
  /** replaces the forecast, e.g. rain for the rest of the day */
  weather?: WeatherHour[];
  extraBlocks: Block[];
  /** ask the phone for a fresh position */
  refreshLocation: boolean;
}

/** "My meeting is running over until 4:30": keep that time blocked instead of the default hour. */
export interface BusyDetails {
  until?: Date;
  title?: string;
}

export function adjustFor(reason: ReplanReason | null, now: Date, energy: Energy, endOfDay: string, busy: BusyDetails = {}): ReplanAdjustments {
  const out: ReplanAdjustments = { start: now, energy, extraBlocks: [], refreshLocation: false };
  switch (reason) {
    case 'late':
      out.start = new Date(now.getTime() + LATE_MINUTES * 60_000);
      break;
    case 'tired':
      out.energy = 'low';
      break;
    case 'elsewhere':
      out.refreshLocation = true;
      break;
    case 'rain': {
      const hours: WeatherHour[] = [];
      const t = new Date(now);
      t.setMinutes(0, 0, 0);
      for (; t.getTime() < Date.parse(endOfDay) && hours.length < 48; t.setHours(t.getHours() + 1)) {
        hours.push({ time: t.toISOString(), precipitationProbability: 100 });
      }
      out.weather = hours;
      break;
    }
    case 'busy': {
      // Between 5 minutes from now and the end of the day; otherwise the usual hour.
      const until = busy.until?.getTime();
      const end = until && until >= now.getTime() + 5 * 60_000 ? Math.min(until, Date.parse(endOfDay)) : now.getTime() + BUSY_MINUTES * 60_000;
      const minutes = Math.max(5, Math.round((end - now.getTime()) / 60_000));
      out.extraBlocks.push({
        id: BUSY_BLOCK_ID,
        title: busy.title?.slice(0, 80) || 'Something came up',
        minMinutes: minutes,
        maxMinutes: minutes,
        priority: 'must',
        category: 'none',
        requirements: [],
        fixed: { start: now.toISOString(), end: new Date(now.getTime() + minutes * 60_000).toISOString() },
      });
      break;
    }
  }
  return out;
}
