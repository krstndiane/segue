/**
 * Keeping the sky alive when the main weather service says no.
 *   MetNoProvider            MET Norway's forecast, used as the backup (free, no key)
 *   FallbackWeatherProvider  primary first; on failure, the backup, and the primary is skipped for a while
 *   CachedWeatherProvider    shares one answer per ~5 km cell, and serves a recent one when the source is down
 * Open-Meteo's free tier is limited per IP address, and shared hosts burn through it, so the server must
 * not ask it for every visitor.
 */
import type { LatLng, WeatherHour } from '@segue/engine';
import { MemoryStore, type KeyValueStore } from './cache';
import { geohash } from './geohash';
import { ProviderError, fetchWithTimeout, type CurrentWeather, type FetchFn, type SkyCondition, type UpcomingHour, type WeatherProvider } from './types';

/** MET Norway symbol code ("lightrainshowers_day") → one of the skies, plus day or night. */
export function skyFromMetSymbol(symbol: string | undefined): { condition: SkyCondition; isDay: boolean } {
  const s = (symbol ?? '').toLowerCase();
  const isDay = !s.endsWith('_night');
  const base = s.replace(/_(day|night|polartwilight)$/, '');
  let condition: SkyCondition;
  if (base.includes('thunder')) condition = 'storm';
  else if (base.includes('rain') || base.includes('sleet')) condition = base.startsWith('heavy') ? 'heavy-rain' : 'rain';
  else if (base.includes('snow')) condition = 'cloudy'; // like Open-Meteo's mapping: no snow sky yet
  else if (base.includes('fog')) condition = 'fog';
  else if (base === 'partlycloudy') condition = 'partly-cloudy';
  else if (base === 'clearsky' || base === 'fair') condition = 'clear';
  else condition = 'cloudy';
  return { condition, isDay };
}

