/**
 * Live place data: honest about where it came from and when, never padded
 * with made-up places, and resilient to one map server refusing.
 */
import { describe, expect, it } from 'vitest';
import { openStatusAt, type Place } from '@segue/engine';
import { CachedPlacesProvider, MemoryStore, OsmPlacesProvider, dedupePlaces, parseGooglePlaces, parseOverpass, type FetchFn, type PlacesProvider } from '../src';

const MANILA = { lat: 14.5995, lng: 120.9842 };
const req = { location: MANILA, radiusM: 1000, category: 'gym' as const };
const gym = (id: number, name = `Gym ${id}`, extra: Record<string, string> = {}) => ({ type: 'node' as const, id, lat: 14.6, lon: 121 + id / 1000, tags: { name, ...extra } });

/** A fetch that answers per host, recording which hosts were asked. */
function hosts(answers: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    const host = new URL(url).host;
    asked.push(host);
    const answer = answers[host];
    if (!answer) throw new TypeError('fetch failed');
    return answer();
  };
  return { asked, fetchFn };
}
const ok = (elements: unknown[]) => () => new Response(JSON.stringify({ elements }));

describe('OpenStreetMap servers', () => {
  const A = 'https://a.example/api/interpreter';
  const B = 'https://b.example/api/interpreter';

  it('tries the next server when one refuses, and starts with the one that answered next time', async () => {
    const net = hosts({ 'a.example': () => new Response('rate limited', { status: 429 }), 'b.example': ok([gym(1)]) });
    const osm = new OsmPlacesProvider(net.fetchFn, [A, B]);
    expect((await osm.nearby(req)).map((p) => p.name)).toEqual(['Gym 1']);
    expect(net.asked).toEqual(['a.example', 'b.example']);
    await osm.nearby(req);
    expect(net.asked).toEqual(['a.example', 'b.example', 'b.example']);
  });

  it('fails clearly, naming each server, when none answers (no made-up places)', async () => {
    const net = hosts({ 'a.example': () => new Response('busy', { status: 504 }) });
    const lines: string[] = [];
    const osm = new OsmPlacesProvider(net.fetchFn, [A, B], { log: (l) => lines.push(l) });
    await expect(osm.nearby(req)).rejects.toThrow(/a\.example: \[osm\] Overpass returned 504.*b\.example: \[osm\] fetch failed/);
    expect(lines).toHaveLength(2);
  });

  it('treats an Overpass error remark without results as a failure', async () => {
    const net = hosts({ 'a.example': () => new Response(JSON.stringify({ remark: 'runtime error: Query timed out' })), 'b.example': ok([gym(2)]) });
    expect((await new OsmPlacesProvider(net.fetchFn, [A, B]).nearby(req))[0]!.name).toBe('Gym 2');
  });

  it('stops trying once its time budget is spent', async () => {
    let now = 0;
    const net = hosts({
      'a.example': () => {
        now += 8000;
        return new Response('slow', { status: 504 });
      },
      'b.example': ok([gym(3)]),
    });
    const osm = new OsmPlacesProvider(net.fetchFn, [A, B], { budgetMs: 9000, clock: () => now });
    await expect(osm.nearby(req)).rejects.toThrow(/Overpass/);
    expect(net.asked).toEqual(['a.example']);
  });

  it('times out a server that hangs and moves on', async () => {
    const hang: FetchFn = (url, init) =>
      new URL(url).host === 'a.example'
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
        : Promise.resolve(ok([gym(4)])());
    const osm = new OsmPlacesProvider(hang, [A, B], { timeoutMs: 50, budgetMs: 5000 });
    expect((await osm.nearby(req))[0]!.name).toBe('Gym 4');
  });
});

