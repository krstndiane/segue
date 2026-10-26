/**
 * "What can I do instead?" for one item: the server looks up live places near
 * where you'll be and checks the weather; if it can't be reached, the same
 * engine runs on the phone with the places saved from earlier, and says so.
 * Choosing an option only changes today's plan, after a tap, and can be undone.
 */
import {
  alternatives,
  type AlternativeOption,
  type AlternativeTrigger,
  type AlternativesResult,
  type Block,
  type Context,
  type Place,
  type PlaceCategory,
  type Plan,
  type PlanItem,
  type WeatherHour,
} from '@segue/engine';
import type { SkyView } from './weather';
import { SKY_STALE_MS } from './weather';
import { API_URL, trustedPlaces } from './reroute';
import type { DayState, FavoritePlace, PlaceCache } from './model';

export interface AlternativesOutcome {
  result: AlternativesResult;
  /** the places the options were drawn from, so "not this one" or "only 30 min" can be recomputed on the phone */
  places: Partial<Record<PlaceCategory, Place[]>>;
  source: 'server' | 'device';
  warnings: string[];
  /** the request, kept to recompute with a change */
  request: AlternativesRequest;
}

export interface AlternativesRequest {
  blocks: Block[];
  plan: Plan;
  blockId: string;
  context: Context;
  trigger?: AlternativeTrigger;
  rainingUntil?: string;
  avoidPlaceIds?: string[];
  maxMinutes?: number;
  doneBlockIds?: string[];
  favorites?: FavoritePlace[];
}

/** The forecast from the sky, if it is recent enough to rely on. */
export function forecastFromSky(sky: SkyView | undefined, now: number): WeatherHour[] | undefined {
  const d = sky?.details;
  if (!sky?.known || sky.preview || !d?.upcoming?.length || !sky.fetchedAt) return undefined;
  if (now - Date.parse(sky.fetchedAt) > SKY_STALE_MS) return undefined;
  return d.upcoming.map((h) => ({ time: h.time, precipitationProbability: h.rainChance }));
}

function placesFromCache(cache: PlaceCache | undefined, favorites: FavoritePlace[], near: boolean): Partial<Record<PlaceCategory, Place[]>> {
  const out: Partial<Record<PlaceCategory, Place[]>> = {};
  const cats = new Set<PlaceCategory>([...Object.keys(cache?.byCategory ?? {}), ...favorites.map((f) => f.category)] as PlaceCategory[]);
  for (const cat of cats) {
    const mine = favorites.filter((f) => f.category === cat);
    const cached = near ? trustedPlaces(cache?.byCategory[cat] ?? [], cache) : [];
    out[cat] = [...mine, ...cached.filter((p) => !mine.some((m) => m.id === p.id))];
  }
  return out;
}

/** Run the engine on the phone, with places it already has. */
export function alternativesOnDevice(req: AlternativesRequest, places: Partial<Record<PlaceCategory, Place[]>>): AlternativesResult {
  return alternatives({
    blocks: req.blocks,
    plan: req.plan,
    blockId: req.blockId,
    context: req.context,
    places,
    trigger: req.trigger,
    rainingUntil: req.rainingUntil,
    avoidPlaceIds: req.avoidPlaceIds,
    maxMinutes: req.maxMinutes,
    doneBlockIds: req.doneBlockIds,
  });
}

export async function findAlternatives(
  req: AlternativesRequest,
  opts: { placeCache?: PlaceCache; cacheNear: boolean; forceOffline?: boolean; signal?: AbortSignal; fetchFn?: typeof fetch; /** the sky's recent forecast, used on the phone */ deviceWeather?: WeatherHour[] },
): Promise<AlternativesOutcome> {
  const fetchFn = opts.fetchFn ?? fetch;
  if (!opts.forceOffline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      opts.signal?.addEventListener('abort', () => ctrl.abort());
      const res = await fetchFn(`${API_URL}/v1/alternatives`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...req, favorites: req.favorites?.length ? req.favorites : undefined }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (res.ok) {
        const body = (await res.json()) as { result: AlternativesResult; places: AlternativesOutcome['places']; meta?: { warnings?: string[] } };
        return { result: body.result, places: body.places ?? {}, source: 'server', warnings: body.meta?.warnings ?? [], request: req };
      }
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // fall through to the phone
    }
  }
  const places = placesFromCache(opts.placeCache, req.favorites ?? [], opts.cacheNear);
  const onDevice: AlternativesRequest = { ...req, context: { ...req.context, weather: req.context.weather ?? opts.deviceWeather } };
  const result = alternativesOnDevice(onDevice, places);
  const any = Object.values(places).some((l) => l?.length);
  return {
    result,
    places,
    source: 'device',
    warnings: [any ? "Offline: using places saved earlier. Their hours may have changed." : "Offline, and no places saved near here, so only options without a place are shown."],
    request: onDevice,
  };
}

/** Recompute on the phone with a change ("not this one", "only 30 minutes"), using the same places. */
export function refine(o: AlternativesOutcome, change: Partial<Pick<AlternativesRequest, 'avoidPlaceIds' | 'maxMinutes'>>): AlternativesOutcome {
  const request = { ...o.request, ...change };
  return { ...o, request, result: alternativesOnDevice(request, o.places) };
}

/** Today's plan with the chosen option in place of the item, pinned there. */
export function applyAlternative(day: DayState, option: AlternativeOption): DayState {
  if (!day.plan) return day;
  const items: PlanItem[] = day.plan.items
    .map((i) =>
      i.blockId !== option.blockId
        ? i
        : {
            ...i,
            start: option.start,
            end: option.end,
            place: option.place ? { id: option.place.id, name: option.place.name, location: option.place.location, address: option.place.address } : undefined,
            travelMinutesBefore: option.travelMinutes,
            confidence: !option.place ? ('no-place' as const) : option.hours?.basis === 'listed-hours' ? ('verified' as const) : ('unconfirmed' as const),
            fallbacks: [],
            explanation: option.label,
            conflict: undefined,
          },
    )
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { ...day, plan: { ...day.plan, items }, lockedIds: [...new Set([...day.lockedIds, option.blockId])] };
}
