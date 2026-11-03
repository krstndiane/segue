/**
 * Google Calendar stays connected: code exchange, encrypted refresh tokens,
 * automatic refresh, revoked access, account switching and disconnecting,
 * against a real Postgres (TEST_DATABASE_URL; skipped without it) and a fake
 * Google that answers the token, revoke and Calendar endpoints.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { createApp } from '../src/app';
import { createVerifier } from '../src/auth';
import { connect, migrate, type Db } from '../src/db';
import { createSocial } from '../src/social';
import { EVENTS_SCOPE, LIST_SCOPE, openToken, parseTokenKey, sealToken, type GoogleCalendarConfig } from '../src/social/google';

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-for-hs256-tokens';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub: string) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const weather: WeatherProvider = { name: 'fake', forecast: async () => [], current: async () => ({ condition: 'clear', isDay: true, observedAt: new Date().toISOString() }) };

/** A small stand-in for Google: codes → tokens, refresh, revoke, and a calendar with two events. */
class FakeGoogle {
  codes = new Map<string, { sub: string; email: string; scope: string; refresh?: boolean }>();
  refresh = new Map<string, string>(); // refresh token → sub
  access = new Map<string, string>(); // access token → sub
  revoked: string[] = [];
  calls = { refresh: 0, events: 0 };
  down = false;

  issue(sub: string, email: string, { scope = `openid email ${EVENTS_SCOPE} ${LIST_SCOPE}`, refresh = true } = {}) {
    const code = `code-${randomUUID()}`;
    this.codes.set(code, { sub, email, scope, refresh });
    return code;
  }
  private accessFor(sub: string) {
    const t = `at-${randomUUID()}`;
    this.access.set(t, sub);
    return t;
  }
  revokeAllFor(sub: string) {
    for (const [t, s] of this.refresh) if (s === sub) this.refresh.delete(t);
    for (const [t, s] of this.access) if (s === sub) this.access.delete(t);
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(String(input));
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_secret')).toBe('shh');
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('redirect_uri')).toBe('postmessage');
        const c = this.codes.get(form.get('code') ?? '');
        if (!c) return json(400, { error: 'invalid_grant' });
        this.codes.delete(form.get('code')!);
        const out: Record<string, unknown> = {
          access_token: this.accessFor(c.sub),
          expires_in: 3599,
          scope: c.scope,
          id_token: `x.${b64({ sub: c.sub, email: c.email })}.y`,
        };
        if (c.refresh) {
          const r = `rt-${randomUUID()}`;
          this.refresh.set(r, c.sub);
          out.refresh_token = r;
        }
        return json(200, out);
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.calls.refresh++;
        const sub = this.refresh.get(form.get('refresh_token') ?? '');
        if (!sub) return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: this.accessFor(sub), expires_in: 3599, scope: `${EVENTS_SCOPE} ${LIST_SCOPE}` });
      }
    }
    if (url.href === 'https://oauth2.googleapis.com/revoke') {
      const t = new URLSearchParams(String(init?.body)).get('token') ?? '';
      this.revoked.push(t);
      const sub = this.refresh.get(t) ?? this.access.get(t);
      if (sub) this.revokeAllFor(sub);
      return json(200, {});
    }
    if (url.hostname === 'www.googleapis.com') {
      const auth = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
      if (!this.access.has(auth)) return json(401, { error: { code: 401 } });
      if (url.pathname.endsWith('/calendarList')) return json(200, { items: [{ id: 'me@example.com', primary: true }, { id: 'team@group', selected: true }] });
      this.calls.events++;
      const cal = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      if (cal === 'team@group') return json(200, { items: [{ id: 'team1', summary: 'Standup', start: { dateTime: '2026-11-04T01:00:00Z' }, end: { dateTime: '2026-11-04T01:15:00Z' } }] });
      return json(200, {
        items: [
          {
            id: 'ev1',
            summary: 'Class',
            description: 'private notes that must not leave',
            location: 'PUP',
            start: { dateTime: '2026-11-04T07:30:00Z' },
            end: { dateTime: '2026-11-04T09:00:00Z' },
            attendees: [{ email: 'other@example.com', responseStatus: 'accepted' }, { self: true, email: 'me@example.com', responseStatus: 'accepted' }],
            htmlLink: 'https://calendar.google.com/x',
          },
          { id: 'ev2', summary: 'Holiday', start: { date: '2026-11-04' }, end: { date: '2026-11-05' } },
        ],
      });
    }
    return json(404, {});
  };
}

