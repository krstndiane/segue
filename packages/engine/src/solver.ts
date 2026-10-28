/**
 * The solver: greedy insertion followed by a bounded local search.
 *
 * A day is a sequence of slots. Pinned slots (fixed blocks, locked items)
 * keep their times; flexible slots are placed as early as travel, opening
 * hours and time windows allow. Every candidate change is checked by
 * simulating the whole sequence, so a plan is always feasible.
 */
import { estimateTravelMinutes, trafficAware } from './geo';
import { earliestOpenStart } from './hours';
import {
  energyPenalty,
  failsHardRequirement,
  fitScore,
  isOutdoor,
  qualityScore,
  rainChanceAt,
  staticCandidateScore,
  timePrefPenalty,
} from './score';
import { MINUTE, HOUR, roundUpTo, toMs } from './time';
import type { Block, Context, LatLng, Place, PlaceRef, TravelFn, Weights } from './types';

/** How late a fixed block may be reached and still count as on time. */
const FIXED_SLACK_MIN = 5;
/** Flexible blocks start on 5-minute marks. */
const START_STEP_MIN = 5;
/** How many candidate places per block the solver considers. */
const MAX_CANDIDATES = 8;
/** Share of a block's value kept when it runs as its no-place fallback. */
const FALLBACK_VALUE = 0.55;

export interface Option {
  place?: Place;
  /** true = run the block's no-place fallback instead */
  fallback: boolean;
}

export interface Slot {
  block: Block;
  option: Option;
  durationMin: number;
  /** pinned slots keep these exact times */
  pinned?: {
    start: number;
    end: number;
    place?: PlaceRef;
    /**
     * A commitment that can't be met cleanly no matter what else is planned:
     * minutes of lateness already unavoidable, and whether it overlaps the
     * commitment before it. It stays in the plan and is flagged; nothing else
     * may make it worse.
     */
    lateOkMin?: number;
    overlapOk?: boolean;
  };
}

export interface SimItem {
  slot: Slot;
  start: number;
  end: number;
  travelMin: number;
  /** started later than arrival because the place wasn't open yet */
  waitedForOpen: boolean;
  location?: LatLng;
  /** pinned only: minutes after its start that the user gets there */
  lateMin?: number;
  /** pinned only: it starts before the previous item ends */
  overlapsPrevious?: boolean;
}

export interface SolverEnv {
  context: Context;
  nowMs: number;
  endMs: number;
  weights: Weights;
  travel: TravelFn;
  affinity?: Record<string, number>;
}

export function makeEnv(
  context: Context,
  weights: Weights,
  travel: TravelFn | undefined,
  affinity: Record<string, number> | undefined,
): SolverEnv {
  return {
    context,
    nowMs: toMs(context.now),
    endMs: toMs(context.endOfDay),
    weights,
    travel: travel ?? trafficAware(estimateTravelMinutes, context.utcOffsetMinutes),
    affinity,
  };
}

export function slotLocation(slot: Slot): LatLng | undefined {
  return slot.pinned?.place?.location ?? slot.option.place?.location ?? slot.block.fixed?.location;
}

/** Walk the sequence in order and compute real times. null = infeasible. */
export function simulate(seq: Slot[], env: SolverEnv): SimItem[] | null {
  const { context, nowMs, endMs } = env;
  let t = nowMs;
  let pos: LatLng = context.location;
  const out: SimItem[] = [];

  for (const slot of seq) {
    const dest = slotLocation(slot);
    const travelMin = dest ? env.travel(pos, dest, context.mode, t) : 0;
    const arrive = t + travelMin * MINUTE;

    if (slot.pinned) {
      const { start, end, lateOkMin = 0, overlapOk = false } = slot.pinned;
      // Only check arrival for things that haven't started yet. A commitment
      // that's already out of reach may stay as late as it is, never later.
      // Something earlier in the sequence would still be running. Two
      // commitments that overlap each other are allowed (and flagged); a
      // flexible item is never squeezed in before one.
      const overlaps = out.length > 0 && start < t;
      if (overlaps && !(overlapOk && out[out.length - 1]!.slot.pinned)) return null;
      // Lateness from travel; an overlap is reported as an overlap instead.
      const lateMin = start > nowMs && !overlaps ? Math.max(0, Math.round((arrive - start) / MINUTE)) : 0;
      if (lateMin > FIXED_SLACK_MIN + lateOkMin) return null;
      out.push({ slot, start, end, travelMin, waitedForOpen: false, location: dest, lateMin, overlapsPrevious: overlaps });
      t = Math.max(t, end);
    } else {
      const b = slot.block;
      const earliest = roundUpTo(
        Math.max(arrive, b.earliest ? toMs(b.earliest) : -Infinity, nowMs),
        START_STEP_MIN,
      );
      const latestEnd = Math.min(endMs, b.latest ? toMs(b.latest) : Infinity);
      const hours = slot.option.place?.hours;
      let start: number | null = earliest;
      if (hours) {
        const open = earliestOpenStart(hours, earliest, slot.durationMin, latestEnd, context.utcOffsetMinutes);
        start = open === null ? null : roundUpTo(open, START_STEP_MIN);
      }
      if (start === null) return null;
      const end = start + slot.durationMin * MINUTE;
      if (end > latestEnd) return null;
      out.push({ slot, start, end, travelMin, waitedForOpen: start > earliest, location: dest });
      t = end;
    }
    if (dest) pos = dest;
  }
  return out;
}

