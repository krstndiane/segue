/**
 * "What can I realistically do instead?" for one item in today's plan.
 *
 * The rest of the day stays exactly as it is (every other item is held in
 * place, and commitments are never dropped), and each alternative is checked
 * by simulating the whole day: travel from where you'll actually be, the
 * place's listed hours, the next commitment, the item's own window, and the
 * weather. Only options that pass are offered; the rest are listed with the
 * hard reason they don't work. Every statement carries what it's based on, so
 * the app and the assistant can explain it without guessing.
 */
import { earliestOpenStart, openStatusAt, type OpenStatus } from './hours';
import { failsHardRequirement, isOutdoor, rainChanceAt, resolveWeights } from './score';
import { itemValue, makeEnv, pinSequence, simulate, type Option, type SimItem, type Slot, type SolverEnv } from './solver';
import { MINUTE, formatClock, toIso, toMs } from './time';
import type { Block, Context, LatLng, Place, PlaceCategory, PlaceRef, Plan, PlanItem, TravelFn } from './types';

export type AlternativeTrigger = 'rain' | 'closed' | 'late' | 'missed' | 'manual';

/**
 * hard: a constraint that makes something possible or impossible (open hours,
 * time before a commitment). preference: makes it better or worse. unknown:
 * something Segue can't confirm. tip: useful, optional.
 */
export type FactKind = 'hard' | 'preference' | 'unknown' | 'tip';
export interface Fact {
  kind: FactKind;
  text: string;
}

export type AlternativeKind = 'same-kind' | 'substitute' | 'no-place' | 'later' | 'shorter';

export interface AlternativeOption {
  /** stable within one result: kind + place + start */
  id: string;
  kind: AlternativeKind;
  /** "Work out at Core Studio instead" */
  label: string;
  blockId: string;
  title: string;
  category: PlaceCategory;
  start: string;
  end: string;
  minutes: number;
  travelMinutes: number;
  place?: PlaceRef & { source?: string; fetchedAt?: string };
  hours?: { status: OpenStatus; closesAt?: string | null; basis: 'listed-hours' | 'none' };
  /** the next commitment after it, and the minutes to spare after getting there */
  next?: { blockId: string; title: string; start: string; spareMinutes: number };
  rainChance?: number;
  /** one plain sentence: why this works */
  why: string;
  facts: Fact[];
  tradeoffs: string[];
}

export interface ExcludedAlternative {
  label: string;
  placeId?: string;
  reason: string;
}

export interface AlternativesResult {
  blockId: string;
  title: string;
  trigger: AlternativeTrigger;
  original?: { start: string; end: string; place?: PlaceRef };
  /** what is wrong with the original now, when something is */
  problem?: Fact;
  nextCommitment?: { blockId: string; title: string; start: string };
  options: AlternativeOption[];
  excluded: ExcludedAlternative[];
  /** what the answer rests on: forecast or not, listed hours, estimates */
  notes: Fact[];
}

export interface AlternativesInput {
  /** today's blocks, as given to reroute (calendar events included) */
  blocks: Block[];
  /** the plan the user has now */
  plan: Plan;
  blockId: string;
  context: Context;
  /** nearby places by category, for the item's own kind and its substitutes */
  places: Partial<Record<PlaceCategory, Place[]>>;
  trigger?: AlternativeTrigger;
  /** the user said it's raining (until about this time) */
  rainingUntil?: string;
  /** dangerous weather: nothing outdoors before this time */
  hazardUntil?: string;
  /** places the user turned down or that let them down today */
  avoidPlaceIds?: string[];
  /** "I only have 30 minutes" */
  maxMinutes?: number;
  doneBlockIds?: string[];
  travel?: TravelFn;
  /** at most this many options (default 4) */
  limit?: number;
}

export const CATEGORY_WORD: Record<PlaceCategory, string> = {
  none: 'place',
  cafe: 'café',
  cowork: 'coworking space',
  library: 'library',
  restaurant: 'place to eat',
  gym: 'gym',
  park: 'park',
  grocery: 'grocery',
  mall: 'mall',
};

