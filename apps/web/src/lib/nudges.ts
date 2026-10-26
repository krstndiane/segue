/**
 * Nudges: the tap on the shoulder when something needs attention. Pure, so
 * they're easy to test; useReminders turns them into notifications.
 */
import type { PlanItem, TravelMode } from '@segue/engine';
import { clock, travelLine } from './format';
import type { DayState, StoredBlock } from './model';
import type { SkyView } from './weather';

export interface Nudge {
  /** stable per item and kind, so a reminder fires once */
  id: string;
  kind: 'leave' | 'over' | 'rain' | 'weather';
  title: string;
  body: string;
  action: 'directions' | 'replan' | 'options' | 'none';
  /** the plan item it's about; weather precautions have none */
  item?: PlanItem;
  /** when it becomes relevant (ms) */
  at: number;
}

const LEAVE_HEADS_UP_MIN = 10;
const OVER_GRACE_MIN = 5;
const OVER_WINDOW_MIN = 60;

export function nudgesFor(
  day: DayState,
  now: Date,
  opts: { mode: TravelMode; blocks: StoredBlock[]; sky?: SkyView; /** the top weather precaution, e.g. "Bring an umbrella" */ tip?: string },
): Nudge[] {
  const t = now.getTime();
  const finished = new Set([...day.doneIds, ...day.skippedIds]);
  const items = (day.plan?.items ?? []).filter((i) => !finished.has(i.blockId));
  const out: Nudge[] = [];

  // Leave now: the next stop that needs travel.
  const next = items.find((i) => Date.parse(i.start) > t);
  if (next?.place && next.travelMinutesBefore > 0) {
    const leaveAt = Date.parse(next.start) - next.travelMinutesBefore * 60_000;
    out.push({
      id: `leave:${next.blockId}:${next.start}`,
      kind: 'leave',
      title: t >= leaveAt ? 'Time to leave' : `Leave by ${clock(new Date(leaveAt).toISOString())}`,
      body: `${next.title} at ${next.place.name} · ${travelLine(next, opts.mode) ?? ''}`.replace(/ · $/, '') + (opts.tip ? `. ${opts.tip}.` : ''),
      action: 'directions',
      item: next,
      at: leaveAt - LEAVE_HEADS_UP_MIN * 60_000,
    });
  }

  // Running over: something ended a little while ago and wasn't marked done or skipped.
  const over = [...items].reverse().find((i) => {
    const end = Date.parse(i.end);
    return !i.fixed && end + OVER_GRACE_MIN * 60_000 <= t && t - end <= OVER_WINDOW_MIN * 60_000;
  });
  if (over) {
    out.push({
      id: `over:${over.blockId}:${over.end}`,
      kind: 'over',
      title: `Still on ${over.title}?`,
      body: 'Mark it done, or re-route to fit the rest of the day.',
      action: 'replan',
      item: over,
      at: Date.parse(over.end) + OVER_GRACE_MIN * 60_000,
    });
  }

  // Rain: an outdoor plan coming up while it's wet out.
  const wet = opts.sky?.known && !opts.sky.preview && ['rain', 'heavy-rain', 'storm'].includes(opts.sky.condition);
  if (wet) {
    const outdoor = items.find((i) => {
      if (Date.parse(i.end) <= t) return false;
      const b = opts.blocks.find((x) => x.id === i.blockId);
      return !!b && (b.category === 'park' || b.requirements.includes('outdoor')) && !!i.place && !(day.indoorIds ?? []).includes(i.blockId);
    });
    if (outdoor) {
      out.push({
        id: `rain:${outdoor.blockId}:${day.date}`,
        kind: 'rain',
        title: `It's raining: ${outdoor.title} is outside`,
        body: 'See what you could do indoors instead, or later.',
        action: 'options',
        item: outdoor,
        at: t,
      });
    }
  }

  return out;
}

/** The nudges to show right now, most urgent first. */
export function activeNudges(nudges: Nudge[], now: Date): Nudge[] {
  const order = { over: 0, leave: 1, rain: 2, weather: 3 } as const;
  return nudges.filter((n) => n.at <= now.getTime()).sort((a, b) => order[a.kind] - order[b.kind]);
}
