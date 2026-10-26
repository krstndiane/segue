import { localParts, toMs, HOUR } from './time';
import type { Block, Context, Energy, Place, Weights } from './types';

export const DEFAULT_WEIGHTS: Weights = {
  priority: { must: 100, should: 40, nice: 15 },
  travelPerMinute: 0.6,
  fitShare: 0.4,
  quality: 6,
  affinity: 12,
  unconfirmedHours: 3,
  rain: 35,
  energyMismatch: 10,
  timePref: 8,
  missingMust: 250,
};

export function resolveWeights(partial?: Partial<Weights>): Weights {
  return {
    ...DEFAULT_WEIGHTS,
    ...partial,
    priority: { ...DEFAULT_WEIGHTS.priority, ...partial?.priority },
  };
}

/** True when the place is known NOT to offer something the block needs. */
export function failsHardRequirement(block: Block, place: Place): boolean {
  return place.temporarilyClosed === true || block.requirements.some((r) => place.attributes[r] === false);
}

/** 0–1: share of requirements the place is known to meet (unknown counts half). */
export function fitScore(block: Block, place: Place | undefined): number {
  if (!place || block.requirements.length === 0) return 1;
  let total = 0;
  for (const r of block.requirements) {
    const v = place.attributes[r];
    total += v === true ? 1 : v === undefined ? 0.5 : 0;
  }
  return total / block.requirements.length;
}

/**
 * -1…1 quality signal from rating, damped when there are few reviews
 * so one 5-star review doesn't beat a well-loved 4.5.
 */
export function qualityScore(place: Place | undefined): number {
  if (!place || place.rating === undefined) return 0;
  const centred = (place.rating - 3.5) / 1.5;
  const confidence = Math.min(1, Math.log10((place.reviewCount ?? 0) + 1) / 2.5);
  return Math.max(-1, Math.min(1, centred * confidence));
}

export function isOutdoor(block: Block): boolean {
  return block.category === 'park' || block.requirements.includes('outdoor');
}

/** Precipitation probability (0–100) for the hour containing `ms`, if known. */
export function rainChanceAt(context: Context, ms: number): number | undefined {
  if (!context.weather?.length) return undefined;
  let best: { diff: number; p: number } | undefined;
  for (const h of context.weather) {
    const diff = ms - toMs(h.time);
    if (diff >= 0 && diff < HOUR && (!best || diff < best.diff)) best = { diff, p: h.precipitationProbability };
  }
  return best?.p;
}

const ENERGY_LEVEL: Record<Energy, number> = { low: 0, medium: 1, high: 2 };

export function energyPenalty(block: Block, context: Context, startMs: number, w: Weights): number {
  if (!block.energy) return 0;
  const gap = ENERGY_LEVEL[block.energy] - ENERGY_LEVEL[context.energy];
  if (gap <= 0) return 0;
  // Demanding blocks hurt more late in the day.
  const { minutes } = localParts(startMs, context.utcOffsetMinutes);
  const lateFactor = minutes >= 18 * 60 ? 1.5 : 1;
  return w.energyMismatch * gap * lateFactor;
}

export function timePrefPenalty(block: Block, context: Context, startMs: number, w: Weights): number {
  if (!block.timePref) return 0;
  const { minutes } = localParts(startMs, context.utcOffsetMinutes);
  const h = minutes / 60;
  const inside =
    (block.timePref === 'morning' && h < 12) ||
    (block.timePref === 'afternoon' && h >= 12 && h < 17) ||
    (block.timePref === 'evening' && h >= 17);
  return inside ? 0 : w.timePref;
}

/** Ranking used to pick which candidates are worth trying for a block. */
export function staticCandidateScore(
  block: Block,
  place: Place,
  travelMin: number,
  affinity: Record<string, number> | undefined,
  w: Weights,
): number {
  return (
    fitScore(block, place) * 20 +
    qualityScore(place) * w.quality +
    (affinity?.[place.id] ?? 0) * w.affinity -
    travelMin * w.travelPerMinute -
    (place.hours ? 0 : w.unconfirmedHours)
  );
}