export const DEFAULT_FALLBACK: Partial<Record<PlaceCategory, string>> = {
  cafe: 'Work from where you are (offline tasks)',
  cowork: 'Work from where you are (offline tasks)',
  library: 'Read or study where you are',
  gym: 'Bodyweight workout where you are',
  park: 'Walk around the block',
  restaurant: 'Grab takeout or a quick bite',
  grocery: 'Order delivery instead',
  mall: 'Do it online instead',
};

/**
 * Other kinds of place that serve the same purpose. Outdoor exercise moves
 * inside to a gym or a mall walk (common in the Philippines); studying works
 * at a library, café or coworking space.
 */
export const SUBSTITUTES: Partial<Record<PlaceCategory, PlaceCategory[]>> = {
  park: ['gym', 'mall'],
  cafe: ['library', 'cowork'],
  cowork: ['library', 'cafe'],
  library: ['cafe', 'cowork'],
  gym: [],
  restaurant: ['mall'],
  grocery: ['mall'],
};

const RAINY = 50;

interface Variant {
  kind: AlternativeKind;
  /** for a shorter option: what it is a shorter version of */
  from?: AlternativeKind;
  block: Block;
  option: Option;
  durations: number[];
  /** only start at or after this time (e.g. once the rain should have passed) */
  notBefore?: number;
}

interface Placed {
  variant: Variant;
  sim: SimItem[];
  item: SimItem;
  index: number;
  score: number;
}

function ref(p: Place): AlternativeOption['place'] {
  return { id: p.id, name: p.name, location: p.location, address: p.address, source: p.source, fetchedAt: p.fetchedAt };
}

