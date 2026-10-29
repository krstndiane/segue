/**
 * Nominatim as the fallback map source. Fixtures are shaped like real answers
 * seen on 2026-10-29 near Ayala, Makati (14.5547, 121.0244).
 */
import { describe, expect, it } from 'vitest';
import { CachedPlacesProvider, FallbackPlacesProvider, MemoryStore, NominatimPlacesProvider, OsmPlacesProvider, RequestGate, backoffMs, parseNominatimPlaces, viewbox, type FetchFn } from '../src';

const AYALA = { lat: 14.5547, lng: 121.0244 };
const req = { location: AYALA, radiusM: 2000, category: 'gym' as const };
const gymResults = [
  { osm_type: 'way', osm_id: 1, lat: '14.5561', lon: '121.0262', name: 'Don Zanoni Memorial Gym', category: 'building', type: 'roof', extratags: {} },
  { osm_type: 'node', osm_id: 2, lat: '14.5530', lon: '121.0210', name: 'Muscle Town Gym', category: 'leisure', type: 'fitness_centre', extratags: { opening_hours: 'Mo-Sa 06:00-22:00' } },
  { osm_type: 'node', osm_id: 3, lat: '14.5580', lon: '121.0190', name: 'Little Gym', category: 'amenity', type: 'school', extratags: {} },
  { osm_type: 'node', osm_id: 4, lat: '14.5550', lon: '121.0250', name: 'Ulysses Gym', category: 'leisure', type: 'fitness_centre', extratags: null },
  { osm_type: 'node', osm_id: 5, lat: '14.6400', lon: '121.0250', name: 'Far Gym', category: 'leisure', type: 'fitness_centre', extratags: {} },
  { osm_type: 'node', osm_id: 6, lat: 'not-a-number', lon: '121.02', name: 'Broken', category: 'leisure', type: 'fitness_centre' },
];

describe('places from Nominatim search', () => {
  it('keeps only real gyms (not a covered court or a school called "gym"), within the radius, nearest first', () => {
    const out = parseNominatimPlaces(gymResults as never, req, '2026-10-29T02:00:00.000Z');
    expect(out.map((p) => p.name)).toEqual(['Ulysses Gym', 'Muscle Town Gym']);
    expect(out[1]).toMatchObject({ id: 'osm:node/2', source: 'osm', category: 'gym', fetchedAt: '2026-10-29T02:00:00.000Z' });
    expect(out[1]!.hours?.periods).toHaveLength(6);
    expect(out[0]!.hours).toBeNull();
  });

  it('uses the same ids as Overpass, so the same place found both ways is one place', () => {
    expect(parseNominatimPlaces(gymResults as never, req)[0]!.id).toMatch(/^osm:(node|way|relation)\/\d+$/);
  });

  it('asks politely: one request a second, a real User-Agent, a bounded box', async () => {
    const asked: { url: string; ua?: string }[] = [];
    const slept: number[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      asked.push({ url, ua: (init?.headers as Record<string, string>)['user-agent'] });
      return new Response(JSON.stringify(gymResults));
    };
    // Three requests at the same moment: the first goes now, the others wait their turn.
    const gate = new RequestGate(1100, async (ms) => void slept.push(ms), () => 0);
    const p = new NominatimPlacesProvider(fetchFn, 'Segue test (me@example.com)', gate);
    await Promise.all([p.nearby(req), p.nearby({ ...req, category: 'cafe' }), p.nearby({ ...req, category: 'park' })]);
    expect(slept).toEqual([1100, 2200]);
    expect(asked[0]!.ua).toBe('Segue test (me@example.com)');
    expect(asked[0]!.url).toContain(`viewbox=${encodeURIComponent(viewbox(AYALA, 2000))}`);
    expect(asked[0]!.url).toContain('bounded=1');
    expect(asked[0]!.url).toContain(`q=${encodeURIComponent('[leisure=fitness_centre]')}`);
    expect(asked[1]!.url).toContain(`q=${encodeURIComponent('[amenity=cafe]')}`);
  });

  it('fails clearly on an error answer instead of returning nothing as if it were true', async () => {
    const p = new NominatimPlacesProvider(async () => new Response('busy', { status: 503 }), 'x', new RequestGate(0));
    await expect(p.nearby(req)).rejects.toThrow(/503/);
  });

  it('leaves Nominatim alone after it refuses us (429), instead of asking again on every search', async () => {
    // Seen from Render right after the 29 Oct deploy: "[nominatim] search returned 429".
    let now = 0;
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls++;
      return calls === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }) : new Response(JSON.stringify(gymResults));
    };
    const p = new NominatimPlacesProvider(fetchFn, 'x', new RequestGate(0), undefined, () => now);
    await expect(p.nearby(req)).rejects.toThrow(/429/);
    now = 60_000;
    await expect(p.nearby(req)).rejects.toThrow(/slow down/);
    expect(calls).toBe(1);
    now = 121_000;
    expect((await p.nearby(req)).length).toBe(2);
    expect(calls).toBe(2);
  });

  it('waits what Nominatim asks, 5 minutes when it does not say, and never more than 30', () => {
    expect(backoffMs('120', 0)).toBe(120_000);
    expect(backoffMs(null, 0)).toBe(300_000);
    expect(backoffMs('garbage', 0)).toBe(300_000);
    expect(backoffMs('86400', 0)).toBe(1_800_000);
    expect(backoffMs(new Date(90_000).toUTCString(), 0)).toBe(90_000);
  });
});

describe('when the public Overpass servers are at capacity', () => {
  it('Nominatim answers, Overpass rests for a while, and /health can say which source answered', async () => {
    let now = Date.parse('2026-10-29T02:00:00Z');
    let overpassCalls = 0;
    const atCapacity: FetchFn = async () => {
      overpassCalls++;
      return new Response('# 502 Gateway Timeout\nThis Overpass API server is currently at capacity.', { status: 502 });
    };
    const osm = new OsmPlacesProvider(atCapacity, ['https://a.example/api/interpreter'], { clock: () => now, restMs: 600_000 });
    const nominatim = new NominatimPlacesProvider(async () => new Response(JSON.stringify(gymResults)), 'x', new RequestGate(0), undefined, () => now);
    const chain = new FallbackPlacesProvider([osm, nominatim], undefined, () => now);
    const gateway = new CachedPlacesProvider(chain, new MemoryStore(100, () => now), 86_400_000, 3_600_000, () => now);

    expect((await gateway.nearby(req)).map((p) => p.name)).toEqual(['Ulysses Gym', 'Muscle Town Gym']);
    expect(overpassCalls).toBe(1);
    // Another area, a minute later: Overpass is resting, so no wait on it.
    now += 60_000;
    await gateway.nearby({ ...req, location: { lat: 14.6, lng: 121.05 } });
    expect(overpassCalls).toBe(1);
    expect(gateway.status()).toEqual({
      lastAnswer: { provider: 'nominatim', at: '2026-10-29T02:01:00.000Z' },
      lastFailure: { at: '2026-10-29T02:01:00.000Z', message: 'osm: [osm] Overpass is resting after failing; trying again shortly' },
    });
    // After the rest, Overpass is asked again.
    now += 600_000;
    await gateway.nearby({ ...req, location: { lat: 14.7, lng: 121.05 } });
    expect(overpassCalls).toBe(2);
  });
});
