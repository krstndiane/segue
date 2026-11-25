import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CachedPlacesProvider, FallbackPlacesProvider, MockPlacesProvider } from '@segue/providers';
import { ObservedPlacesProvider, requestLine, routeOf, withRequestLog } from '../src/requestLog';

describe('routeOf', () => {
  it('drops the query string and keeps known routes', () => {
    expect(routeOf('/v1/places/nearby?lat=7.07&lng=125.61&category=cafe')).toBe('/v1/places/nearby');
    expect(routeOf('/health')).toBe('/health');
  });
  it('masks unknown path segments that could be ids or names', () => {
    expect(routeOf('/v1/people/diane.aviles/notes')).toBe('/v1/people/*');
    expect(routeOf('/v1/3f2a9c1e-uuid')).toBe('/v1/:id');
    expect(routeOf('/v2/notes')).toBe('/v2/notes');
    expect(routeOf('/v1/user42')).toBe('/v1/:id');
  });
});

describe('requestLine', () => {
  it('writes EMF metrics for places lookups and re-route time', () => {
    const line = JSON.parse(requestLine('POST', '/v1/alternatives', 200, 812.4, { placesLookups: 3, cacheHits: 2, cacheMisses: 1, provider: 'osm' }, 1_764_300_000_000));
    expect(line).toMatchObject({ method: 'POST', route: '/v1/alternatives', status: 200, ms: 812, provider: 'osm', cache: 'miss', CacheHit: 2, CacheMiss: 1, PlacesSource: 'osm', PlacesLookups: 3, RerouteMs: 812 });
    const names = line._aws.CloudWatchMetrics.flatMap((d: { Metrics: { Name: string }[] }) => d.Metrics.map((m) => m.Name));
    expect(names).toEqual(['CacheHit', 'CacheMiss', 'PlacesLookups', 'RerouteMs']);
    expect(line._aws.Timestamp).toBe(1_764_300_000_000);
  });
  it('adds no metrics block for a plain request', () => {
    expect(JSON.parse(requestLine('GET', '/health', 200, 3, { placesLookups: 0, cacheHits: 0, cacheMisses: 0 }, 0))._aws).toBeUndefined();
  });
});

describe('withRequestLog end to end', () => {
  const lines: string[] = [];
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const sources = new FallbackPlacesProvider([new MockPlacesProvider()]);
    const places = new ObservedPlacesProvider(new CachedPlacesProvider(sources), sources);
    const app = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const out = await places.nearby({ location: { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) }, radiusM: 1000, category: 'cafe', limit: 3 } as never);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.length));
    };
    server = createServer(withRequestLog(app, (l) => lines.push(l)));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('logs miss then hit, and never the coordinates, query or headers', async () => {
    await fetch(`${base}/v1/places/nearby?lat=7.0731&lng=125.6128&category=cafe`, { headers: { authorization: 'Bearer secret-token', 'x-user': 'diane@example.com' } });
    await fetch(`${base}/v1/places/nearby?lat=7.0731&lng=125.6128&category=cafe`);
    await new Promise((r) => setTimeout(r, 20));
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((l) => JSON.parse(l));
    expect(first).toMatchObject({ route: '/v1/places/nearby', cache: 'miss', provider: 'mock', status: 200 });
    expect(second).toMatchObject({ cache: 'hit', CacheHit: 1, CacheMiss: 0 });
    for (const l of lines) {
      expect(l).not.toMatch(/7\.07|125\.61|lat=|lng=|\?|secret-token|example\.com|authorization/);
    }
  });
});
