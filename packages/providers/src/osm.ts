/**
 * OpenStreetMap places via the Overpass API. Free and keyless, so it is the
 * default source and the fallback when a paid provider is over budget.
 */
import type { Place, Requirement } from '@segue/engine';
import { parseOsmOpeningHours } from './osmHours';
import { dedupePlaces } from './dedupe';
import { ProviderError, fetchWithTimeout, type FetchFn, type NearbyRequest, type PlacesProvider, type SearchableCategory } from './types';

/**
 * Public Overpass servers, tried in order. The main one often refuses shared
 * hosting addresses (429/504), so one refusal shouldn't mean "no data".
 * Override with OVERPASS_URLS (comma-separated).
 */
export const DEFAULT_OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const SELECTORS: Record<SearchableCategory, string[]> = {
  cafe: ['["amenity"="cafe"]'],
  cowork: ['["amenity"="coworking_space"]', '["office"="coworking"]'],
  library: ['["amenity"="library"]'],
  restaurant: ['["amenity"="restaurant"]', '["amenity"="fast_food"]', '["amenity"="food_court"]'],
  gym: ['["leisure"="fitness_centre"]', '["leisure"="sports_centre"]["sport"="fitness"]'],
  park: ['["leisure"="park"]', '["leisure"="garden"]["access"!="private"]'],
  grocery: ['["shop"="supermarket"]', '["shop"="convenience"]', '["shop"="greengrocer"]'],
  mall: ['["shop"="mall"]', '["shop"="department_store"]'],
};

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function buildOverpassQuery(req: NearbyRequest): string {
  const { lat, lng } = req.location;
  const around = `(around:${Math.round(req.radiusM)},${lat.toFixed(6)},${lng.toFixed(6)})`;
  const parts = SELECTORS[req.category].map((sel) => `nwr${sel}${around};`).join('');
  return `[out:json][timeout:7];(${parts});out center tags ${Math.min(80, (req.limit ?? 20) * 3)};`;
}

function attributesFrom(tags: Record<string, string>, category: SearchableCategory): Partial<Record<Requirement, boolean>> {
  const a: Partial<Record<Requirement, boolean>> = {};
  const net = tags.internet_access;
  if (net) a.wifi = ['wlan', 'yes', 'wifi', 'terminal;wlan'].includes(net) ? true : net === 'no' ? false : undefined;
  if (a.wifi === undefined) delete a.wifi;
  if (category === 'park') a.outdoor = true;
  else a.indoor = true;
  if (category === 'restaurant' || category === 'cafe') a.food = true;
  if (tags['socket'] || tags['socket:type2'] || tags['power_supply'] === 'yes') a.power = true;
  return a;
}

function addressFrom(tags: Record<string, string>): string | undefined {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const parts = [street, tags['addr:city'] ?? tags['addr:suburb']].filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
}

export function parseOverpass(elements: OverpassElement[], category: SearchableCategory, fetchedAt?: string): Place[] {
  const out: Place[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name ?? tags['name:en'];
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const hoursTag = tags.opening_hours?.trim().toLowerCase();
    out.push({
      id: `osm:${el.type}/${el.id}`,
      name,
      location: { lat, lng: lon },
      category,
      attributes: attributesFrom(tags, category),
      hours: parseOsmOpeningHours(tags.opening_hours),
      address: addressFrom(tags),
      source: 'osm',
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(hoursTag === 'closed' || hoursTag === 'off' ? { temporarilyClosed: true } : {}),
    });
  }
  return dedupePlaces(out);
}

export class OsmPlacesProvider implements PlacesProvider {
  readonly name = 'osm';
  private readonly endpoints: string[];
  /** the server that answered last, tried first next time */
  private preferred = 0;
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    endpoints: string | string[] = DEFAULT_OVERPASS_ENDPOINTS,
    private readonly opts: { timeoutMs?: number; budgetMs?: number; clock?: () => number; log?: (line: string) => void } = {},
  ) {
    this.endpoints = (Array.isArray(endpoints) ? endpoints : [endpoints]).filter(Boolean);
    if (!this.endpoints.length) throw new Error('OsmPlacesProvider needs an Overpass endpoint');
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    const clock = this.opts.clock ?? Date.now;
    const started = clock();
    const budget = this.opts.budgetMs ?? 9000;
    const errors: string[] = [];
    const order = this.endpoints.map((_, i) => (this.preferred + i) % this.endpoints.length);
    for (const i of order) {
      const left = budget - (clock() - started);
      if (left < 1500) break;
      const endpoint = this.endpoints[i]!;
      try {
        const res = await fetchWithTimeout(this.fetchFn, endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            'user-agent': 'Segue day planner (https://segue.pdyntech.com)',
          },
          body: `data=${encodeURIComponent(buildOverpassQuery(req))}`,
          timeoutMs: Math.min(this.opts.timeoutMs ?? 6000, left),
        });
        if (!res.ok) throw new ProviderError(this.name, `Overpass returned ${res.status}`, res.status);
        const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
        if (!json.elements && json.remark) throw new ProviderError(this.name, `Overpass: ${json.remark.slice(0, 120)}`);
        this.preferred = i;
        return parseOverpass(json.elements ?? [], req.category, new Date(clock()).toISOString()).slice(0, req.limit ?? 20);
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : `[osm] ${(e as Error).name === 'AbortError' ? 'timed out' : (e as Error).message}`;
        errors.push(`${new URL(endpoint).host}: ${msg}`);
        this.opts.log?.(`places: ${new URL(endpoint).host} failed (${msg})`);
      }
    }
    throw new ProviderError(this.name, `no Overpass server answered (${errors.join('; ') || 'out of time'})`);
  }
}
