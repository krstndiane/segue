/**
 * The re-route flow, online or off:
 *   1. Ask the API (it finds nearby places, checks weather, runs the engine).
 *   2. If that fails, run the same engine on the phone against the places
 *      cached from the last successful call. Hours can't be re-verified, but
 *      the user still gets a plan in under a second.
 */
import { haversineMeters, reroute, type Block, type Context, type Place, type Plan, type RerouteResult } from '@segue/engine';
import { localDate, plannedToday, toEngineBlock, type DayState, type FavoritePlace, type PlaceCache, type StoredBlock } from './model';

export const API_URL: string = (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:8787';

export interface RerouteOutcome extends RerouteResult {
  source: 'server' | 'device';
  warnings: string[];
  /** fresh places to cache, when the server sent them */
  placeCache?: PlaceCache;
}

interface ServerResponse extends RerouteResult {
  candidates: Record<string, Place[]>;
  meta: { warnings: string[]; placesProvider?: string };
}

/** Cached places are only trusted within this distance of where they were fetched. */
const CACHE_RADIUS_M = 8000;

function cacheFromCandidates(blocks: StoredBlock[], candidates: Record<string, Place[]>, ctx: Context, mockServer: boolean): PlaceCache {
  const byCategory: PlaceCache['byCategory'] = {};
  for (const b of blocks) {
    const list = candidates[b.id];
    if (list?.length) byCategory[b.category] = list;
  }
  return { savedAt: new Date().toISOString(), location: ctx.location, byCategory, ...(mockServer ? { mock: true } : {}) };
}

/**
 * Made-up places are only for a server openly running in mock mode (local
 * development). Older versions of the live server could fall back to them, so
 * any saved on a phone from then are ignored.
 */
export const trustedPlaces = (places: Place[], cache: Pick<PlaceCache, 'mock'> | undefined) => (cache?.mock ? places : places.filter((p) => p.source !== 'mock'));

function candidatesFromCache(blocks: StoredBlock[], cache: PlaceCache | undefined, ctx: Context, favorites: FavoritePlace[]): Record<string, Place[]> {
  const out: Record<string, Place[]> = {};
  const near = !!cache && haversineMeters(cache.location, ctx.location) <= CACHE_RADIUS_M;
  for (const b of blocks) {
    if (b.fixedStart || b.category === 'none') continue;
    const mine = favorites.filter((f) => f.category === b.category);
    const cached = near ? trustedPlaces(cache!.byCategory[b.category] ?? [], cache) : [];
    out[b.id] = [...mine, ...cached.filter((p) => !mine.some((f) => f.id === p.id))];
  }
  return out;
}

export async function rerouteDay(opts: {
  blocks: StoredBlock[];
  context: Context;
  day: DayState;
  placeCache?: PlaceCache;
  forceOffline?: boolean;
  /** already-dated blocks from elsewhere, e.g. Google Calendar events */
  extraBlocks?: Block[];
  /** 0..1 preference per place id (favourites and history) */
  affinity?: Record<string, number>;
  /** "My spots": always considered for blocks of their kind */
  favorites?: FavoritePlace[];
}): Promise<RerouteOutcome> {
  const now = new Date(opts.context.now);
  const active = opts.blocks.filter((b) => plannedToday(b, localDate(now)));
  const favorites = opts.favorites ?? [];
  const engineBlocks = [...active.map((b) => toEngineBlock(b, now)), ...(opts.extraBlocks ?? [])];
  const shared = {
    blocks: engineBlocks,
    context: opts.context,
    previous: opts.day.plan as Plan | undefined,
    lockedBlockIds: opts.day.lockedIds,
    doneBlockIds: [...opts.day.doneIds, ...opts.day.skippedIds],
    affinity: opts.affinity && Object.keys(opts.affinity).length ? opts.affinity : undefined,
  };

  if (!opts.forceOffline && engineBlocks.length) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(`${API_URL}/v1/reroute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...shared, favorites: favorites.length ? favorites : undefined }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const body = (await res.json()) as ServerResponse;
        return {
          plan: body.plan,
          alternatives: body.alternatives,
          changes: body.changes,
          source: 'server',
          warnings: body.meta?.warnings ?? [],
          placeCache: cacheFromCandidates(active, body.candidates ?? {}, opts.context, body.meta?.placesProvider === 'mock'),
        };
      }
      if (res.status === 429) throw new Error('rate');
    } catch {
      // fall through to on-device
    }
  }

  const candidates = candidatesFromCache(active, opts.placeCache, opts.context, favorites);
  const hasCache = Object.values(candidates).some((l) => l.length);
  const result = reroute({ ...shared, candidates });
  const warnings = [
    hasCache
      ? 'Offline: planned with saved places. Opening hours may have changed.'
      : 'Offline, with no saved places near here, so plans that need a place use their backup.',
  ];
  return { ...result, source: 'device', warnings };
}
