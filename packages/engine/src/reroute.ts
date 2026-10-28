import { CATEGORY_WORD, DEFAULT_FALLBACK } from './alternatives';
import { earliestOpenStart, isOpenThroughout } from './hours';
import { resolveWeights, failsHardRequirement, isOutdoor, rainChanceAt } from './score';
import { itemValue, makeEnv, simulate, solve, type Option, type SimItem, type Slot, type SolverEnv } from './solver';
import { MINUTE, formatClock, toIso, toMs } from './time';
import type {
  Block,
  Change,
  FallbackOption,
  Place,
  PlaceRef,
  Plan,
  PlanItem,
  RerouteInput,
  RerouteResult,
  Unscheduled,
  Weights,
} from './types';

function toRef(p: Place): PlaceRef {
  return { id: p.id, name: p.name, location: p.location, address: p.address };
}

function signature(plan: Plan): string {
  return plan.items.map((i) => `${i.blockId}@${i.start}@${i.place?.id ?? '-'}`).join('|');
}

/** Pinned slots: fixed blocks plus items the user locked from the previous plan. */
function pinnedSlots(input: RerouteInput, active: Block[], nowMs: number): { pinned: Slot[]; flexible: Block[] } {
  const locked = new Set(input.lockedBlockIds ?? []);
  const prevById = new Map(input.previous?.items.map((i) => [i.blockId, i]) ?? []);
  const pinned: Slot[] = [];
  const flexible: Block[] = [];

  for (const b of active) {
    if (b.fixed) {
      const start = toMs(b.fixed.start);
      const end = toMs(b.fixed.end);
      if (end <= nowMs) continue; // already over
      const place: PlaceRef | undefined = b.fixed.location
        ? { id: `fixed:${b.id}`, name: b.fixed.placeName ?? b.title, location: b.fixed.location }
        : undefined;
      pinned.push({ block: b, option: { fallback: false }, durationMin: (end - start) / MINUTE, pinned: { start, end, place } });
      continue;
    }
    const prev = prevById.get(b.id);
    if (locked.has(b.id) && prev) {
      const start = toMs(prev.start);
      const end = toMs(prev.end);
      if (end > nowMs) {
        pinned.push({
          block: b,
          option: { fallback: !prev.place && b.category !== 'none' },
          durationMin: (end - start) / MINUTE,
          pinned: { start, end, place: prev.place },
        });
        continue;
      }
    }
    flexible.push(b);
  }
  return { pinned, flexible };
}

function fallbacksFor(item: SimItem, options: Option[] | undefined, env: SolverEnv, prevLoc: SimItem['location']): FallbackOption[] {
  const b = item.slot.block;
  const out: FallbackOption[] = [];
  if (b.category === 'none') return out;
  const chosenId = item.slot.option.place?.id;
  const chosenTravel = item.travelMin;
  for (const opt of options ?? []) {
    if (out.length >= 2) break;
    const p = opt.place;
    if (!p || p.id === chosenId) continue;
    if (p.hours && !isOpenThroughout(p.hours, item.start, item.end, env.context.utcOffsetMinutes)) continue;
    const t = env.travel(prevLoc ?? env.context.location, p.location, env.context.mode);
    if (t > chosenTravel + 15) continue;
    out.push({ kind: 'place', place: toRef(p), label: `${p.name} · ${t} min away` });
  }
  if (!item.slot.option.fallback) {
    out.push({ kind: 'no-place', label: b.fallback ?? DEFAULT_FALLBACK[b.category] ?? 'Skip it today' });
  }
  return out;
}

function notesFor(item: SimItem, env: SolverEnv): string | undefined {
  const tz = env.context.utcOffsetMinutes;
  const b = item.slot.block;
  const place = item.slot.option.place;
  if (item.slot.option.fallback) {
    return `No ${CATEGORY_WORD[b.category] ?? 'place'} fits right now, so this runs as: ${b.fallback ?? DEFAULT_FALLBACK[b.category] ?? 'a no-place version'}`;
  }
  if (item.waitedForOpen && place) return `Starts when ${place.name} opens at ${formatClock(item.start, tz)}`;
  if (isOutdoor(b)) {
    const rain = rainChanceAt(env.context, item.start);
    if (rain !== undefined && rain >= 50) return `${rain}% chance of rain around then`;
  }
  if (place && !place.hours) return 'Opening hours not confirmed — check before you go';
  return undefined;
}

