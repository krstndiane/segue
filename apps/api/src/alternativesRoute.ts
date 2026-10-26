/**
 * POST /v1/alternatives: realistic options for one item in today's plan.
 *
 * Places are looked up near where the user will actually be just before the
 * item (the previous stop with a place, else where they are now), for the
 * item's own kind of place and the kinds that can stand in for it. The engine
 * then checks each option against the rest of the day. Nothing is stored.
 */
import { SUBSTITUTES, alternatives, originBefore, searchRadiusMeters, type Place, type PlaceCategory, type WeatherHour } from '@segue/engine';
import { dedupePlaces, type PlacesProvider, type WeatherProvider } from '@segue/providers';
import type { AlternativesRequest } from '@segue/schemas';

export interface AlternativesDeps {
  places: PlacesProvider;
  weather: WeatherProvider;
  log: (line: string) => void;
  now?: () => number;
}

const PLURAL: Partial<Record<PlaceCategory, string>> = { cafe: 'cafés', cowork: 'coworking spaces', library: 'libraries', restaurant: 'places to eat', gym: 'gyms', park: 'parks', grocery: 'groceries', mall: 'malls' };

/** Thunderstorms and dangerous heat make outdoor exercise unsafe for the next couple of hours. */
const HAZARD_HOURS = 2;

export async function findAlternatives(body: AlternativesRequest, deps: AlternativesDeps) {
  const block = body.blocks.find((b) => b.id === body.blockId);
  const warnings: string[] = [];
  const nowMs = Date.parse(body.context.now);
  const origin = originBefore(body.plan, body.blockId, body.context.location, nowMs);
  const searchedNear = origin === body.context.location ? 'here' : 'previous-stop';

  const categories: PlaceCategory[] = block && !block.fixed && block.category !== 'none' ? [block.category, ...(SUBSTITUTES[block.category] ?? [])] : [];
  const radiusM = searchRadiusMeters(body.context.mode);
  const places: Partial<Record<PlaceCategory, Place[]>> = {};
  let liveSource = '';

  const [, forecast, current] = await Promise.all([
    Promise.all(
      categories.map(async (category) => {
        try {
          const found = await deps.places.nearby({ location: origin, radiusM, category: category as Exclude<PlaceCategory, 'none'>, limit: 12 });
          liveSource ||= found[0]?.source ?? '';
          places[category] = found;
        } catch (e) {
          deps.log(`alternatives: places failed for ${category}: ${(e as Error).message}`);
          warnings.push(`Couldn't reach live map data for ${PLURAL[category] ?? 'places'} right now.`);
          places[category] = [];
        }
      }),
    ),
    body.context.weather
      ? Promise.resolve(body.context.weather)
      : deps.weather.forecast(origin).catch((e: Error): WeatherHour[] => {
          deps.log(`alternatives: forecast failed: ${e.message}`);
          return [];
        }),
    deps.weather.current(origin).catch(() => null),
  ]);

  // The user's saved places join their kind, first.
  for (const fav of body.favorites ?? []) {
    if (!categories.includes(fav.category)) continue;
    places[fav.category] = dedupePlaces([fav, ...(places[fav.category] ?? [])]);
  }

  let hazardUntil: string | undefined;
  if (current && (current.condition === 'storm' || (current.feelsLikeC ?? 0) >= 42)) {
    hazardUntil = new Date(nowMs + HAZARD_HOURS * 3_600_000).toISOString();
  }

  const result = alternatives({
    blocks: body.blocks,
    plan: body.plan,
    blockId: body.blockId,
    context: { ...body.context, weather: forecast.length ? forecast : undefined },
    places,
    trigger: body.trigger,
    rainingUntil: body.rainingUntil,
    hazardUntil,
    avoidPlaceIds: body.avoidPlaceIds,
    maxMinutes: body.maxMinutes,
    doneBlockIds: body.doneBlockIds,
  });
  if (hazardUntil && current) {
    result.notes.unshift({ kind: 'hard', text: current.condition === 'storm' ? 'A thunderstorm is reported nearby, so nothing outdoors for now' : 'The heat is at a dangerous level, so nothing outdoors for now' });
  }
  return {
    result,
    places,
    meta: { weather: forecast.length > 0, currentWeather: current?.condition ?? null, warnings, searchedNear, placesSource: liveSource || null },
  };
}
