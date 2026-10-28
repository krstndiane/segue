import {
  BudgetedPlacesProvider,
  CachedGeocoder,
  CachedWeatherProvider,
  FallbackWeatherProvider,
  MetNoProvider,
  NoGeocoder,
  NominatimGeocoder,
  NominatimPlacesProvider,
  RequestGate,
  CachedPlacesProvider,
  DEFAULT_OVERPASS_ENDPOINTS,
  FallbackPlacesProvider,
  GooglePlacesProvider,
  MockPlacesProvider,
  OpenMeteoProvider,
  OsmPlacesProvider,
  type PlacesProvider,
  type WeatherProvider,
} from '@segue/providers';
import type { Config } from './config';

/** Everything that calls OpenStreetMap's Nominatim shares one request a second (its usage policy). */
const nominatimGate = new RequestGate(1100);
const nominatimAgent = () => process.env.NOMINATIM_USER_AGENT || 'Segue day planner (https://segue.pdyntech.com)';

/**
 * Wire up the Places Gateway from config:
 *   google → budget cap → OpenStreetMap (Overpass, then Nominatim search), cached
 *   osm    → Overpass servers in turn, then Nominatim search, cached
 *   mock   → made-up places, for development and tests only
 * Real modes never fall back to made-up places: when no map source answers,
 * the lookup fails, the plan says so, and blocks use their no-place version.
 * Public Overpass servers are often at capacity, so after they all fail they
 * rest for 10 minutes and Nominatim answers straight away.
 */
export function buildPlacesProvider(config: Pick<Config, 'placesProvider' | 'googlePlacesApiKey' | 'googleDailyBudget' | 'overpassUrls'>, log: (line: string) => void = console.warn): PlacesProvider {
  if (config.placesProvider === 'mock') return new MockPlacesProvider();
  const osm = new OsmPlacesProvider(fetch, config.overpassUrls ?? DEFAULT_OVERPASS_ENDPOINTS, { log });
  const nominatim = new NominatimPlacesProvider(fetch, nominatimAgent(), nominatimGate);
  const chain: PlacesProvider[] =
    config.placesProvider === 'google'
      ? [new BudgetedPlacesProvider(new GooglePlacesProvider(config.googlePlacesApiKey!), config.googleDailyBudget), osm, nominatim]
      : [osm, nominatim];
  return new CachedPlacesProvider(new FallbackPlacesProvider(chain, log));
}

/** Place names from OpenStreetMap (Nominatim), cached; none with offline demo data. */
export function buildGeocoder(config: Config) {
  if (config.placesProvider === 'mock') return new NoGeocoder();
  return new CachedGeocoder(new NominatimGeocoder(fetch, nominatimAgent(), undefined, undefined, undefined, nominatimGate));
}

/**
 * Open-Meteo first (free, but limited per IP, and shared hosts burn through that), MET Norway when it refuses,
 * all cached so a cell is asked about once per few minutes, not once per visitor.
 * MET Norway asks for a User-Agent that says who is calling; set WEATHER_USER_AGENT to your own contact.
 */
export function buildWeatherProvider(log: (line: string) => void = console.warn): WeatherProvider {
  const userAgent = process.env.WEATHER_USER_AGENT || 'Segue day planner (pdyntechnology@gmail.com)';
  const chain = new FallbackWeatherProvider(new OpenMeteoProvider(), new MetNoProvider(fetch, userAgent), 5 * 60 * 1000, Date.now, (e) =>
    log(`weather: ${e.message}; using MET Norway for a few minutes`),
  );
  return new CachedWeatherProvider(chain);
}
