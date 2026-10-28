/**
 * Place names for coordinates ("Poblacion, Makati"), so the app can say
 * where the sky is. OpenStreetMap's Nominatim, cached by geohash cell
 * (about 1 km) and spaced out to respect its usage policy (at most one
 * request a second, a real User-Agent).
 */
import type { LatLng } from '@segue/engine';
import type { KeyValueStore } from './cache';
import { MemoryStore } from './cache';
import { geohash } from './geohash';
import { ProviderError, fetchWithTimeout, type FetchFn } from './types';

export interface ReverseGeocoder {
  readonly name: string;
  /** A short name for where the coordinates are, or null when there isn't a useful one (open sea). */
  placeName(location: LatLng): Promise<string | null>;
}

interface NominatimAddress {
  neighbourhood?: string;
  quarter?: string;
  suburb?: string;
  city_district?: string;
  village?: string;
  town?: string;
  city?: string;
  municipality?: string;
  county?: string;
  state?: string;
  country?: string;
}

const MAX_NAME = 40;

/** Neighbourhood and city where both are known: "Poblacion, Makati"; otherwise the best single name. */
export function shortPlaceName(a: NominatimAddress | undefined): string | null {
  if (!a) return null;
  const clean = (s?: string) => s?.replace(/^City of /i, '').replace(/ City$/i, '').trim() || undefined;
  const area = clean(a.neighbourhood ?? a.quarter ?? a.suburb ?? a.city_district ?? a.village);
  const city = clean(a.city ?? a.town ?? a.municipality ?? a.county);
  const name = area && city && area !== city ? `${area}, ${city}` : (area ?? city ?? clean(a.state) ?? clean(a.country));
  if (!name) return null;
  if (name.length <= MAX_NAME) return name;
  return (city && city.length <= MAX_NAME ? city : name.slice(0, MAX_NAME - 1).trimEnd() + '…');
}

export class NominatimGeocoder implements ReverseGeocoder {
  readonly name = 'nominatim';
  private last = 0;
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly userAgent = 'Segue day planner (https://github.com/segue)',
    private readonly endpoint = 'https://nominatim.openstreetmap.org/reverse',
    private readonly minGapMs = 1100,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    /** shared with place searches, so all calls to Nominatim together stay at one a second */
    private readonly gate?: { wait(): Promise<void> },
  ) {}

  async placeName(location: LatLng): Promise<string | null> {
    // One request a second at most, per Nominatim's usage policy.
    if (this.gate) await this.gate.wait();
    else {
      const wait = this.last + this.minGapMs - Date.now();
      this.last = Date.now() + Math.max(0, wait);
      if (wait > 0) await this.sleep(wait);
    }
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: location.lat.toFixed(4),
      lon: location.lng.toFixed(4),
      zoom: '14',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const res = await fetchWithTimeout(this.fetchFn, `${this.endpoint}?${params}`, { timeoutMs: 5000, headers: { 'user-agent': this.userAgent } });
    if (!res.ok) throw new ProviderError(this.name, `reverse returned ${res.status}`, res.status);
    const body = (await res.json()) as { address?: NominatimAddress; error?: string };
    return body.error ? null : shortPlaceName(body.address);
  }
}

/** Remembers names by geohash cell (about 1.2 km), for 30 days. */
export class CachedGeocoder implements ReverseGeocoder {
  readonly name: string;
  constructor(
    private readonly inner: ReverseGeocoder,
    private readonly store: KeyValueStore<string> = new MemoryStore<string>(),
    private readonly ttlMs = 30 * 24 * 3_600_000,
  ) {
    this.name = `cached(${inner.name})`;
  }

  async placeName(location: LatLng): Promise<string | null> {
    const key = `place-name:${geohash(location.lat, location.lng, 6)}`;
    const hit = await this.store.get(key);
    if (hit !== undefined) return hit || null;
    const name = await this.inner.placeName(location);
    await this.store.set(key, name ?? '', this.ttlMs);
    return name;
  }
}

/** No names (offline demo data). */
export class NoGeocoder implements ReverseGeocoder {
  readonly name = 'none';
  async placeName(): Promise<string | null> {
    return null;
  }
}
