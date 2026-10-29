import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { clientKey, createApp } from '../src/app';
import { DailyCap } from '../src/rateLimit';
import { tidyBlocks } from '../src/understand';

/** Every position the fake providers were asked about. */
const asked: { lat: number; lng: number }[] = [];

const weather: WeatherProvider = {
  name: 'fake',
  forecast: async () => [{ time: '2026-10-19T06:00:00Z', precipitationProbability: 10 }],
  current: async ({ lat, lng }) => {
    asked.push({ lat, lng });
    if (lat > 80) throw new Error('upstream down');
    return { condition: 'storm', isDay: true, temperatureC: 25, observedAt: '2026-10-19T06:00:00Z' };
  },
};

const ctx = {
  now: '2026-10-19T14:00:00+08:00',
  endOfDay: '2026-10-19T22:00:00+08:00',
  location: { lat: 14.5995, lng: 120.9842 },
  energy: 'medium',
  mode: 'walk',
  utcOffsetMinutes: 480,
};
const blocks = [
  { id: 'work', title: 'Deep work', minMinutes: 60, maxMinutes: 90, priority: 'must', category: 'cafe', requirements: ['wifi'] },
  { id: 'gym', title: 'Gym', minMinutes: 45, maxMinutes: 60, priority: 'should', category: 'gym', requirements: [], fallback: 'Home workout' },
  { id: 'call', title: 'Call family', minMinutes: 20, maxMinutes: 30, priority: 'nice', category: 'none', requirements: [] },
];

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer(
    createApp({
      config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 5 },
      places: new MockPlacesProvider(),
      weather,
      geocoder: {
        name: 'fake',
        placeName: async ({ lat, lng }) => {
          asked.push({ lat, lng });
          return lat > 80 ? null : 'Poblacion, Makati';
        },
      },
      log: () => {},
    }),
  );
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('API', () => {
  it('reports health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, places: 'mock', weather: 'fake', smartAdd: false, accounts: false, assistant: 'basic' });
  });

  it('re-routes a day and returns the plan, alternatives, and candidates', async () => {
    const res = await post('/v1/reroute', { blocks, context: ctx }, { 'x-forwarded-for': '10.0.0.1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      plan: { items: { blockId: string; place?: { id: string } }[]; unscheduled: unknown[] };
      candidates: Record<string, unknown[]>;
      meta: { placesProvider: string; weather: boolean };
    };
    expect(body.plan.items.map((i) => i.blockId).sort()).toEqual(['call', 'gym', 'work']);
    expect(body.plan.items.find((i) => i.blockId === 'work')?.place?.id).toMatch(/^mock:/);
    expect(Object.keys(body.candidates).sort()).toEqual(['gym', 'work']);
    expect(body.meta).toMatchObject({ placesProvider: 'mock', weather: true });
  });

  it('uses client-supplied candidates when given (offline cache)', async () => {
    const candidates = {
      work: [{ id: 'mine', name: 'My Café', location: ctx.location, category: 'cafe', attributes: { wifi: true }, hours: null, source: 'client' }],
    };
    const res = await post('/v1/reroute', { blocks: [blocks[0]], context: ctx, candidates }, { 'x-forwarded-for': '10.0.0.2' });
    const body = (await res.json()) as { plan: { items: { place?: { id: string } }[] }; meta: { placesProvider: string } };
    expect(body.plan.items[0]?.place?.id).toBe('mine');
    expect(body.meta.placesProvider).toBe('client');
  });

  it('keeps two clashing commitments and says so, instead of dropping one', async () => {
    const meeting = (id: string, start: string, end: string) => ({
      id, title: id, minMinutes: 30, maxMinutes: 30, priority: 'must', category: 'none', requirements: [],
      fixed: { start: `2026-10-19T${start}:00+08:00`, end: `2026-10-19T${end}:00+08:00` },
    });
    const res = await post('/v1/reroute', { blocks: [meeting('Class', '15:00', '16:00'), meeting('Dentist', '15:30', '16:30')], context: ctx }, { 'x-forwarded-for': '10.0.0.5' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { items: { blockId: string; conflict?: string }[]; unscheduled: unknown[] } };
    expect(body.plan.unscheduled).toEqual([]);
    expect(body.plan.items.map((i) => [i.blockId, i.conflict])).toEqual([
      ['Class', 'Overlaps Dentist (3:30 PM–4:30 PM)'],
      ['Dentist', 'Overlaps Class (3:00 PM–4:00 PM)'],
    ]);
  });

  it('rejects invalid requests with readable details', async () => {
    const res = await post('/v1/reroute', { blocks: [{ ...blocks[0], maxMinutes: 10 }], context: ctx }, { 'x-forwarded-for': '10.0.0.3' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: string[] };
    expect(body.details.join(' ')).toMatch(/maxMinutes/);
  });

  it('rejects non-JSON bodies', async () => {
    const res = await fetch(`${base}/v1/reroute`, { method: 'POST', body: 'not json', headers: { 'x-forwarded-for': '10.0.0.4' } });
    expect(res.status).toBe(400);
  });

  it('rate-limits re-routes per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post('/v1/reroute', { blocks: [blocks[2]], context: ctx }, { 'x-forwarded-for': '10.0.0.9' });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('serves nearby places with validated queries', async () => {
    const ok = await fetch(`${base}/v1/places/nearby?lat=14.6&lng=121&category=gym`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { places: unknown[] }).places.length).toBeGreaterThan(0);
    const bad = await fetch(`${base}/v1/places/nearby?lat=14.6&lng=121&category=spaceport`);
    expect(bad.status).toBe(400);
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const allowed = await fetch(`${base}/v1/reroute`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const denied = await fetch(`${base}/v1/reroute`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns 404 for unknown routes', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('names the area for the location pin', async () => {
    expect(await (await fetch(`${base}/v1/place-name?lat=14.56&lng=121.03`)).json()).toEqual({ name: 'Poblacion, Makati' });
    expect(await (await fetch(`${base}/v1/place-name?lat=85&lng=121`)).json()).toEqual({ name: null });
    expect((await fetch(`${base}/v1/place-name?lng=121`)).status).toBe(400);
  });

  it('returns the current sky', async () => {
    const res = await fetch(`${base}/v1/weather/now?lat=14.6&lng=121`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ now: { condition: 'storm', isDay: true, temperatureC: 25, observedAt: '2026-10-19T06:00:00Z' } });
  });

  it('rounds the position to about 1 km before asking for the sky or a place name', async () => {
    asked.length = 0;
    await fetch(`${base}/v1/weather/now?lat=14.554712&lng=121.024438`);
    await fetch(`${base}/v1/place-name?lat=14.554712&lng=121.024438`);
    expect(asked).toEqual([
      { lat: 14.55, lng: 121.02 },
      { lat: 14.55, lng: 121.02 },
    ]);
  });

  it('says plainly when the current sky is unavailable', async () => {
    expect((await fetch(`${base}/v1/weather/now?lng=121`)).status).toBe(400);
    const res = await fetch(`${base}/v1/weather/now?lat=85&lng=121`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'Weather is unavailable right now' });
  });

  it('says smart add is off when the server has no Claude access', async () => {
    const res = await post('/v1/understand', { text: 'gym after 5', localTime: 'Monday 09:00' });
    expect(res.status).toBe(404);
  });

  it('puts saved places in front of the search results', async () => {
    const favorite = {
      id: 'fav_cafe',
      name: 'My usual café',
      location: { lat: 14.5996, lng: 120.9843 },
      category: 'cafe',
      attributes: { wifi: true, power: true },
      hours: { always: true, periods: [] },
      source: 'user',
    };
    const res = await post('/v1/reroute', { blocks, context: ctx, favorites: [favorite] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Record<string, { id: string }[]> };
    expect(body.candidates.work?.[0]?.id).toBe('fav_cafe');
    expect(body.candidates.gym?.some((p) => p.id === 'fav_cafe')).toBe(false);
  });
});

describe('API with smart add', () => {
  let smart: Server;
  let smartBase = '';
  const seen: string[] = [];

  beforeAll(async () => {
    smart = createServer(
      createApp({
        config: { corsOrigins: [], rerouteRateLimit: 5, smartAddRateLimit: 2 },
        places: new MockPlacesProvider(),
        weather,
        understand: async (text) => {
          seen.push(text);
          if (text.includes('boom')) throw new Error('model down');
          return tidyBlocks([
            { title: ' Gym ', minutes: 62, priority: 'should', category: 'gym', requirements: [], fixedStart: null, fixedEnd: null, place: null, earliest: '17:00', latest: '25:99', timePref: null, repeatsDaily: false },
          ]);
        },
        log: () => {},
      }),
    );
    await new Promise<void>((r) => smart.listen(0, r));
    smartBase = `http://127.0.0.1:${(smart.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => smart.close(() => r())));

  const ask = (body: unknown) =>
    fetch(`${smartBase}/v1/understand`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('turns a note into tidy blocks', async () => {
    expect((await (await fetch(`${smartBase}/health`)).json()).smartAdd).toBe(true);
    const res = await ask({ text: 'gym after 5', localTime: 'Monday 09:00' });
    expect(res.status).toBe(200);
    const { blocks: out } = (await res.json()) as { blocks: Record<string, unknown>[] };
    expect(out).toEqual([expect.objectContaining({ title: 'Gym', minutes: 60, earliest: '17:00', latest: null })]);
  });

  it('rejects empty notes and says plainly when it cannot read one', async () => {
    expect((await ask({ text: '   ', localTime: 'Monday 09:00' })).status).toBe(400);
    const res = await ask({ text: 'boom', localTime: 'Monday 09:00' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "Couldn't read that right now" });
  });

  it('is rate-limited separately, since every call costs money', async () => {
    expect((await ask({ text: 'one more', localTime: 'Monday 09:00' })).status).toBe(429);
  });
});

describe('tidyBlocks', () => {
  it('keeps answers inside what the planner accepts', () => {
    const [b] = tidyBlocks([
      { title: 'x'.repeat(120), minutes: 2000, priority: 'must', category: 'cafe', requirements: ['wifi', 'wifi'], fixedStart: '15:00', fixedEnd: '14:00', place: '  ', earliest: '9am', latest: null, timePref: 'morning', repeatsDaily: true },
    ]);
    expect(b).toMatchObject({ minutes: 720, requirements: ['wifi'], fixedStart: null, fixedEnd: null, place: null, earliest: null });
    expect(b!.title).toHaveLength(80);
  });
});

describe('work and study from a note', () => {
  const b = (title: string, category: 'cafe' | 'library' | 'gym', requirements: ('wifi' | 'power')[] = []) =>
    ({ title, minutes: 90, priority: 'should', category, requirements, fixedStart: null, fixedEnd: null, place: null, earliest: null, latest: null, timePref: null, repeatsDaily: false }) as const;

  it('stays "anywhere" unless the note names a place or a need, whatever the model said', () => {
    expect(tidyBlocks([b('Write the report', 'cafe', ['wifi', 'power'])], 'write the report before 7')[0]).toMatchObject({ category: 'none', requirements: [] });
    expect(tidyBlocks([b('Study', 'library')], 'study for two hours')[0]!.category).toBe('none');
  });

  it('keeps the place when the note asks for one', () => {
    expect(tidyBlocks([b('Emails', 'cafe', ['wifi'])], 'emails somewhere with wifi')[0]).toMatchObject({ category: 'cafe', requirements: ['wifi'] });
    expect(tidyBlocks([b('Study', 'library')], 'study at the library')[0]!.category).toBe('library');
    expect(tidyBlocks([b('Gym', 'gym')], 'gym after work')[0]!.category).toBe('gym');
  });
});

describe('clientKey', () => {
  const req = (headers: Record<string, string>, remote = '203.0.113.7') => ({ headers, socket: { remoteAddress: remote } }) as never;

  it('ignores addresses a client wrote at the front of x-forwarded-for', () => {
    expect(clientKey(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }))).toBe('198.51.100.4');
  });

  it('counts back one more address for each trusted proxy', () => {
    expect(clientKey(req({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4, 10.1.1.1' }), { hops: 2 })).toBe('198.51.100.4');
  });

  it('uses the connection address when no proxy added one', () => {
    expect(clientKey(req({}))).toBe('203.0.113.7');
    expect(clientKey(req({ 'x-forwarded-for': '198.51.100.4' }), { hops: 2 })).toBe('203.0.113.7');
  });

  it('prefers a client-IP header the host sets, when one is named', () => {
    expect(clientKey(req({ 'x-real-ip': '198.51.100.9', 'x-forwarded-for': '6.6.6.6' }), { header: 'x-real-ip' })).toBe('198.51.100.9');
    expect(clientKey(req({ 'x-forwarded-for': '198.51.100.4' }), { header: 'x-real-ip' })).toBe('198.51.100.4');
  });
});

describe('DailyCap', () => {
  it('stops after the daily budget and starts fresh the next UTC day', () => {
    let now = Date.UTC(2026, 9, 22, 10);
    const cap = new DailyCap(2, () => now);
    expect([cap.take(), cap.take(), cap.take()]).toEqual([true, true, false]);
    now += 24 * 60 * 60 * 1000;
    expect(cap.take()).toBe(true);
  });

  it('is off at 0', () => {
    const cap = new DailyCap(0);
    expect(Array.from({ length: 1000 }, () => cap.take()).every(Boolean)).toBe(true);
  });
});

describe('API protections', () => {
  let guarded: Server;
  let guardedBase = '';
  let claudeCalls = 0;

  beforeAll(async () => {
    guarded = createServer(
      createApp({
        config: { corsOrigins: [], rerouteRateLimit: 5, readRateLimit: 3, smartAddRateLimit: 100, smartAddDailyCap: 2 },
        places: new MockPlacesProvider(),
        weather,
        understand: async () => {
          claudeCalls++;
          return [];
        },
        log: () => {},
      }),
    );
    await new Promise<void>((r) => guarded.listen(0, r));
    guardedBase = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => guarded.close(() => r())));

  it('limits places and weather reads per client, and a made-up address does not help', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      // The caller invents a new front address each time; the one our proxy added is the same.
      const res = await fetch(`${guardedBase}/v1/weather/now?lat=14.6&lng=121`, { headers: { 'x-forwarded-for': `1.1.1.${i}, 198.51.100.4` } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const other = await fetch(`${guardedBase}/v1/place-name?lat=14.6&lng=121`, { headers: { 'x-forwarded-for': '198.51.100.5' } });
    expect(other.status).toBe(200);
  });

  it('stops calling Claude once the shared daily budget is spent, whoever asks', async () => {
    const ask = (ip: string) =>
      fetch(`${guardedBase}/v1/understand`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ text: 'gym after 5', localTime: 'Monday 09:00' }),
      });
    expect((await ask('203.0.113.1')).status).toBe(200);
    expect((await ask('203.0.113.2')).status).toBe(200);
    const res = await ask('203.0.113.3');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/resting for today/) });
    expect(claudeCalls).toBe(2);
  });
});

describe('places setup', () => {
  it('never falls back to made-up places outside mock mode', async () => {
    const { buildPlacesProvider } = await import('../src/providers');
    expect(buildPlacesProvider({ placesProvider: 'osm', googleDailyBudget: 1 }, () => {}).name).toBe('cached(osm→nominatim)');
    expect(buildPlacesProvider({ placesProvider: 'google', googlePlacesApiKey: 'k', googleDailyBudget: 1 }, () => {}).name).toBe('cached(budget(google)→osm→nominatim)');
    expect(buildPlacesProvider({ placesProvider: 'mock', googleDailyBudget: 1 }).name).toBe('mock');
  });
});

describe('POST /v1/alternatives', () => {
  const run = { id: 'run', title: 'Run', minMinutes: 45, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'] };
  const plan = (start: string, end: string) => ({
    label: 'Balanced',
    items: [{ blockId: 'run', title: 'Run', start, end, travelMinutesBefore: 5, confidence: 'verified', fixed: false, fallbacks: [] }],
    unscheduled: [],
    score: 0,
    totalTravelMinutes: 5,
  });
  const body = { blocks: [run], plan: plan('2026-10-19T17:00:00+08:00', '2026-10-19T17:45:00+08:00'), blockId: 'run', context: ctx, trigger: 'rain' };

  async function app(places: import('@segue/providers').PlacesProvider) {
    const s = createServer(createApp({ config: { corsOrigins: [], rerouteRateLimit: 50 }, places, weather, log: () => {} }));
    await new Promise<void>((r) => s.listen(0, r));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { s, ask: (b: unknown) => fetch(`${at}/v1/alternatives`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }) };
  }

  it('finds indoor options, and keeps everyone out of a storm', async () => {
    const { s, ask } = await app(new MockPlacesProvider());
    try {
      const res = await ask(body);
      expect(res.status).toBe(200);
      const out = (await res.json()) as { result: { options: { kind: string; category: string; label: string }[]; notes: { text: string }[]; problem?: { text: string } }; places: Record<string, unknown[]>; meta: Record<string, unknown> };
      // The fake weather reports a thunderstorm.
      expect(out.result.notes[0]!.text).toBe('A thunderstorm is reported nearby, so nothing outdoors for now');
      expect(out.result.options.length).toBeGreaterThan(0);
      expect(out.result.options.every((o) => o.category !== 'park')).toBe(true);
      expect(Object.keys(out.places).sort()).toEqual(['gym', 'mall', 'park']);
      expect(out.meta).toMatchObject({ placesProvider: 'mock', currentWeather: 'storm', searchedNear: 'here' });
    } finally {
      s.close();
    }
  });

  it('says when live map data is down and still offers the no-place version', async () => {
    const { s, ask } = await app({ name: 'down', nearby: async () => { throw new Error('no map server answered'); } });
    try {
      const out = (await (await ask(body)).json()) as { result: { options: { kind: string; label: string }[] }; meta: { warnings: string[] } };
      expect(out.meta.warnings).toContain("Couldn't reach live map data for gyms right now.");
      expect(out.result.options.map((o) => o.kind)).toEqual(['no-place']);
      expect(out.result.options[0]!.label).toBe('Indoor workout where you are');
    } finally {
      s.close();
    }
  });

  it('rejects a malformed request with readable details', async () => {
    const { s, ask } = await app(new MockPlacesProvider());
    try {
      const res = await ask({ ...body, blockId: '' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { details: string[] }).details.join(' ')).toMatch(/blockId/);
    } finally {
      s.close();
    }
  });
});

describe('POST /v1/assistant (optional AI mode)', () => {
  const snapshot = {
    now: '2026-10-19T14:00:00+08:00',
    endOfDay: '2026-10-19T22:00:00+08:00',
    items: [
      { id: 'run', title: 'Run', start: '2026-10-19T17:00:00+08:00', end: '2026-10-19T17:45:00+08:00', fixed: false, calendar: false, status: 'planned' },
      { id: 'gcal_1', title: 'Standup', start: '2026-10-19T15:00:00+08:00', end: '2026-10-19T15:30:00+08:00', fixed: true, calendar: true, status: 'planned' },
    ],
    unscheduled: [],
    changes: [],
    options: [{ id: 'opt-a', label: 'Work out at Pulse instead', start: '2026-10-19T17:00:00+08:00', end: '2026-10-19T17:45:00+08:00', why: 'Open until 10 PM', facts: [], tradeoffs: [] }],
  };
  const ask = { question: "What's next?", draft: 'Next: 3:00 PM–3:30 PM Standup (set time).', snapshot, history: [] };
  const GOOD = 'good.token.one';
  const OTHER = 'other.token.two';
  const verifier = { verify: async (t: string) => { if (t !== GOOD && t !== OTHER) throw new (await import('../src/auth')).AuthError('bad'); return { id: t === GOOD ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002', email: 'x@example.com' }; } };

  async function app(answerWith: (req: unknown) => Promise<{ answer: string; action: unknown }>, extra: Record<string, number> = {}) {
    const s = createServer(createApp({ config: { corsOrigins: [], rerouteRateLimit: 5, ...extra }, places: new MockPlacesProvider(), weather, log: () => {}, assistant: { ask: answerWith as never, verifier: verifier as never } }));
    await new Promise<void>((r) => s.listen(0, r));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    return { s, at, post: (b: unknown, token?: string) => fetch(`${at}/v1/assistant`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(b) }) };
  }

  it('is off unless a model is configured, and the phone answers on its own', async () => {
    expect((await post('/v1/assistant', ask)).status).toBe(404);
  });

  it('stays off in production even with an Anthropic key, until ASSISTANT_AI=on (it is still in development)', async () => {
    const { loadConfig } = await import('../src/config');
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).assistantAi).toBe(false);
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }).smartAdd).toBe(true);
    expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ASSISTANT_AI: 'on' }).assistantAi).toBe(true);
  });

  it('needs a signed-in Segue account', async () => {
    const { s, post: p, at } = await app(async () => ({ answer: 'x', action: null }));
    try {
      expect((await p(ask)).status).toBe(401);
      expect((await p(ask, 'aaa.bbb.ccc')).status).toBe(401);
      expect((await (await fetch(`${at}/health`)).json()).assistant).toBe('ai');
    } finally {
      s.close();
    }
  });

  it('rejects malformed or oversized requests', async () => {
    const { s, post: p } = await app(async () => ({ answer: 'x', action: null }));
    try {
      expect((await p({ ...ask, question: '' }, GOOD)).status).toBe(400);
      expect((await p({ ...ask, snapshot: { ...snapshot, items: Array.from({ length: 41 }, () => snapshot.items[0]) } }, GOOD)).status).toBe(400);
    } finally {
      s.close();
    }
  });

  it('passes the answer through, but only actions about things in the snapshot, never replacing a set-time item', async () => {
    const actions: unknown[] = [
      { type: 'use-option', optionId: 'opt-a' },
      { type: 'use-option', optionId: 'made-up' },
      { type: 'options', blockId: 'gcal_1' },
      { type: 'options', blockId: 'someone-elses-item' },
      { type: 'open-item', blockId: 'run' },
      { type: 'replan' },
    ];
    let i = 0;
    const { s, post: p } = await app(async () => ({ answer: 'Next is your standup at 3:00 PM.', action: actions[i++] }));
    try {
      const got = [];
      for (let n = 0; n < actions.length; n++) got.push(((await (await p(ask, GOOD)).json()) as { action: unknown }).action);
      expect(got).toEqual([{ type: 'use-option', optionId: 'opt-a' }, null, null, null, { type: 'open-item', blockId: 'run' }, { type: 'replan' }]);
    } finally {
      s.close();
    }
  });

  it('says plainly when the model fails, so the phone falls back to its own answer', async () => {
    const { s, post: p } = await app(async () => {
      throw new Error('overloaded');
    });
    try {
      const res = await p(ask, GOOD);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ code: 'assistant_unavailable' });
    } finally {
      s.close();
    }
  });

  it('limits each account separately', async () => {
    const { s, post: p } = await app(async () => ({ answer: 'ok', action: null }), { assistantRateLimit: 2 });
    try {
      expect([(await p(ask, GOOD)).status, (await p(ask, GOOD)).status, (await p(ask, GOOD)).status]).toEqual([200, 200, 429]);
      expect((await p(ask, OTHER)).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe('assistant conversation turns', () => {
  it('start with the user and alternate', async () => {
    const { turns } = await import('../src/assistant');
    expect(
      turns([
        { role: 'assistant', text: 'hi' },
        { role: 'user', text: 'a' },
        { role: 'user', text: 'b' },
        { role: 'assistant', text: 'c' },
        { role: 'user', text: 'd' },
      ]),
    ).toEqual([
      { role: 'user', content: 'a\nb' },
      { role: 'assistant', content: 'c' },
    ]);
  });
});

describe('when no map source answers', () => {
  it('says so with a 503 (not a 500, and never made-up places), and /health shows the failure', async () => {
    const { FallbackPlacesProvider, CachedPlacesProvider } = await import('@segue/providers');
    const down = new CachedPlacesProvider(new FallbackPlacesProvider([{ name: 'osm', nearby: async () => { throw new Error('at capacity'); } }]));
    const s = createServer(createApp({ config: { corsOrigins: [], rerouteRateLimit: 5 }, places: down, weather, log: () => {} }));
    await new Promise<void>((r) => s.listen(0, r));
    const at = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${at}/v1/places/nearby?lat=14.55&lng=121.02&category=gym`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "Live map data isn't available right now", code: 'places_unavailable' });
      const health = (await (await fetch(`${at}/health`)).json()) as { placesStatus: { lastAnswer: unknown; lastFailure: { message: string } } };
      expect(health.placesStatus.lastAnswer).toBeNull();
      expect(health.placesStatus.lastFailure.message).toBe('osm: at capacity');
    } finally {
      s.close();
    }
  });
});