function buildPlan(label: string, items: SimItem[], unscheduledBlocks: Block[], options: Map<string, Option[]>, env: SolverEnv, candidates: Record<string, Place[]>): Plan {
  const tz = env.context.utcOffsetMinutes;
  const planItems: PlanItem[] = items.map((it, idx) => {
    const prevLoc = idx > 0 ? items[idx - 1]!.location : env.context.location;
    const place = it.slot.pinned?.place ?? (it.slot.option.place ? toRef(it.slot.option.place) : undefined);
    const confidence = !place
      ? 'no-place'
      : it.slot.pinned
        ? 'verified'
        : it.slot.option.place?.hours
          ? 'verified'
          : 'unconfirmed';
    return {
      blockId: it.slot.block.id,
      title: it.slot.block.title,
      start: toIso(it.start),
      end: toIso(it.end),
      place,
      travelMinutesBefore: it.travelMin,
      confidence,
      fixed: Boolean(it.slot.block.fixed),
      fallbacks: it.slot.pinned ? [] : fallbacksFor(it, options.get(it.slot.block.id), env, prevLoc),
      explanation: it.slot.pinned ? undefined : notesFor(it, env),
    };
  });

  // Commitments that can't be kept cleanly stay in the plan, with a plain reason.
  const range = (it: SimItem) => `${formatClock(it.start, tz)}–${formatClock(it.end, tz)}`;
  const flag = (idx: number, text: string) => {
    const item = planItems[idx]!;
    item.conflict = item.conflict ? `${item.conflict}. ${text}` : text;
  };
  items.forEach((it, idx) => {
    if (!it.slot.pinned) return;
    const late = it.lateMin ?? 0;
    if (late > 5) {
      const length = Math.round((it.end - it.start) / MINUTE);
      flag(idx, late >= length ? `You can't get there before it ends at ${formatClock(it.end, tz)}` : `You can't get there by ${formatClock(it.start, tz)}: about ${late} min late`);
    }
    if (it.overlapsPrevious) {
      // Find the commitment it runs into (the latest-ending one before it).
      let j = idx - 1;
      for (let k = idx - 2; k >= 0; k--) if (items[k]!.end > items[j]!.end) j = k;
      const other = items[j]!;
      flag(idx, `Overlaps ${other.slot.block.title} (${range(other)})`);
      flag(j, `Overlaps ${it.slot.block.title} (${range(it)})`);
    }
  });

  const unscheduled: Unscheduled[] = unscheduledBlocks.map((b) => {
    const usable = (candidates[b.id] ?? []).filter((p) => !failsHardRequirement(b, p));
    const latest = b.latest ? toMs(b.latest) : undefined;
    const word = CATEGORY_WORD[b.category] ?? 'place';
    const windowEnd = Math.min(env.endMs, latest ?? Infinity);
    const opensFor = (p: Place, minutes: number) => earliestOpenStart(p.hours!, env.nowMs, minutes, windowEnd, env.context.utcOffsetMinutes) !== null;
    let reason: string;
    if (b.fixed) reason = 'Clashes with another fixed block';
    else if (latest !== undefined && latest <= env.nowMs) reason = `Its window ended at ${formatClock(latest, tz)}`;
    else if (latest !== undefined && latest < env.endMs && latest - b.minMinutes * MINUTE < env.nowMs)
      reason = `Needs ${b.minMinutes} min, but only ${Math.max(0, Math.round((latest - env.nowMs) / MINUTE))} min left before ${formatClock(latest, tz)}`;
    else if (b.category !== 'none' && usable.length === 0 && !b.fallback)
      reason = `No ${word} nearby fits${b.requirements.length ? ` (needs ${b.requirements.join(', ')})` : ''}`;
    else if (b.category !== 'none' && !b.fallback && usable.length > 0 && usable.every((p) => p.hours && !opensFor(p, 5))) {
      reason = `Every ${word} nearby is closed for the rest of ${latest !== undefined && latest < env.endMs ? 'its window' : 'today'}`;
    } else if (b.category !== 'none' && !b.fallback && usable.length > 0 && usable.every((p) => p.hours && !opensFor(p, b.minMinutes)))
      reason = `No ${word} nearby stays open long enough (needs ${b.minMinutes} min)`;
    else reason = `Not enough time left before ${formatClock(windowEnd, tz)}`;
    return { blockId: b.id, title: b.title, reason };
  });

  return {
    label,
    items: planItems,
    unscheduled,
    score: 0, // filled in by runOnce on shared weights
    totalTravelMinutes: items.reduce((s, it) => s + it.travelMin, 0),
  };
}

