/**
 * The Places Gateway's cost controls: a TTL cache keyed by geohash cell,
 * a fallback chain, and a daily call budget per provider.
 * In-memory here; the same interface can be backed by Redis.
 */
import type { Place } from '@segue/engine';
import { geohash } from './geohash';
import type { NearbyRequest, PlacesProvider, PlacesStatus } from './types';

export interface KeyValueStore<T> {
  get(key: string): T | undefined | Promise<T | undefined>;
  set(key: string, value: T, ttlMs: number): void | Promise<void>;
}

export class MemoryStore<T> implements KeyValueStore<T> {
  private readonly map = new Map<string, { value: T; expires: number }>();
  constructor(
    private readonly maxEntries = 5000,
    private readonly clock: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.clock()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: this.clock() + ttlMs });
  }

  get size() {
    return this.map.size;
  }
}

/** Radius bucket so nearby requests with similar radii share a cache entry. */
function radiusBucket(m: number): number {
  return m <= 1000 ? 1000 : m <= 2000 ? 2000 : m <= 5000 ? 5000 : 10000;
}

export function cacheKey(req: NearbyRequest): string {
  return `places:${geohash(req.location.lat, req.location.lng, 6)}:${req.category}:${radiusBucket(req.radiusM)}`;
}

export class CachedPlacesProvider implements PlacesProvider {
  readonly name: string;
  hits = 0;
  misses = 0;
  constructor(
    private readonly inner: PlacesProvider,
    private readonly store: KeyValueStore<Place[]> = new MemoryStore(),
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly emptyTtlMs = 60 * 60 * 1000,
    private readonly clock: () => number = Date.now,
  ) {
    this.name = `cached(${inner.name})`;
  }

  status(): PlacesStatus {
    return this.inner.status?.() ?? { lastAnswer: null, lastFailure: null };
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    const key = cacheKey(req);
    const cached = await this.store.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const fetchedAt = new Date(this.clock()).toISOString();
    const places = (await this.inner.nearby({ ...req, radiusM: radiusBucket(req.radiusM) })).map((p) => (p.fetchedAt ? p : { ...p, fetchedAt }));
    // An empty answer may just be a quiet moment for the map server; ask again sooner.
    await this.store.set(key, places, places.length ? this.ttlMs : Math.min(this.ttlMs, this.emptyTtlMs));
    return places;
  }
}

/** Try providers in order; the first that answers wins. */
export class FallbackPlacesProvider implements PlacesProvider {
  readonly name: string;
  lastErrors: string[] = [];
  private answered: PlacesStatus['lastAnswer'] = null;
  private failed: PlacesStatus['lastFailure'] = null;
  constructor(
    private readonly chain: PlacesProvider[],
    private readonly log?: (line: string) => void,
    private readonly clock: () => number = Date.now,
  ) {
    if (!chain.length) throw new Error('FallbackPlacesProvider needs at least one provider');
    this.name = chain.map((p) => p.name).join('→');
  }

  status(): PlacesStatus {
    return { lastAnswer: this.answered, lastFailure: this.failed };
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    this.lastErrors = [];
    for (const p of this.chain) {
      try {
        const places = await p.nearby(req);
        this.answered = { provider: p.name, at: new Date(this.clock()).toISOString() };
        return places;
      } catch (e) {
        const message = `${p.name}: ${(e as Error).message}`.slice(0, 300);
        this.lastErrors.push(message);
        this.failed = { at: new Date(this.clock()).toISOString(), message };
        this.log?.(`places: ${p.name} failed for ${req.category}: ${(e as Error).message}`);
      }
    }
    throw new Error(`All place providers failed: ${this.lastErrors.join('; ')}`);
  }
}

/** Stop calling a paid provider once a daily budget is spent. */
export class BudgetedPlacesProvider implements PlacesProvider {
  readonly name: string;
  private day = '';
  private used = 0;
  constructor(
    private readonly inner: PlacesProvider,
    private readonly maxCallsPerDay: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.name = `budget(${inner.name})`;
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.maxCallsPerDay) throw new Error(`daily budget of ${this.maxCallsPerDay} calls reached`);
    this.used++;
    return this.inner.nearby(req);
  }

  get remaining() {
    return Math.max(0, this.maxCallsPerDay - this.used);
  }
}