const key = randomBytes(32);
const google = new FakeGoogle();
let server: Server;
let offServer: Server;
let base = '';
let offBase = '';
let db: Db;
let clock = Date.now();

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function call(b: string, t: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${b}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function person(name: string) {
  const id = randomUUID();
  const t = token(id);
  const as = (method: string, path: string, body?: unknown) => call(base, t, method, path, body);
  expect((await as('PUT', '/v1/me', { username: `${name}_${id.slice(0, 6)}`, displayName: name })).status).toBe(200);
  return { id, t, as, sub: `g-${id}`, email: `${name}@example.com` };
}
const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const RANGE = `start=${encodeURIComponent('2026-11-04T00:00:00+08:00')}&end=${encodeURIComponent('2026-11-05T00:00:00+08:00')}`;

describe('sealed tokens', () => {
  it('only open for the same user with the same key', () => {
    const k = randomBytes(32);
    const s = sealToken(k, 'user-a', 'secret-refresh');
    expect(s).not.toContain('secret-refresh');
    expect(openToken(k, 'user-a', s)).toBe('secret-refresh');
    expect(() => openToken(k, 'user-b', s)).toThrow();
    expect(() => openToken(randomBytes(32), 'user-a', s)).toThrow();
  });
  it('reads the key as base64 or hex and refuses the wrong length', () => {
    const k = randomBytes(32);
    expect(parseTokenKey(k.toString('base64')).equals(k)).toBe(true);
    expect(parseTokenKey(k.toString('hex')).equals(k)).toBe(true);
    expect(() => parseTokenKey('short')).toThrow(/32 bytes/);
  });
});

describe.skipIf(!DB_URL)('Google Calendar connection (Postgres)', () => {
  beforeAll(async () => {
    db = connect({ url: DB_URL!, ssl: 'off', max: 4 });
    await db.query('drop schema if exists segue cascade');
    await migrate(db);
    const g: GoogleCalendarConfig = { clientId: 'cid', clientSecret: 'shh', key, fetch: google.fetch };
    const make = (withGoogle: boolean) =>
      createServer(
        createApp({
          config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 50 },
          places: new MockPlacesProvider(),
          weather,
          social: createSocial({ db, verifier: createVerifier({ jwtSecret: SECRET }), google: withGoogle ? g : undefined, limits: { writesPerHour: 1000 }, now: () => clock }),
          log: () => {},
        }),
      );
    server = make(true);
    offServer = make(false);
    base = await listen(server);
    offBase = await listen(offServer);
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => offServer.close(() => r()));
    await db.close();
  });

  it('says when the server cannot keep a connection', async () => {
    const a = await person('off');
    const off = await call(offBase, a.t, 'GET', '/v1/google/calendar');
    expect(off.body).toEqual({ available: false, status: 'disconnected' });
    expect((await call(offBase, a.t, 'POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) })).body.code).toBe('google_off');
  });

  it('connects once, keeps the refresh token encrypted, and stays connected', async () => {
    const a = await person('ana');
    expect((await a.as('GET', '/v1/google/calendar')).body).toEqual({ available: true, status: 'disconnected' });

    const done = await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ available: true, status: 'connected', email: a.email });
    expect(done.body.lastSyncedAt).toBeUndefined();

    // Nothing readable at rest, and nothing secret in the answer.
    const row = (await db.query('select * from segue.google_accounts where user_id = $1', [a.id]))[0]!;
    expect(String(row.refresh_token_enc)).toMatch(/^v1\./);
    expect(String(row.refresh_token_enc)).not.toMatch(/rt-/);
    expect(JSON.stringify(done.body)).not.toMatch(/rt-|at-/);

    // A later visit (any device): still connected, no sign-in.
    const later = await a.as('GET', '/v1/google/calendar');
    expect(later.body.status).toBe('connected');

    const ev = await a.as('GET', `/v1/google/calendar/events?${RANGE}`);
    expect(ev.status).toBe(200);
    expect(ev.body.items.map((i: { id: string }) => i.id).sort()).toEqual(['ev1', 'ev2', 'team1']);
    const cls = ev.body.items.find((i: { id: string }) => i.id === 'ev1');
    // Only what the planner needs: no description, other attendees or links.
    expect(cls).not.toHaveProperty('description');
    expect(cls).not.toHaveProperty('htmlLink');
    expect(cls.attendees).toEqual([{ self: true, responseStatus: 'accepted' }]);
    expect((await a.as('GET', '/v1/google/calendar')).body.lastSyncedAt).toBe(ev.body.syncedAt);
  });

  it('refreshes the access token on its own when it runs out', async () => {
    const a = await person('ben');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    const before = google.calls.refresh;
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).status).toBe(200);
    expect(google.calls.refresh).toBe(before); // the saved token was still good

    clock += 2 * 60 * 60 * 1000; // two hours later
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).status).toBe(200);
    expect(google.calls.refresh).toBe(before + 1);

    // Google ended the access token early: one fresh try, still no sign-in.
    google.access.clear();
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).status).toBe(200);
    expect((await a.as('GET', '/v1/google/calendar')).body.status).toBe('connected');
  });

  it('says it needs attention when Google revokes access, and reconnecting fixes it', async () => {
    const a = await person('cy');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    google.revokeAllFor(a.sub); // removed in the Google account's security settings
    clock += 2 * 60 * 60 * 1000;
    const ev = await a.as('GET', `/v1/google/calendar/events?${RANGE}`);
    expect(ev.status).toBe(409);
    expect(ev.body.code).toBe('google_reconnect');
    expect((await a.as('GET', '/v1/google/calendar')).body).toMatchObject({ status: 'needs_attention', email: a.email });
    // Still needs attention on the next try, without asking Google again for nothing.
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).body.code).toBe('google_reconnect');

    expect((await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) })).body.status).toBe('connected');
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).status).toBe(200);
  });

  it('keeps the saved refresh token when Google sends none on a repeat connect', async () => {
    const a = await person('dee');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    const again = await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email, { refresh: false }) });
    expect(again.body.status).toBe('connected');
    clock += 2 * 60 * 60 * 1000;
    expect((await a.as('GET', `/v1/google/calendar/events?${RANGE}`)).status).toBe(200);

    // A first connect without lasting access is refused, not half-saved.
    const e = await person('eve');
    const r = await e.as('POST', '/v1/google/calendar', { code: google.issue(e.sub, e.email, { refresh: false }) });
    expect(r.body.code).toBe('google_no_offline');
    expect((await e.as('GET', '/v1/google/calendar')).body.status).toBe('disconnected');
  });

  it('refuses a connect without calendar access, and a bad code', async () => {
    const a = await person('fay');
    expect((await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email, { scope: 'openid email' }) })).body.code).toBe('google_scope_missing');
    expect((await a.as('POST', '/v1/google/calendar', { code: 'code-not-a-real-one' })).body.code).toBe('google_code_invalid');
    expect((await a.as('GET', '/v1/google/calendar')).body.status).toBe('disconnected');
  });

  it("doesn't switch Google accounts silently", async () => {
    const a = await person('gus');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    const other = await a.as('POST', '/v1/google/calendar', { code: google.issue('other-sub', 'work@example.com') });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('google_other_account');
    expect(other.body.details).toEqual({ connected: a.email, offered: 'work@example.com' });
    expect((await a.as('GET', '/v1/google/calendar')).body.email).toBe(a.email);

    const switched = await a.as('POST', '/v1/google/calendar', { code: google.issue('other-sub', 'work@example.com'), replace: true });
    expect(switched.body).toMatchObject({ status: 'connected', email: 'work@example.com' });
    expect(switched.body.lastSyncedAt).toBeUndefined();
  });

  it('keeps each connection to its own account', async () => {
    const a = await person('hal');
    const b = await person('ivy');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    expect((await b.as('GET', '/v1/google/calendar')).body.status).toBe('disconnected');
    expect((await b.as('GET', `/v1/google/calendar/events?${RANGE}`)).body.code).toBe('google_not_connected');
    // A token sealed for one person can't be read as another's.
    const row = (await db.query('select refresh_token_enc from segue.google_accounts where user_id = $1', [a.id]))[0]!;
    expect(() => openToken(key, b.id, String(row.refresh_token_enc))).toThrow();
    // Signed out: nothing.
    expect((await fetch(`${base}/v1/google/calendar`)).status).toBe(401);
  });

  it('disconnects: revoked at Google and removed from Segue', async () => {
    const a = await person('jo');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    const gone = await a.as('DELETE', '/v1/google/calendar');
    expect(gone.body).toEqual({ available: true, status: 'disconnected' });
    expect(await db.query('select 1 from segue.google_accounts where user_id = $1', [a.id])).toHaveLength(0);
    expect([...google.refresh.values()]).not.toContain(a.sub);
    // And connecting again works.
    expect((await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) })).body.status).toBe('connected');
  });

  it('checks the date range, and says so when Google is unreachable', async () => {
    const a = await person('kai');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    expect((await a.as('GET', '/v1/google/calendar/events?start=nope&end=nope')).status).toBe(400);
    const wide = `start=${encodeURIComponent('2026-01-01T00:00:00Z')}&end=${encodeURIComponent('2026-12-01T00:00:00Z')}`;
    expect((await a.as('GET', `/v1/google/calendar/events?${wide}`)).status).toBe(400);
    google.down = true;
    try {
      clock += 2 * 60 * 60 * 1000;
      const r = await a.as('GET', `/v1/google/calendar/events?${RANGE}`);
      expect(r.status).toBe(502);
      expect(r.body.code).toBe('google_unreachable');
      // A network blip is not a revoked connection.
      expect((await a.as('GET', '/v1/google/calendar')).body.status).toBe('connected');
    } finally {
      google.down = false;
    }
  });

  it('goes away with the account', async () => {
    const a = await person('lee');
    await a.as('POST', '/v1/google/calendar', { code: google.issue(a.sub, a.email) });
    expect((await a.as('DELETE', '/v1/me', { confirm: 'DELETE' })).status).toBe(200);
    expect([...google.refresh.values()]).not.toContain(a.sub);
    expect(await db.query('select 1 from segue.google_accounts where user_id = $1', [a.id])).toHaveLength(0);
  });
});
