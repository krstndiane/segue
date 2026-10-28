import type { LatLng, Place, PlaceCategory, WeatherHour } from '@segue/engine';

export type SearchableCategory = Exclude<PlaceCategory, 'none'>;

export interface NearbyRequest {
  location: LatLng;
  radiusM: number;
  category: SearchableCategory;
  limit?: number;
}

export interface PlacesProvider {
  readonly name: string;
  nearby(req: NearbyRequest): Promise<Place[]>;
  /** Which source answered last and the latest failure, for /health. No secrets. */
  status?(): PlacesStatus;
}

export interface PlacesStatus {
  lastAnswer: { provider: string; at: string } | null;
  lastFailure: { at: string; message: string } | null;
}

/** The skies the app can draw. Coarse on purpose: it's a mood, not a forecast. */
export type SkyCondition = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'rain' | 'heavy-rain' | 'storm';

export interface CurrentWeather {
  condition: SkyCondition;
  /** false between sunset and sunrise at that location */
  isDay: boolean;
  temperatureC?: number;
  /** "feels like": temperature with humidity and wind, which is what heat advice is based on */
  feelsLikeC?: number;
  /** 0 at night, 11+ is extreme */
  uvIndex?: number;
  gustKmh?: number;
  precipitationMm?: number;
  /** ISO timestamp of the observation, with the place's own UTC offset */
  observedAt: string;
  /** the place's offset from UTC in minutes (Manila = 480), for its sunrise, sunset and local hours */
  utcOffsetMinutes?: number;
  /** IANA time zone of the place, e.g. "Asia/Manila" */
  timezone?: string;
  /** the next 12 hours, for "rain from 3 PM" and the day's highest UV */
  upcoming?: UpcomingHour[];
}

export interface UpcomingHour {
  /** ISO timestamp, start of the hour */
  time: string;
  /** 0–100 */
  rainChance: number;
  uvIndex?: number;
  feelsLikeC?: number;
}

export interface WeatherProvider {
  readonly name: string;
  /** Hourly forecast for roughly the next 48 hours. */
  forecast(location: LatLng): Promise<WeatherHour[]>;
  /** Conditions right now, for the sky behind the app. */
  current(location: LatLng): Promise<CurrentWeather>;
}

/** Injectable fetch so providers can be tested without the network. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