/** Value of one simulated item. Higher is better. */
export function itemValue(item: SimItem, env: SolverEnv): number {
  const { slot, start, travelMin } = item;
  const w = env.weights;
  const b = slot.block;
  const base = w.priority[b.priority];
  if (slot.pinned) return base - travelMin * w.travelPerMinute;

  const place = slot.option.place;
  let v = base * (1 - w.fitShare + w.fitShare * fitScore(b, place));
  if (slot.option.fallback) v *= FALLBACK_VALUE;
  // Prefer the full duration a little.
  const span = Math.max(1, b.maxMinutes - b.minMinutes);
  v *= 0.9 + 0.1 * ((slot.durationMin - b.minMinutes) / span);
  v += qualityScore(place) * w.quality;
  v += (place ? (env.affinity?.[place.id] ?? 0) : 0) * w.affinity;
  v -= travelMin * w.travelPerMinute;
  if (place && !place.hours) v -= w.unconfirmedHours;
  if (isOutdoor(b) && !slot.option.fallback) {
    const rain = rainChanceAt(env.context, start);
    if (rain !== undefined && rain >= 50) v -= w.rain * (rain / 100);
  }
  v -= energyPenalty(b, env.context, start, w);
  v -= timePrefPenalty(b, env.context, start, w);
  // Mild preference for doing important things sooner.
  v -= ((start - env.nowMs) / HOUR) * (base / 100) * 0.8;
  return v;
}

export function sequenceScore(items: SimItem[], env: SolverEnv): number {
  return items.reduce((s, it) => s + itemValue(it, env), 0);
}

/** Candidate options for a block, best first. */
export function optionsFor(block: Block, candidates: Place[] | undefined, env: SolverEnv): Option[] {
  const opts: Option[] = [];
  if (block.category === 'none') {
    opts.push({ fallback: false });
  } else {
    const remainingMin = (env.endMs - env.nowMs) / MINUTE;
    const ranked = (candidates ?? [])
      .filter((p) => !failsHardRequirement(block, p))
      .map((p) => {
        const travelMin = env.travel(env.context.location, p.location, env.context.mode, env.nowMs);
        return { p, travelMin, s: staticCandidateScore(block, p, travelMin, env.affinity, env.weights) };
      })
      .filter((x) => x.travelMin + block.minMinutes <= remainingMin)
      .sort((a, b) => b.s - a.s || a.p.id.localeCompare(b.p.id))
      .slice(0, MAX_CANDIDATES);
    for (const r of ranked) opts.push({ place: r.p, fallback: false });
  }
  if (block.fallback && block.category !== 'none') opts.push({ fallback: true });
  return opts;
}

function durationsFor(block: Block): number[] {
  const { minMinutes: lo, maxMinutes: hi } = block;
  const mid = Math.round((lo + hi) / 2 / 5) * 5;
  return [...new Set([hi, mid, lo])].filter((d) => d >= lo && d <= hi);
}

interface Best {
  seq: Slot[];
  score: number;
}

/**
 * Best way to add `block` to `seq`, or null if it cannot fit anywhere.
 * The no-place fallback is only used when no real place fits: the user asked
 * for a gym, so a nearby open gym beats a home workout even if it's a ride away.
 */
export function bestInsertion(seq: Slot[], block: Block, options: Option[], env: SolverEnv): Best | null {
  const real = options.filter((o) => !o.fallback);
  const fallback = options.filter((o) => o.fallback);
  const bestReal = bestInsertionAmong(seq, block, real, env);
  // Exception: outdoor plans compete with their indoor fallback, so rain can win.
  if (bestReal && !isOutdoor(block)) return bestReal;
  const bestFallback = bestInsertionAmong(seq, block, fallback, env);
  if (!bestReal) return bestFallback;
  return bestFallback && bestFallback.score > bestReal.score ? bestFallback : bestReal;
}

function bestInsertionAmong(seq: Slot[], block: Block, options: Option[], env: SolverEnv): Best | null {
  let best: Best | null = null;
  for (const option of options) {
    for (const durationMin of durationsFor(block)) {
      for (let i = 0; i <= seq.length; i++) {
        const cand = [...seq.slice(0, i), { block, option, durationMin }, ...seq.slice(i)];
        const sim = simulate(cand, env);
        if (!sim) continue;
        const score = sequenceScore(sim, env);
        if (!best || score > best.score + 1e-9) best = { seq: cand, score };
      }
    }
  }
  return best;
}