export function diffPlans(previous: Plan | undefined, next: Plan, utcOffsetMinutes: number, done: Set<string>): Change[] {
  if (!previous) return [];
  const prev = new Map(previous.items.map((i) => [i.blockId, i]));
  const nextMap = new Map(next.items.map((i) => [i.blockId, i]));
  const changes: Change[] = [];
  const clock = (iso: string) => formatClock(toMs(iso), utcOffsetMinutes);

  for (const item of next.items) {
    const old = prev.get(item.blockId);
    if (!old) {
      changes.push({ blockId: item.blockId, title: item.title, kind: 'added', message: `Added at ${clock(item.start)}` });
      continue;
    }
    if ((old.place?.id ?? null) !== (item.place?.id ?? null)) {
      const to = item.place ? item.place.name : 'a no-place option';
      changes.push({
        blockId: item.blockId,
        title: item.title,
        kind: 'place-changed',
        message: `Switched to ${to}${old.place ? ` (was ${old.place.name})` : ''}, ${clock(item.start)}`,
      });
      continue;
    }
    if (Math.abs(toMs(old.start) - toMs(item.start)) >= 10 * MINUTE) {
      changes.push({ blockId: item.blockId, title: item.title, kind: 'moved', message: `Moved from ${clock(old.start)} to ${clock(item.start)}` });
      continue;
    }
    changes.push({ blockId: item.blockId, title: item.title, kind: 'unchanged', message: `Still at ${clock(item.start)}` });
  }
  for (const old of previous.items) {
    if (nextMap.has(old.blockId) || done.has(old.blockId)) continue;
    const reason = next.unscheduled.find((u) => u.blockId === old.blockId)?.reason;
    changes.push({ blockId: old.blockId, title: old.title, kind: 'removed', message: reason ? `Dropped — ${reason}` : 'Dropped' });
  }
  return changes;
}

const PRESETS: { label: string; weights: (w: Weights) => Partial<Weights> }[] = [
  { label: 'Balanced', weights: () => ({}) },
  { label: 'Less travel', weights: (w) => ({ travelPerMinute: w.travelPerMinute * 4 }) },
  {
    label: 'Get more done',
    weights: (w) => ({ priority: { must: w.priority.must, should: 70, nice: 45 }, travelPerMinute: w.travelPerMinute * 0.6 }),
  },
];

function runOnce(input: RerouteInput, label: string, weights: Weights) {
  const env = makeEnv(input.context, weights, input.travel, input.affinity);
  const done = new Set(input.doneBlockIds ?? []);
  const active = input.blocks.filter((b) => !done.has(b.id));
  const { pinned, flexible } = pinnedSlots(input, active, env.nowMs);
  const result = solve(pinned, flexible, input.candidates, env, input.maxIterations);
  const plan = buildPlan(label, result.sim, result.unscheduled, result.optionsByBlock, env, input.candidates);
  // Score on the shared default weights so alternatives are comparable.
  const scoringEnv = makeEnv(input.context, resolveWeights(input.weights), input.travel, input.affinity);
  const sim = simulate(result.seq, scoringEnv) ?? result.sim;
  plan.score = Math.round(
    sim.reduce((s, it) => s + itemValue(it, scoringEnv), 0) -
      result.unscheduled.filter((b) => b.priority === 'must').length * scoringEnv.weights.missingMust,
  );
  return plan;
}

/**
 * Rebuild the rest of the day.
 *
 * Returns the best plan, up to two meaningfully different alternatives,
 * and a per-block list of what changed since `previous`.
 */
export function reroute(input: RerouteInput): RerouteResult {
  const base = resolveWeights(input.weights);
  const plans = PRESETS.map((p) => {
    const tweak = p.weights(base);
    return runOnce(input, p.label, { ...base, ...tweak, priority: { ...base.priority, ...tweak.priority } });
  });
  const [main, ...rest] = plans as [Plan, ...Plan[]];
  const seen = new Set([signature(main)]);
  const alternatives: Plan[] = [];
  for (const p of rest) {
    const sig = signature(p);
    if (seen.has(sig)) continue;
    seen.add(sig);
    alternatives.push(p);
  }

  const done = new Set(input.doneBlockIds ?? []);
  const changes = diffPlans(input.previous, main, input.context.utcOffsetMinutes, done);
  // Surface the change reason on the item itself when nothing more specific is there.
  for (const c of changes) {
    if (c.kind === 'unchanged' || c.kind === 'removed') continue;
    const item = main.items.find((i) => i.blockId === c.blockId);
    if (item) item.explanation = item.explanation ? `${c.message}. ${item.explanation}` : c.message;
  }
  return { plan: main, alternatives, changes };
}
