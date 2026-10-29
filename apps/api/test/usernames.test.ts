/**
 * Username rules: the shared validator (no database needed), then the
 * availability endpoint, registration, edits, simultaneous requests and the
 * migration of older names against a real Postgres (TEST_DATABASE_URL).
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockPlacesProvider, type WeatherProvider } from '@segue/providers';
import { checkUsername, normalizeUsername, usernameCandidates } from '@segue/schemas';
import { createApp } from '../src/app';
import { createVerifier } from '../src/auth';
import { connect, migrate, rollback, type Db } from '../src/db';
import { createSocial } from '../src/social';

const rule = (name: string) => {
  const r = checkUsername(name);
  return r.ok ? 'ok' : r.reason;
};

describe('username rules', () => {
  it('accepts well-formed names', () => {
    for (const n of ['dia', 'dia_aviles', 'dia2026', 'Dia_Aviles', 'a1b', 'abcdefghij1234567890']) expect(rule(n)).toBe('ok');
  });
  it('explains what is wrong with the rest', () => {
    expect(rule('')).toBe('too_short');
    expect(rule('di')).toBe('too_short');
    expect(rule('a'.repeat(21))).toBe('too_long');
    expect(rule('2dia')).toBe('invalid_format');
    expect(rule('dia aviles')).toBe('invalid_format');
    expect(rule('dia__aviles')).toBe('invalid_format');
    expect(rule('_dia')).toBe('invalid_format');
    expect(rule('dia_')).toBe('invalid_format');
    expect(rule('dia@home')).toBe('invalid_format');
    expect(rule('diá')).toBe('invalid_format');
    expect(rule('dia😀')).toBe('invalid_format');
    expect(rule('admin')).toBe('reserved');
    expect(rule('ADMIN')).toBe('reserved');
  });
  it('gives a message for every failure', () => {
    for (const n of ['di', 'a'.repeat(21), '2dia', 'dia aviles', 'dia__x', '_dia', 'dia_', 'support']) {
      const r = checkUsername(n);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message.length).toBeGreaterThan(5);
    }
  });
  it('lowercases only after the format passes, and never rewrites an invalid name', () => {
    expect(checkUsername('  Dia_Aviles ')).toEqual({ ok: true, username: 'dia_aviles' });
    expect(checkUsername('DIA2026')).toEqual({ ok: true, username: 'dia2026' });
    expect(checkUsername('Dia Aviles').ok).toBe(false);
    expect(normalizeUsername(' Dia ')).toBe('dia');
  });
  it('treats extra reserved names the same way, whatever their case', () => {
    expect(checkUsername('Padayon', ['padayon'])).toMatchObject({ ok: false, reason: 'reserved' });
  });
  it('suggests readable names that follow the rules', () => {
    const list = usernameCandidates('dia', 2026);
    expect(list).toContain('dia2026');
    expect(list).toContain('dia_notes');
    for (const n of usernameCandidates('a_very_long_username_ok', 2026)) expect(checkUsername(n).ok).toBe(true);
    expect(usernameCandidates('x', 2026)).toEqual([]);
  });
});

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-for-hs256-tokens';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub: string) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const weather: WeatherProvider = { name: 'fake', forecast: async () => [], current: async () => ({ condition: 'clear', isDay: true, observedAt: new Date().toISOString() }) };

let server: Server;
let limited: Server;
let base = '';
let limitedBase = '';
let db: Db;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function call(b: string, t: string | null, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${b}${path}`, {
    method,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Someone signed in who hasn't set up a profile yet (as at sign-up), plus a helper to set one up. */