describe('normalising place data', () => {
  it('skips places with missing or broken coordinates', () => {
    const out = parseOverpass(
      [gym(1), { type: 'node' as const, id: 2, tags: { name: 'No position' } }, { type: 'node' as const, id: 3, lat: Number.NaN, lon: 121, tags: { name: 'Bad' } }],
      'gym',
    );
    expect(out.map((p) => p.name)).toEqual(['Gym 1']);
  });

  it('says when it was fetched and marks places listed as closed', () => {
    const [p, closed] = parseOverpass([gym(1), gym(2, 'Shut Gym', { opening_hours: 'closed' })], 'gym', '2026-10-27T01:00:00.000Z');
    expect(p!.fetchedAt).toBe('2026-10-27T01:00:00.000Z');
    expect(closed!.temporarilyClosed).toBe(true);
  });

  it('merges the same place mapped twice (a building and a point), keeping what each knows', () => {
    const out = parseOverpass(
      [
        { type: 'way' as const, id: 10, center: { lat: 14.6, lon: 121 }, tags: { name: 'Anytime Fitness' } },
        { type: 'node' as const, id: 11, lat: 14.6003, lon: 121.0002, tags: { name: 'ANYTIME  fitness', opening_hours: '24/7' } },
        { type: 'node' as const, id: 12, lat: 14.62, lon: 121, tags: { name: 'Anytime Fitness' } },
      ],
      'gym',
    );
    expect(out.map((p) => p.id)).toEqual(['osm:way/10', 'osm:node/12']);
    expect(out[0]!.hours?.always).toBe(true);
  });

  it('drops places Google lists as permanently closed and marks temporary closures', () => {
    const out = parseGooglePlaces(
      [
        { id: 'a', displayName: { text: 'Open Gym' }, location: { latitude: 14.6, longitude: 121 }, businessStatus: 'OPERATIONAL' },
        { id: 'b', displayName: { text: 'Gone Gym' }, location: { latitude: 14.61, longitude: 121 }, businessStatus: 'CLOSED_PERMANENTLY' },
        { id: 'c', displayName: { text: 'Paused Gym' }, location: { latitude: 14.62, longitude: 121 }, businessStatus: 'CLOSED_TEMPORARILY' },
      ],
      'gym',
    );
    expect(out.map((p) => [p.name, p.temporarilyClosed ?? false])).toEqual([
      ['Open Gym', false],
      ['Paused Gym', true],
    ]);
  });

  it('dedupes across searches by id', () => {
    const a: Place = { id: 'osm:node/1', name: 'X', location: MANILA, category: 'gym', attributes: {}, source: 'osm' };
    expect(dedupePlaces([a, { ...a, name: 'X (copy)' }])).toHaveLength(1);
  });
});

describe('cache', () => {
  const answering = (places: Place[]): PlacesProvider & { calls: number } => {
    const p = { name: 'x', calls: 0, nearby: async () => { p.calls++; return places; } };
    return p;
  };

  it('keeps the original fetch time on cached answers', async () => {
    let now = Date.parse('2026-10-27T01:00:00Z');
    const inner = answering([{ id: 'p', name: 'P', location: MANILA, category: 'gym', attributes: {}, source: 'osm' }]);
    const cached = new CachedPlacesProvider(inner, new MemoryStore(100, () => now), 86_400_000, 3_600_000, () => now);
    expect((await cached.nearby(req))[0]!.fetchedAt).toBe('2026-10-27T01:00:00.000Z');
    now += 30 * 60_000;
    expect((await cached.nearby(req))[0]!.fetchedAt).toBe('2026-10-27T01:00:00.000Z');
    expect(inner.calls).toBe(1);
  });

  it('asks again sooner after an empty answer', async () => {
    let now = 0;
    const inner = answering([]);
    const cached = new CachedPlacesProvider(inner, new MemoryStore(100, () => now), 86_400_000, 3_600_000, () => now);
    await cached.nearby(req);
    now = 3_600_001;
    await cached.nearby(req);
    expect(inner.calls).toBe(2);
  });
});

describe('open status', () => {
  const tz = 480;
  const at = (hm: string) => Date.parse(`2026-10-27T${hm}:00+08:00`); // a Tuesday
  const place = (hours: Place['hours'], extra: Partial<Place> = {}) => ({ hours, ...extra });
  const daily = (open: string, close: string) => ({ periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close })) });

  it('reads listed hours in the place’s local time', () => {
    expect(openStatusAt(place(daily('06:00', '22:00')), at('17:00'), tz)).toEqual({ status: 'open', closesAt: at('22:00') });
    expect(openStatusAt(place(daily('06:00', '22:00')), at('23:00'), tz)).toEqual({ status: 'closed', opensAt: Date.parse('2026-10-28T06:00:00+08:00') });
  });

  it('handles hours past midnight and 24/7', () => {
    expect(openStatusAt(place(daily('18:00', '02:00')), at('01:00'), tz).status).toBe('open');
    expect(openStatusAt(place({ always: true, periods: [] }), at('03:00'), tz)).toEqual({ status: 'open', closesAt: null });
  });

  it('never claims open without hours, and respects a temporary closure', () => {
    expect(openStatusAt(place(null), at('12:00'), tz).status).toBe('unknown');
    expect(openStatusAt(place(daily('06:00', '22:00'), { temporarilyClosed: true }), at('12:00'), tz).status).toBe('temporarily-closed');
  });
});