function minutesWord(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** The plan as it stands, every item held where it is (done items and the target left out). */
function frame(input: AlternativesInput, env: SolverEnv, target: string): Slot[] {
  const done = new Set(input.doneBlockIds ?? []);
  const byId = new Map(input.blocks.map((b) => [b.id, b]));
  const held: Slot[] = [];
  for (const it of input.plan.items) {
    if (it.blockId === target || done.has(it.blockId)) continue;
    const start = toMs(it.start);
    const end = toMs(it.end);
    if (end <= env.nowMs) continue;
    const block = byId.get(it.blockId) ?? planItemBlock(it);
    held.push({ block, option: { fallback: !it.place && block.category !== 'none' }, durationMin: (end - start) / MINUTE, pinned: { start, end, place: it.place } });
  }
  return pinSequence(held, env);
}

function planItemBlock(it: PlanItem): Block {
  return { id: it.blockId, title: it.title, minMinutes: 1, maxMinutes: 1, priority: 'must', category: 'none', requirements: [] };
}

/** Points lost per hour away from when it was meant to happen: a reroute should change as little as it can. */
const SHIFT_PER_HOUR = 6;

/** Best feasible way to fit this variant into the held day, or null. */
function place(seq: Slot[], v: Variant, env: SolverEnv, referenceMs: number): Placed | null {
  let best: Placed | null = null;
  for (const durationMin of v.durations) {
    const block = v.notBefore ? { ...v.block, earliest: toIso(Math.max(v.notBefore, v.block.earliest ? toMs(v.block.earliest) : -Infinity)) } : v.block;
    for (let i = 0; i <= seq.length; i++) {
      const cand = [...seq.slice(0, i), { block, option: v.option, durationMin }, ...seq.slice(i)];
      const sim = simulate(cand, env);
      if (!sim) continue;
      const item = sim[i]!;
      // Score the option itself, plus a little for leaving the rest of the day undisturbed.
      const score = itemValue(item, env) - (Math.abs(item.start - referenceMs) / (60 * MINUTE)) * SHIFT_PER_HOUR;
      if (!best || score > best.score + 1e-9) best = { variant: v, sim, item, index: i, score };
    }
  }
  return best;
}

function durations(block: Block, cap?: number): number[] {
  const hi = Math.min(block.maxMinutes, cap ?? Infinity);
  const lo = Math.min(block.minMinutes, hi);
  const mid = Math.round((lo + hi) / 2 / 5) * 5;
  return [...new Set([hi, mid, lo])].filter((d) => d >= lo && d <= hi && d > 0);
}

/** Why a place can't work today, in one plain sentence. */
function whyNot(p: Place, block: Block, seq: Slot[], env: SolverEnv, input: AlternativesInput): string {
  const tz = env.context.utcOffsetMinutes;
  if (p.temporarilyClosed) return 'Listed as temporarily closed';
  const missing = block.requirements.filter((r) => p.attributes[r] === false);
  if (missing.length) return `Doesn't have ${missing.join(' or ')}, as far as the map says`;
  if ((input.avoidPlaceIds ?? []).includes(p.id)) return 'You turned it down earlier';
  const travel = env.travel(env.context.location, p.location, env.context.mode, env.nowMs);
  const arrive = env.nowMs + travel * MINUTE;
  const latest = Math.min(env.endMs, block.latest ? toMs(block.latest) : Infinity);
  if (arrive + block.minMinutes * MINUTE > latest) return `About ${travel} min away: too far to fit ${minutesWord(block.minMinutes)} before ${formatClock(latest, tz)}`;
  if (p.hours) {
    if (earliestOpenStart(p.hours, arrive, 1, latest, tz) === null) return 'Closed for the rest of today by its listed hours';
    if (earliestOpenStart(p.hours, arrive, block.minMinutes, latest, tz) === null) {
      const st = openStatusAt(p, arrive, tz);
      return st.status === 'open' && st.closesAt
        ? `Closes at ${formatClock(st.closesAt, tz)}, too soon for ${minutesWord(block.minMinutes)} after you'd arrive`
        : `Not open long enough for ${minutesWord(block.minMinutes)} today`;
    }
  }
  // It's open and reachable, so the day around it is what's in the way.
  const next = seq.find((s) => s.pinned && s.pinned.start > env.nowMs && s.block.fixed);
  if (next) return `Wouldn't leave time for ${next.block.title} at ${formatClock(next.pinned!.start, tz)}`;
  return `Not enough free time left today`;
}

function rainWindow(input: AlternativesInput, env: SolverEnv, from: number): { chance?: number; basis: 'reported' | 'forecast' | 'none' } {
  if (input.rainingUntil && from < toMs(input.rainingUntil)) return { chance: 100, basis: 'reported' };
  const c = rainChanceAt(env.context, from);
  return c === undefined ? { basis: 'none' } : { chance: c, basis: 'forecast' };
}

/** First time from `from` when rain looks unlikely (and no hazard), by the forecast. */
function drierFrom(input: AlternativesInput, env: SolverEnv, from: number): number | undefined {
  const reportedEnd = input.rainingUntil ? toMs(input.rainingUntil) : -Infinity;
  const hazardEnd = input.hazardUntil ? toMs(input.hazardUntil) : -Infinity;
  for (let t = Math.max(from, reportedEnd, hazardEnd); t < env.endMs; t += 30 * MINUTE) {
    const c = rainChanceAt(env.context, t);
    if (c === undefined) return undefined; // no forecast that far: don't promise
    if (c < RAINY) return t;
  }
  return undefined;
}

export function alternatives(input: AlternativesInput): AlternativesResult {
  const weights = resolveWeights();
  const env = makeEnv(input.context, weights, input.travel, undefined);
  const tz = env.context.utcOffsetMinutes;
  const clock = (ms: number) => formatClock(ms, tz);
  const trigger = input.trigger ?? 'manual';
  const block = input.blocks.find((b) => b.id === input.blockId);
  const planned = input.plan.items.find((i) => i.blockId === input.blockId);
  const title = block?.title ?? planned?.title ?? 'This';
  const notes: Fact[] = [];
  const result: AlternativesResult = { blockId: input.blockId, title, trigger, options: [], excluded: [], notes };
  if (planned) result.original = { start: planned.start, end: planned.end, place: planned.place };

  if (!block) {
    result.problem = { kind: 'hard', text: `${title} isn't in today's plan any more` };
    return result;
  }
  if (block.fixed) {
    result.problem = { kind: 'hard', text: `${title} is a set-time commitment, so Segue won't move or replace it` };
    return result;
  }

  const seq = frame(input, env, block.id);
  const avoid = new Set(input.avoidPlaceIds ?? []);
  const outdoor = isOutdoor(block);
  const hazard = input.hazardUntil ? toMs(input.hazardUntil) : undefined;
  const nextFixed = seq.find((s) => s.pinned && s.pinned.start > env.nowMs && s.block.fixed);
  if (nextFixed) result.nextCommitment = { blockId: nextFixed.block.id, title: nextFixed.block.title, start: toIso(nextFixed.pinned!.start) };

  // What's wrong with the original now?
  const origStart = planned ? toMs(planned.start) : undefined;
  const origPlace = planned?.place ? input.places[block.category]?.find((p) => p.id === planned.place!.id) : undefined;
  if (outdoor && hazard && origStart !== undefined && origStart < hazard) {
    result.problem = { kind: 'hard', text: `Dangerous weather is expected until about ${clock(hazard)}, so outdoor plans aren't safe` };
  } else if (outdoor && origStart !== undefined && trigger === 'rain') {
    const r = rainWindow(input, env, Math.max(origStart, env.nowMs));
    const when = clock(Math.max(origStart, env.nowMs));
    result.problem =
      r.basis === 'reported'
        ? { kind: 'preference', text: `You said it's raining, and ${title} is outdoors` }
        : r.basis === 'forecast' && (r.chance ?? 0) >= RAINY
          ? { kind: 'preference', text: `${r.chance}% chance of rain around ${when} (forecast), and ${title} is outdoors` }
          : r.basis === 'forecast'
            ? { kind: 'tip', text: `${title} is planned for ${when}, when rain looks unlikely (${r.chance}%, forecast)` }
            : { kind: 'unknown', text: `No current forecast, so Segue can't confirm the rain; ${title} is outdoors` };
  } else if (origPlace && origStart !== undefined && origPlace.hours) {
    const st = openStatusAt(origPlace, origStart, tz);
    if (st.status === 'closed' || st.status === 'temporarily-closed') result.problem = { kind: 'hard', text: `${origPlace.name} is closed at ${clock(origStart)} by its listed hours` };
  } else if (origPlace?.temporarilyClosed) {
    result.problem = { kind: 'hard', text: `${origPlace.name} is listed as temporarily closed` };
  }
  if (!result.problem && planned && toMs(planned.end) <= env.nowMs) result.problem = { kind: 'hard', text: `Its time (${clock(toMs(planned.start))}) has passed` };
  if (!result.problem && trigger === 'closed' && planned?.place) result.problem = { kind: 'hard', text: `You said ${planned.place.name} isn't available` };
  if (trigger === 'closed' && planned?.place) avoid.add(planned.place.id);

  // Build the variants worth trying.
  const variants: Variant[] = [];
  const cap = input.maxMinutes;
  const rainMatters = outdoor && (trigger === 'rain' || !!hazard);
  const add = (kind: AlternativeKind, b: Block, option: Option, notBefore?: number) =>
    variants.push({ kind, block: b, option, durations: durations(b, cap), notBefore });

  const sameKind = block.category === 'none' ? [] : (input.places[block.category] ?? []);
  const considered: { p: Place; b: Block }[] = [];
  if (block.category === 'none') {
    add('same-kind', block, { fallback: false });
  } else {
    // Same kind of place (unless rain is the problem and it's outdoors).
    if (!rainMatters) {
      for (const p of sameKind) {
        considered.push({ p, b: block });
        if (avoid.has(p.id) || failsHardRequirement(block, p)) continue;
        add('same-kind', block, { place: p, fallback: false });
      }
    }
    // Other kinds of place that do the same job.
    for (const cat of SUBSTITUTES[block.category] ?? []) {
      const b: Block = { ...block, category: cat, requirements: block.requirements.filter((r) => r !== 'outdoor') };
      for (const p of input.places[cat] ?? []) {
        considered.push({ p, b });
        if (avoid.has(p.id) || failsHardRequirement(b, p)) continue;
        add('substitute', b, { place: p, fallback: false });
      }
    }
    // The no-place version: home workout, work where you are.
    add('no-place', { ...block, requirements: [] }, { fallback: true });
    // Same plan, once the rain should have passed (only when the forecast says so).
    if (rainMatters) {
      const dry = drierFrom(input, env, env.nowMs);
      if (dry !== undefined) {
        for (const p of sameKind) if (!avoid.has(p.id) && !failsHardRequirement(block, p)) add('later', block, { place: p, fallback: false }, dry);
      }
    }
  }

  // Place each variant and keep what fits, as close as possible to when it was meant to be.
  const reference = Math.max(env.nowMs, origStart ?? env.nowMs);
  const placed: Placed[] = [];
  for (const v of variants) {
    const best = place(seq, v, env, reference);
    if (!best) continue;
    if (rainMatters && hazard && v.kind !== 'substitute' && v.kind !== 'no-place' && isOutdoor(v.block) && best.item.start < hazard) continue;
    placed.push(best);
  }

  // Nothing fits at full length before the next commitment? Offer a shorter one.
  const fitsBeforeNext = (p: Placed) => !nextFixed || p.item.end <= nextFixed.pinned!.start;
  if (block.minMinutes > 15 && !placed.some(fitsBeforeNext) && nextFixed) {
    const short = Math.max(15, Math.round(block.minMinutes / 2 / 5) * 5);
    const pool = variants.filter((v) => v.kind !== 'later');
    const before = toIso(nextFixed.pinned!.start);
    for (const v of pool) {
      const latest = v.block.latest && toMs(v.block.latest) < nextFixed.pinned!.start ? v.block.latest : before;
      const sv: Variant = { ...v, kind: 'shorter', from: v.kind, block: { ...v.block, minMinutes: short, maxMinutes: Math.min(block.minMinutes - 5, v.block.maxMinutes), latest }, durations: [] };
      sv.durations = durations(sv.block, cap);
      const best = place(seq, sv, env, reference);
      if (best && fitsBeforeNext(best)) placed.push(best);
    }
  }

  // Excluded places: the ones a person would think of, with the hard reason.
  const placedIds = new Set(placed.map((p) => p.variant.option.place?.id).filter(Boolean));
  const seenExcluded = new Set<string>();
  for (const { p, b } of considered.sort((x, y) => (x.p.id === planned?.place?.id ? -1 : y.p.id === planned?.place?.id ? 1 : 0))) {
    if (placedIds.has(p.id) || seenExcluded.has(p.id)) continue;
    seenExcluded.add(p.id);
    result.excluded.push({ label: p.name, placeId: p.id, reason: whyNot(p, b, seq, env, input) });
  }
  result.excluded = result.excluded.slice(0, 6);

  // Pick a small, varied set: the best of each kind, then the best of the rest.
  placed.sort((a, b) => b.score - a.score || a.item.start - b.item.start);
  const chosen: Placed[] = [];
  const usedPlaces = new Set<string>();
  const take = (p: Placed) => {
    const id = p.variant.option.place?.id ?? `${p.variant.kind}:none`;
    if (usedPlaces.has(id) && p.variant.kind !== 'later' && p.variant.kind !== 'shorter') return;
    if (chosen.some((c) => c.variant.kind === p.variant.kind && (c.variant.option.place?.id ?? '') === (p.variant.option.place?.id ?? ''))) return;
    usedPlaces.add(id);
    chosen.push(p);
  };
  const limit = input.limit ?? 4;
  const order: AlternativeKind[] = rainMatters ? ['substitute', 'no-place', 'later', 'shorter', 'same-kind'] : ['same-kind', 'substitute', 'no-place', 'later', 'shorter'];
  for (const kind of order) {
    const first = placed.find((p) => p.variant.kind === kind);
    if (first) take(first);
  }
  for (const p of placed) if (chosen.length < limit) take(p);
  chosen.sort((a, b) => b.score - a.score || a.item.start - b.item.start);

  result.options = chosen.slice(0, limit).map((p) => describe(p, { input, env, block, planned, nextFixed, hazard, rainMatters }));

  // What the answer rests on.
  if (!input.context.weather?.length)
    notes.push({ kind: 'unknown', text: input.rainingUntil ? "No current forecast, so Segue can't say when the rain will stop" : "No current forecast, so rain isn't factored in" });
  if (result.options.some((o) => o.place)) notes.push({ kind: 'unknown', text: 'Opening times are the places\' listed hours, not live availability' });
  if (result.options.some((o) => o.travelMinutes > 0)) notes.push({ kind: 'unknown', text: 'Travel times are estimates (rush hour included), not live traffic' });
  if (!result.options.length) {
    notes.push({
      kind: 'hard',
      text:
        block.category === 'none'
          ? `There's no free stretch of ${minutesWord(block.minMinutes)} left today around your other plans`
          : `Nothing nearby fits today, and there isn't time for the no-place version either`,
    });
  }
  return result;
}

function describe(
  p: Placed,
  ctx: { input: AlternativesInput; env: SolverEnv; block: Block; planned?: PlanItem; nextFixed?: Slot; hazard?: number; rainMatters: boolean },
): AlternativeOption {
  const { env, block, planned, input, rainMatters } = ctx;
  const base = p.variant.kind === 'shorter' ? (p.variant.from ?? 'same-kind') : p.variant.kind;
  const tz = env.context.utcOffsetMinutes;
  const clock = (ms: number) => formatClock(ms, tz);
  const { item, variant, sim, index } = p;
  const place = variant.option.place;
  const minutes = Math.round((item.end - item.start) / MINUTE);
  const facts: Fact[] = [];
  const tradeoffs: string[] = [];

  let hours: AlternativeOption['hours'];
  if (place) {
    const st = openStatusAt(place, item.start, tz);
    hours = { status: st.status, closesAt: st.closesAt === undefined ? undefined : st.closesAt === null ? null : toIso(st.closesAt), basis: place.hours ? 'listed-hours' : 'none' };
    if (place.hours) {
      facts.push({
        kind: 'hard',
        text: st.closesAt === null ? `Open 24 hours by its listed hours` : `Open from ${clock(item.start)} until ${st.closesAt ? clock(st.closesAt) : 'late'} by its listed hours`,
      });
    } else facts.push({ kind: 'unknown', text: `Opening hours aren't listed, so check before you go` });
  }
  if (item.travelMin > 0) facts.push({ kind: 'preference', text: `About ${item.travelMin} min to get there (estimate)` });
  else if (!place) facts.push({ kind: 'preference', text: `No trip needed` });

  // The next commitment and how much room is left before it.
  let next: AlternativeOption['next'];
  const afterIdx = sim.findIndex((s, i) => i > index && s.slot.pinned && s.slot.block.fixed);
  const after = afterIdx >= 0 ? sim[afterIdx] : undefined;
  if (after) {
    // Arrival at the commitment: the end of whatever comes just before it, plus the trip.
    const spare = Math.round((after.start - (sim[afterIdx - 1]!.end + after.travelMin * MINUTE)) / MINUTE);
    next = { blockId: after.slot.block.id, title: after.slot.block.title, start: toIso(after.start), spareMinutes: Math.max(0, spare) };
    facts.push({ kind: 'hard', text: spare <= 0 ? `Gets you to ${after.slot.block.title} at ${clock(after.start)} just in time` : `Leaves ${minutesWord(spare)} before ${after.slot.block.title} at ${clock(after.start)}` });
  }
  if (block.latest) facts.push({ kind: 'hard', text: `Finishes by ${clock(toMs(block.latest))}, as you wanted` });

  // Weather.
  let rainChance: number | undefined;
  if (isOutdoor(variant.block) && !variant.option.fallback) {
    const r = rainWindow(input, env, item.start);
    rainChance = r.chance;
    if (r.basis === 'forecast' && r.chance !== undefined) facts.push({ kind: r.chance >= RAINY ? 'preference' : 'tip', text: `${r.chance}% chance of rain at ${clock(item.start)} (forecast)` });
    if (r.basis === 'none') facts.push({ kind: 'unknown', text: `No forecast for ${clock(item.start)} yet` });
  } else if (isOutdoor(block) && rainMatters && (base === 'substitute' || base === 'no-place')) {
    facts.push({ kind: 'preference', text: 'Indoors, so the rain doesn\'t matter' });
  }

  // What changes compared with the plan.
  if (minutes < block.minMinutes) tradeoffs.push(`${minutesWord(minutes)} instead of ${minutesWord(block.minMinutes)}`);
  if (planned) {
    const shift = Math.round((item.start - toMs(planned.start)) / MINUTE);
    if (shift >= 15) tradeoffs.push(`Starts ${minutesWord(shift)} later than planned`);
    const before = planned.travelMinutesBefore;
    if (item.travelMin > before + 10) tradeoffs.push(`A ${item.travelMin}-min trip instead of ${before ? `${before} min` : 'none'}`);
  }
  if (base === 'substitute') tradeoffs.push(`A ${CATEGORY_WORD[variant.block.category]} instead of a ${CATEGORY_WORD[block.category]}`);
  if (base === 'no-place') tradeoffs.push(block.category === 'gym' || block.category === 'park' ? 'No equipment or trip, so a lighter session' : `Without a ${CATEGORY_WORD[block.category]}`);

  const indoorAtHome = isOutdoor(block) && rainMatters;
  const noPlace = indoorAtHome
    ? block.category === 'park' ? 'Indoor workout where you are' : `${block.title} indoors where you are`
    : (block.fallback ?? DEFAULT_FALLBACK[block.category] ?? `${block.title} where you are`);
  const what = (cat: PlaceCategory) => (cat === 'gym' && block.category !== 'gym' ? 'workout' : cat === 'mall' && block.category === 'park' ? 'indoor walk' : block.title.toLowerCase());
  const label =
    variant.kind === 'shorter'
      ? base === 'no-place'
        ? `A shorter version where you are (${minutesWord(minutes)})`
        : `A shorter ${what(variant.block.category)}${place ? ` at ${place.name}` : ''} (${minutesWord(minutes)})`
      : variant.kind === 'no-place'
        ? noPlace
        : variant.kind === 'substitute' && place
          ? variant.block.category === 'gym' && block.category !== 'gym'
            ? `Work out at ${place.name} instead`
            : variant.block.category === 'mall' && block.category === 'park'
              ? `Walk indoors at ${place.name}`
              : `${block.title} at ${place.name} instead`
          : variant.kind === 'later'
            ? `${block.title}${place ? ` at ${place.name}` : ''} at ${clock(item.start)}, when it should be drier`
            : place
              ? `${block.title} at ${place.name}`
              : `${block.title} at ${clock(item.start)}`;

  const why = [facts.find((f) => f.kind === 'hard' && f.text.startsWith('Open'))?.text, next ? facts.find((f) => f.text.includes(next!.title))?.text : undefined, variant.kind === 'later' ? facts.find((f) => f.text.includes('rain'))?.text : undefined, !place ? 'no trip needed' : undefined]
    .filter(Boolean)
    .map((t, i) => (i === 0 ? t! : t!.charAt(0).toLowerCase() + t!.slice(1)))
    .join('; ');

  return {
    id: `${variant.kind}:${place?.id ?? 'none'}:${item.start}`,
    kind: variant.kind,
    label,
    blockId: block.id,
    title: block.title,
    category: variant.option.fallback ? 'none' : variant.block.category,
    start: toIso(item.start),
    end: toIso(item.end),
    minutes,
    travelMinutes: item.travelMin,
    place: place ? ref(place) : undefined,
    hours,
    next,
    rainChance,
    why: why ? why.charAt(0).toUpperCase() + why.slice(1) : `Fits at ${clock(item.start)}`,
    facts,
    tradeoffs,
  };
}

/** Where you'll be just before an item: the previous stop with a place, or where you are now. */
export function originBefore(plan: Plan, blockId: string, here: LatLng, nowMs: number): LatLng {
  let at = here;
  for (const it of plan.items) {
    if (it.blockId === blockId) break;
    // A stop you'll still be at, or go to, before this item.
    if (it.place && toMs(it.end) > nowMs) at = it.place.location;
  }
  return at;
}

