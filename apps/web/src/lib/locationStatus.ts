/**
 * The words beside the location pin and in the location banner. The pin only
 * reports where the sky is; there's nothing to tap.
 */
import { staleNote, type LocationPermission, type SkySource } from './location';
import { SKY_REFRESH_MS } from './weather';

export interface LocationStatus {
  /** where the sky is */
  source: SkySource['kind'] | 'finding';
  /** the pin's text: the place name, or a plain fallback */
  label: string;
  /** a short qualifier: "Using your time zone", "Updated 25 min ago" */
  note?: string;
  /** location is blocked or this browser can't share it */
  blocked: boolean;
}

export interface LocationBannerCopy {
  kind: 'asking' | 'blocked' | 'unsupported' | 'unavailable';
  text: string;
}

/** Shown just before the browser asks, and in first-run setup. */
export const LOCATION_WHY =
  'Used to match the sky and plan your day. Your exact position stays on this phone; only a rough area (about 1 km) is used for the weather.';
export const LOCATION_BLOCKED = "Allow location to match your sky. Open your browser's site settings, then reload.";
export const LOCATION_UNSUPPORTED = "This browser can't share your location, so the sky follows your time zone.";
export const LOCATION_UNAVAILABLE = "Can't find you right now. Segue will keep trying.";

export function locationStatus(opts: {
  source: SkySource;
  permission: LocationPermission | 'unknown';
  asking: boolean;
  /** no position yet, and one is on its way */
  waiting?: boolean;
  /** the area's name, from the API, once known */
  name?: string;
  /** when the weather on screen was fetched */
  weatherAt?: string;
  now: Date;
}): LocationStatus {
  const { source, permission, name, now } = opts;
  const finding = opts.asking || !!opts.waiting || permission === 'unknown';
  const blocked = permission === 'denied' || permission === 'unsupported';
  const stale = staleNote(opts.weatherAt, now, SKY_REFRESH_MS) ?? undefined;
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ') || undefined;

  switch (source.kind) {
    case 'here':
      return { source: 'here', label: name ?? 'Near you', note: stale, blocked };
    case 'last':
      return { source: 'last', label: name ?? 'Last known area', note: join('Using your last known area', stale), blocked };
    case 'timezone':
      if (finding) return { source: 'finding', label: 'Finding you…', blocked: false };
      return { source: 'timezone', label: source.area.name, note: join('Using your time zone', stale), blocked };
    case 'none':
      if (finding) return { source: 'finding', label: 'Finding you…', blocked: false };
      return { source: 'none', label: 'Location off', blocked };
  }
}

/** The banner under the header, if one is needed. */
export function locationBanner(opts: {
  permission: LocationPermission | 'unknown';
  asking: boolean;
  unavailable: boolean;
  source: SkySource;
}): LocationBannerCopy | null {
  if (opts.asking) return { kind: 'asking', text: LOCATION_WHY };
  if (opts.permission === 'denied') return { kind: 'blocked', text: LOCATION_BLOCKED };
  if (opts.permission === 'unsupported') return { kind: 'unsupported', text: LOCATION_UNSUPPORTED };
  if (opts.unavailable && opts.source.kind !== 'here') return { kind: 'unavailable', text: LOCATION_UNAVAILABLE };
  return null;
}
