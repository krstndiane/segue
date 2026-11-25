import { describe, expect, it } from 'vitest';
import { CachedPlacesProvider, CachedWeatherProvider, MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { DynamoStore, type DynamoLike } from '../src/dynamoStore';
import { buildCacheStores } from '../src/providers';

type Attr = { S?: string; N?: string };

/** An in-memory stand-in for the two DynamoDB calls, keyed like the real table (pk + sk). */
function fakeDynamo() {
  const items = new Map<string, Record<string, Attr>>();
  const calls: string[] = [];
  let failing = false;
  const client: DynamoLike = {
    async getItem({ TableName, Key }) {
      calls.push(`get ${TableName}`);
      if (failing) throw Object.assign(new Error('boom'), { name: 'ServiceUnavailable' });
      return { Item: items.get(`${Key.pk!.S}|${Key.sk!.S}`) };
    },
    async putItem({ TableName, Item }) {
      calls.push(`put ${TableName}`);
      if (failing) throw Object.assign(new Error('boom'), { name: 'ServiceUnavailable' });
      items.set(`${Item.pk!.S}|${Item.sk!.S}`, Item);
      return {};
    },
  };
  return { client, items, calls, fail: (v: boolean) => (failing = v) };
}

describe('DynamoStore', () => {
  it('stores JSON with a TTL in epoch seconds and reads it back', async () => {
    const db = fakeDynamo();
    let now = 1_700_000_000_000;
    const store = new DynamoStore<{ a: number }>(db.client, 'segue-cache', () => now);
    await store.set('places:abc', { a: 1 }, 60_000);
    const item = [...db.items.values()][0]!;
    expect(item.v!.S).toBe('{"a":1}');
    expect(item.ttl!.N).toBe(String(Math.ceil((now + 60_000) / 1000)));
    expect(item.sk!.S).toBe('v1');
    expect(await store.get('places:abc')).toEqual({ a: 1 });
    expect(db.calls).toEqual(['put segue-cache', 'get segue-cache']);
  });

  it('treats expired items as missing even before DynamoDB deletes them', async () => {
    const db = fakeDynamo();
    let now = 1_700_000_000_000;
    const store = new DynamoStore<string>(db.client, 't', () => now);
    await store.set('k', 'v', 1_000);
    now += 2_000;
    expect(await store.get('k')).toBeUndefined();
  });

  it('returns a miss for unknown keys', async () => {
    const store = new DynamoStore<string>(fakeDynamo().client, 't');
    expect(await store.get('nope')).toBeUndefined();
  });

  it('never throws: a failed read is a miss and a failed write is skipped, logged without the key', async () => {
    const db = fakeDynamo();
    const logs: string[] = [];
    const store = new DynamoStore<string>(db.client, 't', Date.now, (l) => logs.push(l));
    db.fail(true);
    await expect(store.set('places:u4pruy:cafe:1000', 'v', 1000)).resolves.toBeUndefined();
    await expect(store.get('places:u4pruy:cafe:1000')).resolves.toBeUndefined();
    expect(logs).toEqual(['cache write failed: ServiceUnavailable', 'cache read failed: ServiceUnavailable']);
    expect(logs.join(' ')).not.toContain('u4pruy');
  });
});

describe('a shared table lets a new server copy reuse answers', () => {
  const req = { location: { lat: 7.07, lng: 125.61 }, radiusM: 1500, category: 'cafe' as const, limit: 5 };

  it('places: a second CachedPlacesProvider (a fresh Lambda) gets a cache hit', async () => {
    const db = fakeDynamo();
    const first = new CachedPlacesProvider(new MockPlacesProvider(), new DynamoStore(db.client, 't'));
    const second = new CachedPlacesProvider(new MockPlacesProvider(), new DynamoStore(db.client, 't'));
    const a = await first.nearby(req as never);
    const b = await second.nearby(req as never);
    expect(first.misses).toBe(1);
    expect(second.hits).toBe(1);
    expect(second.misses).toBe(0);
    expect(b).toEqual(a);
  });

  it('weather: CachedWeatherProvider uses an injected async store', async () => {
    const db = fakeDynamo();
    let asked = 0;
    const inner: WeatherProvider = {
      name: 'fake',
      forecast: async () => [],
      current: async () => {
        asked++;
        return { condition: 'rain', isDay: false, temperatureC: 26, observedAt: '2026-11-28T09:00:00Z' };
      },
    };
    const first = new CachedWeatherProvider(inner, { store: new DynamoStore(db.client, 't') });
    const second = new CachedWeatherProvider(inner, { store: new DynamoStore(db.client, 't') });
    await first.current({ lat: 7.07, lng: 125.61 });
    const again = await second.current({ lat: 7.07, lng: 125.61 });
    expect(asked).toBe(1);
    expect(again.condition).toBe('rain');
  });

  it('buildCacheStores is off unless CACHE_STORE=dynamodb', async () => {
    expect(await buildCacheStores({ cacheStore: 'memory' })).toBeUndefined();
    const stores = await buildCacheStores({ cacheStore: 'dynamodb', cacheTable: 't' }, fakeDynamo().client);
    expect(stores && Object.keys(stores).sort()).toEqual(['placeNames', 'places', 'weather']);
  });
});