function newcomer(b = base) {
  const id = randomUUID();
  const t = token(id);
  const as = (method: string, path: string, body?: unknown) => call(b, t, method, path, body);
  return { id, t, as, join: (username: string, extra: Record<string, unknown> = {}) => as('PUT', '/v1/me', { username, displayName: 'Someone', ...extra }) };
}
const free = () => `u${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const avail = (who: ReturnType<typeof newcomer>, name: string) => who.as('GET', `/v1/usernames/availability?username=${encodeURIComponent(name)}`);

describe.skipIf(!DB_URL)('usernames (Postgres)', () => {
  beforeAll(async () => {
    db = connect({ url: DB_URL!, ssl: 'off', max: 12 });
    await db.query('drop schema if exists segue cascade');
    await migrate(db);
    const make = (limits: object) =>
      createServer(
        createApp({
          config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 50 },
          places: new MockPlacesProvider(),
          weather,
          social: createSocial({ db, verifier: createVerifier({ jwtSecret: SECRET }), reservedUsernames: ['padayon'], limits }),
          log: () => {},
        }),
      );
    server = make({ writesPerHour: 1000, usernameChecksPerHour: 1000 });
    limited = make({ usernameChecksPerHour: 3 });
    for (const s of [server, limited]) await new Promise<void>((r) => s.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    limitedBase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const s of [server, limited]) await new Promise<void>((r) => s.close(() => r()));
    await db.close();
  });

  describe('availability endpoint', () => {
    it('needs a sign-in but not a profile, and says nothing about who owns a name', async () => {
      expect((await call(base, null, 'GET', '/v1/usernames/availability?username=abc')).status).toBe(401);
      const a = newcomer();
      const name = free();
      expect((await avail(a, name)).body).toEqual({ username: name, available: true, reason: null });
      const b = newcomer();
      expect((await b.join(name)).status).toBe(200);
      const taken = (await avail(a, name)).body;
      expect(taken).toMatchObject({ username: name, available: false, reason: 'taken' });
      // Nothing that identifies the owner.
      expect(Object.keys(taken).sort()).toEqual(['available', 'reason', 'suggestions', 'username']);
      expect(JSON.stringify(taken)).not.toContain(b.id);
    });

    it('treats case variations as the same name', async () => {
      const name = free();
      await newcomer().join(name);
      const res = (await avail(newcomer(), name.toUpperCase())).body;
      expect(res).toMatchObject({ username: name, available: false, reason: 'taken' });
    });

    it('reports format and reserved reasons without touching the database', async () => {
      const w = newcomer();
      const reason = async (n: string) => (await avail(w, n)).body.reason;
      expect(await reason('')).toBe('too_short');
      expect(await reason('ab')).toBe('too_short');
      expect(await reason('a'.repeat(21))).toBe('too_long');
      expect(await reason('1abc')).toBe('invalid_format');
      expect(await reason('a b c')).toBe('invalid_format');
      expect(await reason('abc__def')).toBe('invalid_format');
      expect(await reason('ADMIN')).toBe('reserved');
      expect(await reason('padayon')).toBe('reserved');
      expect((await avail(w, 'a'.repeat(200))).status).toBe(400);
    });

    it('offers readable suggestions that are really free', async () => {
      const root = `ze${Math.floor(Math.random() * 1e6)}`;
      const year = new Date().getUTCFullYear();
      await newcomer().join(root);
      await newcomer().join(`${root}${year}`); // take the first suggestion
      const res = (await avail(newcomer(), root)).body;
      expect(res.available).toBe(false);
      expect(res.suggestions.length).toBeGreaterThan(0);
      expect(res.suggestions).not.toContain(`${root}${year}`);
      for (const s of res.suggestions) {
        expect(checkUsername(s).ok).toBe(true);
        expect((await avail(newcomer(), s)).body.available).toBe(true);
      }
    });

    it("says an account's own name is available to it", async () => {
      const a = newcomer();
      const name = free();
      await a.join(name);
      expect((await avail(a, name.toUpperCase())).body).toMatchObject({ available: true, reason: null, yours: true });
    });

    it('is rate limited', async () => {
      const a = newcomer(limitedBase);
      for (let i = 0; i < 3; i++) expect((await a.as('GET', `/v1/usernames/availability?username=${free()}`)).status).toBe(200);
      const over = await a.as('GET', `/v1/usernames/availability?username=${free()}`);
      expect(over.status).toBe(429);
      expect(over.body.code).toBe('rate_limited');
    });
  });

  describe('registering', () => {
    it('lowercases the name, and refuses an invalid one with a plain reason', async () => {
      const name = free();
      const ok = await newcomer().join(name.toUpperCase());
      expect(ok.status).toBe(200);
      expect(ok.body.profile.username).toBe(name);
      const bad = await newcomer().join('dia aviles');
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('username_invalid');
      expect(bad.body.error).toMatch(/letters, numbers and underscores/);
      expect((await newcomer().join('admin')).body.error).toBe('This username is reserved.');
      expect((await newcomer().join('__x')).status).toBe(400);
    });

    it('refuses a taken name, whatever its case, with a 409', async () => {
      const name = free();
      await newcomer().join(name);
      for (const variant of [name, name.toUpperCase(), ` ${name} `]) {
        const res = await newcomer().join(variant);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('username_taken');
        expect(res.body.error).toMatch(/just taken/);
      }
    });

    it('lets a retry with the same name succeed for the same person, and creates one profile', async () => {
      const a = newcomer();
      const name = free();
      expect((await a.join(name)).status).toBe(200);
      expect((await a.join(name, { displayName: 'Again' })).status).toBe(200);
      expect((await db.query('select count(*)::int as n from segue.profiles where id = $1', [a.id]))[0]).toEqual({ n: 1 });
    });

    it('lets only one of many simultaneous registrations have the name', async () => {
      const name = free();
      const results = await Promise.all(Array.from({ length: 10 }, () => newcomer().join(Math.random() < 0.5 ? name : name.toUpperCase())));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(9);
      expect((await db.query('select count(*)::int as n from segue.profiles where username = $1', [name]))[0]).toEqual({ n: 1 });
    });
  });

  describe('editing', () => {
    it("keeps the person's own name, refuses someone else's, and changes atomically", async () => {
      const a = newcomer();
      const other = newcomer();
      const mine = free();
      const theirs = free();
      await a.join(mine);
      await other.join(theirs);
      expect((await a.as('PATCH', '/v1/me', { username: mine, bio: 'unchanged name' })).status).toBe(200);
      expect((await a.as('PATCH', '/v1/me', { username: mine.toUpperCase() })).status).toBe(200);
      const clash = await a.as('PATCH', '/v1/me', { username: theirs.toUpperCase() });
      expect(clash.status).toBe(409);
      expect((await a.as('GET', '/v1/me')).body.profile.username).toBe(mine);

      const note = (await a.as('POST', '/v1/notes', { title: 'Hike', visibility: 'discoverable' })).body.note;
      const renamed = free();
      const res = await a.as('PATCH', '/v1/me', { username: renamed });
      expect(res.status).toBe(200);
      expect(res.body.profile).toMatchObject({ id: a.id, username: renamed });
      // The old name is free again; relationships hang off the id, so nothing was lost.
      expect((await avail(newcomer(), mine)).body.available).toBe(true);
      const seen = (await other.as('GET', `/v1/notes/${note.id}`)).body.note;
      expect(seen.author).toMatchObject({ id: a.id, username: renamed });
      expect((await other.as('GET', `/v1/users?q=${renamed}`)).body.users).toEqual([]); // not findable until they choose
    });

    it('keeps search case-insensitive', async () => {
      const a = newcomer();
      const name = free();
      await a.join(name, { discoverable: true });
      const searcher = newcomer();
      await searcher.join(free());
      const found = (await searcher.as('GET', `/v1/users?q=${name.toUpperCase()}`)).body.users;
      expect(found.map((u: { id: string }) => u.id)).toEqual([a.id]);
    });
  });

  describe('the database itself', () => {
    it('refuses a duplicate or malformed name whatever the application does', async () => {
      const name = free();
      const a = newcomer();
      await a.join(name);
      const b = newcomer();
      await b.join(free());
      await expect(db.query('update segue.profiles set username = $1 where id = $2', [name, b.id])).rejects.toMatchObject({ code: '23505' });
      for (const bad of ['dia__x', '1abc', 'abc_', 'ab']) {
        await expect(db.query('update segue.profiles set username = $1 where id = $2', [bad, b.id])).rejects.toMatchObject({ code: '23514' });
      }
      await expect(db.query(`insert into segue.profiles (id, username, display_name) values ($1, $2, 'x')`, [randomUUID(), 'Upper'])).rejects.toBeTruthy();
    });
  });

  describe('older accounts', () => {
    it('keeps names that predate the rules, flags them, and clears the flag when they choose a new one', async () => {
      // Go back to before the rules, add accounts the way they used to be allowed, then upgrade.
      expect(await rollback(db)).toBe('005_join_requests');
      expect(await rollback(db)).toBe('004_google_calendar_sync');
      expect(await rollback(db)).toBe('003_username_rules');
      const old = { short: randomUUID(), under: randomUUID(), long: randomUUID(), reserved: randomUUID(), fine: randomUUID() };
      const rows: [string, string][] = [
        [old.short, '1ab'],
        [old.under, 'ana__cruz'],
        [old.long, 'a'.repeat(23)],
        [old.reserved, 'support'],
        [old.fine, 'fine_name'],
      ];
      for (const [id, name] of rows) await db.query(`insert into segue.profiles (id, username, display_name) values ($1, $2, 'Old')`, [id, name]);
      expect(await migrate(db)).toEqual(['003_username_rules', '004_google_calendar_sync', '005_join_requests']);

      const flags = Object.fromEntries((await db.query<{ username: string; username_review: boolean }>('select username, username_review from segue.profiles where id = any($1::uuid[])', [rows.map((r) => r[0])])).map((r) => [r.username, r.username_review]));
      expect(flags).toEqual({ '1ab': true, ana__cruz: true, ['a'.repeat(23)]: true, support: true, fine_name: false });

      // Nobody was renamed, and they can still use the app and save other changes.
      const t = token(old.under);
      const me = await call(base, t, 'GET', '/v1/me');
      expect(me.body.profile).toMatchObject({ username: 'ana__cruz', usernameNeedsChange: true });
      expect((await call(base, t, 'PATCH', '/v1/me', { username: 'ana__cruz', bio: 'still here' })).status).toBe(200);
      expect((await call(base, t, 'GET', '/v1/me')).body.profile.usernameNeedsChange).toBe(true);
      // Choosing a new name must meet today's rules, and clears the flag.
      expect((await call(base, t, 'PATCH', '/v1/me', { username: 'ana___x' })).status).toBe(400);
      const fixed = await call(base, t, 'PATCH', '/v1/me', { username: free() });
      expect(fixed.status).toBe(200);
      expect(fixed.body.profile.usernameNeedsChange).toBe(false);
      expect((await call(base, token(old.fine), 'GET', '/v1/me')).body.profile.usernameNeedsChange).toBe(false);
    });
  });
});
