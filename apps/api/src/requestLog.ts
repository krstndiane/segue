/**
 * One JSON log line per request (LOG_FORMAT=json), with CloudWatch embedded
 * metric format (EMF) so metrics come from the log line itself.
 *
 * Privacy: only the route (path, never the query string, with unknown path
 * segments masked), status, duration, map source and cache result. No
 * coordinates, emails, user ids or headers.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NearbyRequest, PlacesProvider, PlacesStatus } from '@segue/providers';

type Place = Awaited<ReturnType<PlacesProvider['nearby']>>[number];

export interface RequestFacts {
  placesLookups: number;
  cacheHits: number;
  cacheMisses: number;
  /** The map source that answered the last uncached lookup, or "none" when every source failed. */
  provider?: string;
}

const store = new AsyncLocalStorage<RequestFacts>();

/** Adds to the current request's facts; does nothing outside a logged request. */
export function noteRequest(update: (f: RequestFacts) => void): void {
  const f = store.getStore();
  if (f) update(f);
}

const KNOWN_ROUTES = new Set([
  '/health',
  '/v1/auth/google',
  '/v1/places/nearby',
  '/v1/weather/now',
  '/v1/place-name',
  '/v1/weather',
  '/v1/understand',
  '/v1/assistant',
  '/v1/alternatives',
  '/v1/reroute',
]);
const REROUTE_ROUTES = new Set(['/v1/alternatives', '/v1/reroute']);

/** The path only. Known routes as they are; anything else keeps two segments and masks the rest (they may hold ids or names). */
export function routeOf(rawUrl: string | undefined): string {
  const path = (rawUrl ?? '/').split('?')[0]!.split('#')[0]!;
  if (KNOWN_ROUTES.has(path)) return path;
  const parts = path.split('/').filter(Boolean);
  // Keep version segments (v1) and plain words (people); mask anything that could be an id or a name with digits.
  const safe = parts.slice(0, 2).map((p) => (/^(v\d{1,3}|[a-z][a-z-]{0,30})$/.test(p) ? p : ':id'));
  return '/' + safe.join('/') + (parts.length > 2 ? '/*' : '');
}

export function requestLine(method: string, route: string, status: number, ms: number, facts: RequestFacts, now: number): string {
  const directives: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] = [];
  const line: Record<string, unknown> = { level: 'info', msg: 'request', method, route, status, ms: Math.round(ms) };
  if (facts.placesLookups) {
    const source = facts.provider ?? (facts.cacheMisses ? 'none' : 'cache');
    Object.assign(line, { provider: source, cache: facts.cacheMisses ? 'miss' : 'hit', CacheHit: facts.cacheHits, CacheMiss: facts.cacheMisses, PlacesSource: source, PlacesLookups: facts.placesLookups });
    directives.push({ Namespace: 'Segue', Dimensions: [[]], Metrics: [{ Name: 'CacheHit', Unit: 'Count' }, { Name: 'CacheMiss', Unit: 'Count' }] });
    directives.push({ Namespace: 'Segue', Dimensions: [['PlacesSource']], Metrics: [{ Name: 'PlacesLookups', Unit: 'Count' }] });
  }
  if (REROUTE_ROUTES.has(route) && status < 500) {
    line.RerouteMs = Math.round(ms);
    directives.push({ Namespace: 'Segue', Dimensions: [[]], Metrics: [{ Name: 'RerouteMs', Unit: 'Milliseconds' }] });
  }
  if (directives.length) line._aws = { Timestamp: now, CloudWatchMetrics: directives };
  return JSON.stringify(line);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Wraps the app so each request gets its own facts and ends with one JSON line. */
export function withRequestLog(handler: Handler, emit: (line: string) => void = (l) => console.log(l), clock: () => number = () => performance.now(), now: () => number = Date.now): Handler {
  return (req, res) => {
    const facts: RequestFacts = { placesLookups: 0, cacheHits: 0, cacheMisses: 0 };
    const t0 = clock();
    res.on('finish', () => emit(requestLine(req.method ?? 'GET', routeOf(req.url), res.statusCode, clock() - t0, facts, now())));
    return store.run(facts, () => handler(req, res));
  };
}

/**
 * Records, per request, whether a places lookup came from the cache and which map source answered.
 * Wraps the cached provider without changing it: compares its hit counter around each call.
 */
export class ObservedPlacesProvider implements PlacesProvider {
  readonly name: string;
  constructor(
    private readonly cached: PlacesProvider & { hits: number },
    private readonly source: { status(): PlacesStatus },
  ) {
    this.name = cached.name;
  }

  status(): PlacesStatus {
    return this.cached.status?.() ?? this.source.status();
  }

  async nearby(req: NearbyRequest): Promise<Place[]> {
    const before = this.cached.hits;
    try {
      const out = await this.cached.nearby(req);
      const hit = this.cached.hits > before;
      noteRequest((f) => {
        f.placesLookups++;
        if (hit) f.cacheHits++;
        else {
          f.cacheMisses++;
          f.provider = this.source.status().lastAnswer?.provider ?? 'none';
        }
      });
      return out;
    } catch (e) {
      noteRequest((f) => {
        f.placesLookups++;
        f.cacheMisses++;
        f.provider = 'none';
      });
      throw e;
    }
  }
}
