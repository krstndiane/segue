/**
 * Google Places API (New). Paid, so the gateway caches aggressively and asks
 * only for the fields it needs (the field mask controls billing tier).
 */
import type { OpeningHours, Place, Requirement } from '@segue/engine';
import { dedupePlaces } from './dedupe';
import { ProviderError, fetchWithTimeout, type FetchFn, type NearbyRequest, type PlacesProvider, type SearchableCategory } from './types';

const BASE = 'https://places.googleapis.com/v1';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.regularOpeningHours',
  'places.rating',
  'places.userRatingCount',
  'places.formattedAddress',
  'places.businessStatus',
].join(',');

/** Nearby search by place type; coworking has no type, so it uses text search. */
const TYPES: Record<SearchableCategory, string[] | { text: string }> = {
  cafe: ['cafe', 'coffee_shop'],
  cowork: { text: 'coworking space' },
  library: ['library'],
  restaurant: ['restaurant'],
  gym: ['gym'],
  park: ['park'],
  grocery: ['supermarket', 'grocery_store', 'convenience_store'],
  mall: ['shopping_mall', 'department_store'],
};

interface GooglePoint {
  day: number;
  hour: number;
  minute: number;
}
interface GooglePlace {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  regularOpeningHours?: { periods?: { open: GooglePoint; close?: GooglePoint }[] };
  rating?: number;
  userRatingCount?: number;
  formattedAddress?: string;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
}

const hm = (p: GooglePoint) => `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;

export function parseGoogleHours(h: GooglePlace['regularOpeningHours']): OpeningHours | null {
  const periods = h?.periods;
  if (!periods?.length) return null;
  // A single period with an open and no close means open 24/7.
  if (periods.length === 1 && !periods[0]!.close) return { always: true, periods: [] };
  return {
    periods: periods
      .filter((p) => p.close)
      .map((p) => ({ day: p.open.day, open: hm(p.open), close: p.close!.day !== p.open.day && hm(p.close!) === '00:00' ? '24:00' : hm(p.close!) })),
  };
}

export function parseGooglePlaces(places: GooglePlace[], category: SearchableCategory, fetchedAt?: string): Place[] {
  const out = places
    .filter((p) => p.location && Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude) && p.displayName?.text)
    .filter((p) => p.businessStatus !== 'CLOSED_PERMANENTLY')
    .map((p) => {
      const attributes: Partial<Record<Requirement, boolean>> = category === 'park' ? { outdoor: true } : { indoor: true };
      if (category === 'restaurant' || category === 'cafe') attributes.food = true;
      return {
        id: `google:${p.id}`,
        name: p.displayName!.text,
        location: { lat: p.location!.latitude, lng: p.location!.longitude },
        category,
        attributes,
        hours: parseGoogleHours(p.regularOpeningHours),
        rating: p.rating,
        reviewCount: p.userRatingCount,
        address: p.formattedAddress,
        source: 'google',
        ...(fetchedAt ? { fetchedAt } : {}),
        ...(p.businessStatus === 'CLOSED_TEMPORARILY' ? { temporarilyClosed: true } : {}),
      };
    });
  return dedupePlaces(out);
}

export class GooglePlacesProvider implements PlacesProvider {
  readonly name = 'google';
  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    if (!apiKey) throw new Error('GooglePlacesProvider needs an API key');
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    const type = TYPES[req.category];
    const circle = {
      center: { latitude: req.location.lat, longitude: req.location.lng },
      radius: Math.min(50_000, req.radiusM),
    };
    const max = Math.min(20, req.limit ?? 20);
    const [url, body] = Array.isArray(type)
      ? [`${BASE}/places:searchNearby`, { includedTypes: type, maxResultCount: max, locationRestriction: { circle } }]
      : [`${BASE}/places:searchText`, { textQuery: type.text, maxResultCount: max, locationBias: { circle } }];

    const res = await fetchWithTimeout(this.fetchFn, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': FIELD_MASK },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError(this.name, `Places API returned ${res.status}`, res.status);
    const json = (await res.json()) as { places?: GooglePlace[] };
    return parseGooglePlaces(json.places ?? [], req.category, new Date().toISOString());
  }
}
