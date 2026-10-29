/**
 * Nearby places from OpenStreetMap's Nominatim search, as a fallback for when
 * the public Overpass servers are at capacity (which, in October 2026, was
 * most of the time: "502 … All query workers are busy").
 *
 * Nominatim is a search engine, so a query for "gym" also returns covered
 * courts named "… Gym" and schools called "Little Gym". Only results whose
 * OpenStreetMap tag matches the kind of place are kept. Same ids as Overpass
 * ("osm:node/123"), so the two never double up. Usage policy: at most one
 * request a second, a real User-Agent, and cache the answers (the gateway
 * caches for 24 h per area).
 */
import type { LatLng, Place } from '@segue/engine';
import { dedupePlaces } from './dedupe';
import { attributesFromTags, addressFromTags } from './osm';
import { parseOsmOpeningHours } from './osmHours';
import { ProviderError, fetchWithTimeout, type FetchFn, type NearbyRequest, type PlacesProvider, type SearchableCategory } from './types';

/** One request at a time, at least `gapMs` apart, shared by everything that calls Nominatim. */
export class RequestGate {
  private next = 0;
  constructor(
    private readonly gapMs = 1100,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly clock: () => number = Date.now,
  ) {}

  async wait(): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await this.sleep(at - now);
  }
}

/**
 * What to search for, and which OpenStreetMap tags count as that kind of place.
 * "[key=value]" asks Nominatim for every place with that tag in the box, named
 * anything ("Anytime Fitness", not only places called "… Gym"). Sports centres
 * are left out of gyms: around Manila they are mostly badminton courts.
 */
const SEARCH: Record<SearchableCategory, { q: string; tags: string[] }> = {
  gym: { q: '[leisure=fitness_centre]', tags: ['leisure=fitness_centre'] },
  cafe: { q: '[amenity=cafe]', tags: ['amenity=cafe'] },
  cowork: { q: 'coworking', tags: ['amenity=coworking_space', 'office=coworking'] },
  library: { q: '[amenity=library]', tags: ['amenity=library'] },
  restaurant: { q: '[amenity=restaurant]', tags: ['amenity=restaurant', 'amenity=fast_food', 'amenity=food_court'] },
  park: { q: '[leisure=park]', tags: ['leisure=park', 'leisure=garden'] },
  grocery: { q: '[shop=supermarket]', tags: ['shop=supermarket', 'shop=convenience', 'shop=greengrocer'] },
  mall: { q: '[shop=mall]', tags: ['shop=mall', 'shop=department_store'] },
};

interface NominatimResult {
  osm_type?: 'node' | 'way' | 'relation';
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  display_name?: string;
  category?: string;
  type?: string;
  extratags?: Record<string, string> | null;
}

function metersBetween(a: LatLng, b: LatLng): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/** The box Nominatim searches in, around a point. */
export function viewbox({ lat, lng }: LatLng, radiusM: number): string {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat + dLat, lng + dLng, lat - dLat].map((n) => n.toFixed(5)).join(',');
}

export function parseNominatimPlaces(results: NominatimResult[], req: NearbyRequest, fetchedAt?: string): Place[] {
  const allowed = new Set(SEARCH[req.category].tags);
  const out: Place[] = [];
  for (const r of results) {
    if (!allowed.has(`${r.category}=${r.type}`)) continue;
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    const name = r.name?.trim();
    if (!name || !r.osm_type || !r.osm_id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const location = { lat, lng };
    if (metersBetween(location, req.location) > req.radiusM) continue;
    const tags = r.extratags ?? {};
    const hoursTag = tags.opening_hours?.trim().toLowerCase();
    out.push({
      id: `osm:${r.osm_type}/${r.osm_id}`,
      name,
      location,
      category: req.category,
      attributes: attributesFromTags(tags, req.category),
      hours: parseOsmOpeningHours(tags.opening_hours),
      address: addressFromTags(tags),
      source: 'osm',
      ...(fetchedAt ? { fetchedAt } : {}),
      ...(hoursTag === 'closed' || hoursTag === 'off' ? { temporarilyClosed: true } : {}),
    });
  }
  // Nearest first: Nominatim orders by importance, not distance.
  return dedupePlaces(out).sort((a, b) => metersBetween(a.location, req.location) - metersBetween(b.location, req.location));
}

/** How long to leave Nominatim alone after it refuses us (429 or 403): its `retry-after`, else 5 minutes, at most 30. */
export function backoffMs(retryAfter: string | null, now: number): number {
  const FALLBACK = 5 * 60_000;
  const MAX = 30 * 60_000;
  if (!retryAfter) return FALLBACK;
  const secs = Number(retryAfter);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(ms) || ms <= 0) return FALLBACK;
  return Math.min(MAX, Math.max(1000, ms));
}

export class NominatimPlacesProvider implements PlacesProvider {
  readonly name = 'nominatim';
  private refusedUntil = 0;
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly userAgent = 'Segue day planner (https://segue.pdyntech.com)',
    private readonly gate: RequestGate = new RequestGate(),
    private readonly endpoint = 'https://nominatim.openstreetmap.org/search',
    private readonly clock: () => number = Date.now,
  ) {}

  async nearby(req: NearbyRequest): Promise<Place[]> {
    // Asking again while refused only extends the block, so wait it out.
    if (this.clock() < this.refusedUntil) throw new ProviderError(this.name, 'Nominatim asked us to slow down; trying again shortly', 429);
    await this.gate.wait();
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: SEARCH[req.category].q,
      viewbox: viewbox(req.location, req.radiusM),
      bounded: '1',
      limit: '40',
      extratags: '1',
      addressdetails: '0',
      'accept-language': 'en',
    });
    const res = await fetchWithTimeout(this.fetchFn, `${this.endpoint}?${params}`, { timeoutMs: 6000, headers: { 'user-agent': this.userAgent, accept: 'application/json' } });
    if (res.status === 429 || res.status === 403) {
      this.refusedUntil = this.clock() + backoffMs(res.headers.get('retry-after'), this.clock());
      throw new ProviderError(this.name, `search returned ${res.status}`, res.status);
    }
    if (!res.ok) throw new ProviderError(this.name, `search returned ${res.status}`, res.status);
    const body = (await res.json()) as NominatimResult[] | { error?: string };
    if (!Array.isArray(body)) throw new ProviderError(this.name, `search failed: ${String(body.error ?? 'unexpected answer').slice(0, 120)}`);
    return parseNominatimPlaces(body, req, new Date(this.clock()).toISOString()).slice(0, req.limit ?? 20);
  }
}