/** Order flexible blocks are inserted in: musts first, then by deadline. */
export function insertionOrder(blocks: Block[]): Block[] {
  const rank = { must: 0, should: 1, nice: 2 } as const;
  return [...blocks].sort(
    (a, b) =>
      rank[a.priority] - rank[b.priority] ||
      (a.latest ? toMs(a.latest) : Infinity) - (b.latest ? toMs(b.latest) : Infinity) ||
      b.maxMinutes - a.maxMinutes ||
      a.id.localeCompare(b.id),
  );
}

export interface SolveResult {
  seq: Slot[];
  sim: SimItem[];
  unscheduled: Block[];
  optionsByBlock: Map<string, Option[]>;
}

/**
 * Commitments are never dropped. One that can't be reached in time, or that
 * overlaps the one before it, keeps its place; the lateness or overlap it
 * already has is allowed, nothing more.
 */
export function pinSequence(pinned: Slot[], env: SolverEnv): Slot[] {
  const seq: Slot[] = [];
  let t = env.nowMs;
  let pos = env.context.location;
  for (const slot of [...pinned].sort((a, b) => a.pinned!.start - b.pinned!.start || a.pinned!.end - b.pinned!.end || a.block.id.localeCompare(b.block.id))) {
    const p = slot.pinned!;
    const dest = slotLocation(slot);
    const arrive = t + (dest ? env.travel(pos, dest, env.context.mode, t) : 0) * MINUTE;
    const overlapOk = seq.length > 0 && p.start < t;
    const lateMin = p.start > env.nowMs && !overlapOk ? Math.max(0, Math.round((arrive - p.start) / MINUTE)) : 0;
    seq.push({ ...slot, pinned: { ...p, lateOkMin: Math.max(0, lateMin - FIXED_SLACK_MIN), overlapOk } });
    t = Math.max(t, p.end);
    if (dest) pos = dest;
  }
  return seq;
}

export function solve(
  pinned: Slot[],
  flexible: Block[],
  candidates: Record<string, Place[]>,
  env: SolverEnv,
  maxIterations = 40,
): SolveResult {
  const optionsByBlock = new Map<string, Option[]>();
  for (const b of flexible) optionsByBlock.set(b.id, optionsFor(b, candidates[b.id], env));

  const unscheduled: Block[] = [];
  const seq = pinSequence(pinned, env);

  // 1. Greedy insertion.
  let plan: Slot[] = seq;
  for (const block of insertionOrder(flexible)) {
    const best = bestInsertion(plan, block, optionsByBlock.get(block.id) ?? [], env);
    if (best) plan = best.seq;
    else unscheduled.push(block);
  }
  return improve(plan, unscheduled, optionsByBlock, env, maxIterations);
}

function improve(start: Slot[], unscheduled: Block[], optionsByBlock: Map<string, Option[]>, env: SolverEnv, maxIterations: number): SolveResult {
  let seq = start;
  // 2. Local search: relocate, re-place, re-size, and retry the unscheduled.
  let current = sequenceScore(simulate(seq, env)!, env);
  for (let iter = 0; iter < maxIterations; iter++) {
    let improved = false;

    for (let i = 0; i < seq.length; i++) {
      const slot = seq[i]!;
      if (slot.pinned) continue;
      const without = [...seq.slice(0, i), ...seq.slice(i + 1)];
      const best = bestInsertion(without, slot.block, optionsByBlock.get(slot.block.id) ?? [], env);
      if (best && best.score > current + 1e-6) {
        seq = best.seq;
        current = best.score;
        improved = true;
        break;
      }
    }

    if (!improved && unscheduled.length) {
      for (let u = 0; u < unscheduled.length; u++) {
        const block = unscheduled[u]!;
        const best = bestInsertion(seq, block, optionsByBlock.get(block.id) ?? [], env);
        if (best) {
          seq = best.seq;
          current = best.score;
          unscheduled.splice(u, 1);
          improved = true;
          break;
        }
      }
    }

    // Swap a lower-priority scheduled block for an unscheduled must.
    if (!improved) {
      const missingMust = unscheduled.find((b) => b.priority === 'must');
      if (missingMust) {
        for (let i = 0; i < seq.length && !improved; i++) {
          const slot = seq[i]!;
          if (slot.pinned || slot.block.priority === 'must') continue;
          const without = [...seq.slice(0, i), ...seq.slice(i + 1)];
          const best = bestInsertion(without, missingMust, optionsByBlock.get(missingMust.id) ?? [], env);
          if (best) {
            seq = best.seq;
            current = best.score;
            unscheduled.splice(unscheduled.indexOf(missingMust), 1, slot.block);
            improved = true;
          }
        }
      }
    }

    if (!improved) break;
  }

  return { seq, sim: simulate(seq, env)!, unscheduled, optionsByBlock };
}