/** "Feels like" from air temperature (°C), relative humidity (%) and wind (m/s): the Steadman apparent temperature. */
export function apparentTemperatureC(tempC: number, humidityPct: number, windMs: number): number {
  const vapour = (humidityPct / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  return Math.round((tempC + 0.33 * vapour - 0.7 * windMs - 4) * 10) / 10;
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

interface MetEntry {
  time: string;
  data?: {
    instant?: {
      details?: {
        air_temperature?: number;
        relative_humidity?: number;
        wind_speed?: number;
        wind_speed_of_gust?: number;
        ultraviolet_index_clear_sky?: number;
      };
    };
    next_1_hours?: {
      summary?: { symbol_code?: string };
      details?: { precipitation_amount?: number; probability_of_precipitation?: number };
    };
  };
}

/**
 * MET Norway Locationforecast (CC BY 4.0, credit "Weather data from MET Norway").
 * Their rules: an identifying User-Agent with contact details, coordinates cut to 4 decimals.
 * It reports no time zone, so `utcOffsetMinutes` is left out and the phone uses its own.
 */
export class MetNoProvider implements WeatherProvider {
  readonly name = 'met.no';
  constructor(
    private readonly fetchFn: FetchFn = fetch,
    private readonly userAgent = 'Segue day planner',
    private readonly endpoint = 'https://api.met.no/weatherapi/locationforecast/2.0/complete',
  ) {}

  private async load(location: LatLng): Promise<MetEntry[]> {
    const params = new URLSearchParams({ lat: location.lat.toFixed(4), lon: location.lng.toFixed(4) });
    const res = await fetchWithTimeout(this.fetchFn, `${this.endpoint}?${params}`, {
      timeoutMs: 6000,
      headers: { 'user-agent': this.userAgent, accept: 'application/json' },
    });
    if (!res.ok) throw new ProviderError(this.name, `forecast returned ${res.status}`, res.status);
    const json = (await res.json()) as { properties?: { timeseries?: MetEntry[] } };
    const series = json.properties?.timeseries;
    if (!series?.length) throw new ProviderError(this.name, 'forecast missing');
    return series;
  }

  /** Rain chance as 0–100: MET's own figure, or 100 when rain is expected but no chance is given. */
  private rainChance(e: MetEntry): number {
    const next = e.data?.next_1_hours?.details;
    const chance = finite(next?.probability_of_precipitation) ?? ((finite(next?.precipitation_amount) ?? 0) > 0 ? 100 : 0);
    return Math.min(100, Math.max(0, chance));
  }

  private feelsLike(e: MetEntry): number | undefined {
    const d = e.data?.instant?.details;
    const t = finite(d?.air_temperature);
    const rh = finite(d?.relative_humidity);
    const wind = finite(d?.wind_speed);
    return t === undefined || rh === undefined || wind === undefined ? undefined : apparentTemperatureC(t, rh, wind);
  }

  async forecast(location: LatLng): Promise<WeatherHour[]> {
    const series = await this.load(location);
    return series
      .filter((e) => e.data?.next_1_hours)
      .slice(0, 48)
      .map((e) => ({
        time: e.time,
        precipitationProbability: this.rainChance(e),
        temperatureC: finite(e.data?.instant?.details?.air_temperature),
      }));
  }

  async current(location: LatLng): Promise<CurrentWeather> {
    const series = await this.load(location);
    const hourly = series.filter((e) => e.data?.next_1_hours);
    const now = hourly[0] ?? series[0]!;
    const d = now.data?.instant?.details;
    const sky = skyFromMetSymbol(now.data?.next_1_hours?.summary?.symbol_code);
    const gust = finite(d?.wind_speed_of_gust);
    const upcoming: UpcomingHour[] = hourly.slice(0, 12).map((e) => ({
      time: e.time,
      rainChance: this.rainChance(e),
      // The clear-sky index is the most the sun can give, so sun advice errs on the cautious side.
      uvIndex: finite(e.data?.instant?.details?.ultraviolet_index_clear_sky),
      feelsLikeC: this.feelsLike(e),
    }));
    return {
      condition: sky.condition,
      isDay: sky.isDay,
      temperatureC: finite(d?.air_temperature),
      feelsLikeC: this.feelsLike(now),
      uvIndex: finite(d?.ultraviolet_index_clear_sky),
      gustKmh: gust === undefined ? undefined : Math.round(gust * 3.6),
      precipitationMm: finite(now.data?.next_1_hours?.details?.precipitation_amount),
      observedAt: now.time,
      upcoming,
    };
  }
}

/** Primary first. If it fails, the backup answers, and the primary is left alone for `cooldownMs` so a blocked source isn't hit on every request. */
export class FallbackWeatherProvider implements WeatherProvider {
  readonly name: string;
  private skipPrimaryUntil = 0;
  constructor(
    private readonly primary: WeatherProvider,
    private readonly backup: WeatherProvider,
    private readonly cooldownMs = 5 * 60 * 1000,
    private readonly clock: () => number = Date.now,
    private readonly onFallback: (error: Error) => void = () => {},
  ) {
    this.name = `${primary.name}→${backup.name}`;
  }

  forecast(location: LatLng) {
    return this.run((p) => p.forecast(location));
  }

  current(location: LatLng) {
    return this.run((p) => p.current(location));
  }

  private async run<T>(call: (p: WeatherProvider) => Promise<T>): Promise<T> {
    if (this.clock() >= this.skipPrimaryUntil) {
      try {
        return await call(this.primary);
      } catch (e) {
        this.skipPrimaryUntil = this.clock() + this.cooldownMs;
        this.onFallback(e as Error);
      }
    }
    return call(this.backup);
  }
}

export interface WeatherCacheOptions {
  /** How long a "now" answer is shared before asking again. */
  currentTtlMs?: number;
  forecastTtlMs?: number;
  /** How long an old answer may still be served when the source is failing. */
  currentStaleMs?: number;
  forecastStaleMs?: number;
  clock?: () => number;
  /** Where answers are kept. Defaults to an in-memory store; a shared store (e.g. DynamoDB) lets many servers reuse them. */
  store?: KeyValueStore<{ value: unknown; at: number }>;
}

/**
 * One answer per ~5 km cell (geohash 5), shared by everyone in it, and asked for once at a time.
 * When a refresh fails, a recent enough answer is served instead of an error.
 */
export class CachedWeatherProvider implements WeatherProvider {
  readonly name: string;
  hits = 0;
  misses = 0;
  stale = 0;
  private readonly store: KeyValueStore<{ value: unknown; at: number }>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly clock: () => number;
  private readonly opts: Required<Omit<WeatherCacheOptions, 'clock' | 'store'>>;

  constructor(
    private readonly inner: WeatherProvider,
    opts: WeatherCacheOptions = {},
  ) {
    this.name = `cached(${inner.name})`;
    this.clock = opts.clock ?? Date.now;
    this.store = opts.store ?? new MemoryStore(2000, this.clock);
    this.opts = {
      currentTtlMs: opts.currentTtlMs ?? 10 * 60 * 1000,
      forecastTtlMs: opts.forecastTtlMs ?? 30 * 60 * 1000,
      currentStaleMs: opts.currentStaleMs ?? 2 * 60 * 60 * 1000,
      forecastStaleMs: opts.forecastStaleMs ?? 6 * 60 * 60 * 1000,
    };
  }

  forecast(location: LatLng): Promise<WeatherHour[]> {
    return this.cached('forecast', location, this.opts.forecastTtlMs, this.opts.forecastStaleMs, () => this.inner.forecast(location));
  }

  current(location: LatLng): Promise<CurrentWeather> {
    return this.cached('current', location, this.opts.currentTtlMs, this.opts.currentStaleMs, () => this.inner.current(location));
  }

  private async cached<T>(kind: string, location: LatLng, ttlMs: number, staleMs: number, load: () => Promise<T>): Promise<T> {
    const key = `${kind}:${geohash(location.lat, location.lng, 5)}`;
    const old = (await this.store.get(key)) as { value: T; at: number } | undefined;
    if (old && this.clock() - old.at < ttlMs) {
      this.hits++;
      return old.value;
    }
    let pending = this.inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      this.misses++;
      pending = load()
        .then(async (value) => {
          await this.store.set(key, { value, at: this.clock() }, staleMs);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    try {
      return await pending;
    } catch (e) {
      if (old) {
        this.stale++;
        return old.value;
      }
      throw e;
    }
  }
}
