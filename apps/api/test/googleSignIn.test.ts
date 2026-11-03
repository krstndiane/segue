/**
 * Continue with Google: one consent creates (or finds) the Segue account, signs
 * in and connects Google Calendar. Real Postgres (TEST_DATABASE_URL; skipped
 * without it), with stand-ins for Google and for Supabase's id-token sign-in.
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
import { EVENTS_SCOPE, LIST_SCOPE } from '../src/social/google';

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'test-secret-for-hs256-tokens';
const SUPA = 'https://project.supabase.example';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub: string, email?: string) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, email, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const weather: WeatherProvider = { name: 'fake', forecast: async () => [], current: async () => ({ condition: 'clear', isDay: true, observedAt: new Date().toISOString() }) };

interface GoogleUser {
  sub: string;
  email: string;
  name: string;
  given?: string;
}
/** Google's token and revoke endpoints, and Supabase's id-token sign-in. */
class Fakes {
  codes = new Map<string, { u: GoogleUser; scope: string; refresh: boolean }>();
  refresh = new Map<string, string>();
  /** Supabase users: Google sub → user id, and verified emails of existing (email/password) accounts → user id */
  bySub = new Map<string, string>();
  byVerifiedEmail = new Map<string, string>();
  supabaseGoogleOn = true;
  supabaseCalls = 0;

  code(u: GoogleUser, { calendar = true, refresh = true } = {}) {
    const c = `code-${randomUUID()}`;
    this.codes.set(c, { u, scope: `openid email profile${calendar ? ` ${EVENTS_SCOPE} ${LIST_SCOPE}` : ''}`, refresh });
    return c;
  }
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      const f = new URLSearchParams(String(init?.body));
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code') ?? '');
        if (!c) return json(400, { error: 'invalid_grant' });
        this.codes.delete(f.get('code')!);
        const out: Record<string, unknown> = {
          access_token: `at-${randomUUID()}`,
          expires_in: 3599,
          scope: c.scope,
          id_token: `x.${b64({ sub: c.u.sub, email: c.u.email, email_verified: true, name: c.u.name, given_name: c.u.given, aud: 'cid' })}.y`,
        };
        if (c.refresh) {
          const r = `rt-${randomUUID()}`;
          this.refresh.set(r, c.u.sub);
          out.refresh_token = r;
        }
        return json(200, out);
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url === 'https://oauth2.googleapis.com/revoke') return json(200, {});
    if (url === `${SUPA}/auth/v1/token?grant_type=id_token`) {
      this.supabaseCalls++;
      expect(new Headers(init?.headers).get('apikey')).toBe('anon-key');
      const { provider, id_token } = JSON.parse(String(init?.body)) as { provider: string; id_token: string };
      if (!this.supabaseGoogleOn) return json(400, { error_code: 'validation_failed', msg: 'Provider (issuer "https://accounts.google.com") is not enabled' });
      expect(provider).toBe('google');
      const claims = JSON.parse(Buffer.from(id_token.split('.')[1]!, 'base64url').toString()) as { sub: string; email: string; email_verified: boolean };
      // Like Supabase: the same Google identity is the same user; a verified email links to an existing account; otherwise a new user.
      let id = this.bySub.get(claims.sub) ?? (claims.email_verified ? this.byVerifiedEmail.get(claims.email) : undefined);
      if (!id) id = randomUUID();
      this.bySub.set(claims.sub, id);
      return json(200, { access_token: jwt(id, claims.email), refresh_token: `sb-${randomUUID()}`, expires_in: 3600, user: { id, email: claims.email } });
    }
    return json(404, {});
  };
}

const fakes = new Fakes();
let server: Server;
let offServer: Server;
let base = '';
let offBase = '';
let db: Db;

async function post(b: string, path: string, body: unknown) {
  const res = await fetch(`${b}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function as(t: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${t}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const count = async (sql: string, p: unknown[]) => Number((await db.query<{ n: string }>(sql, p))[0]!.n);
const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

describe.skipIf(!DB_URL)('Continue with Google (Postgres)', () => {
  beforeAll(async () => {
    db = connect({ url: DB_URL!, ssl: 'off', max: 4 });
    await db.query('drop schema if exists segue cascade');
    await migrate(db);
    const make = (on: boolean) =>
      createServer(
        createApp({
          config: { corsOrigins: ['http://localhost:5173'], rerouteRateLimit: 50 },
          places: new MockPlacesProvider(),
          weather,
          social: createSocial({
            db,
            verifier: createVerifier({ jwtSecret: SECRET }),
            google: on ? { clientId: 'cid', clientSecret: 'shh', key: randomBytes(32), fetch: (i, n) => fakes.fetch(i, n) } : undefined,
            googleSignIn: on ? { supabaseUrl: SUPA, apiKey: 'anon-key', fetch: (i, n) => fakes.fetch(i, n) } : undefined,
            limits: { writesPerHour: 1000 },
          }),
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

  it('says when it is switched on, and refuses when it isn’t', async () => {
    expect((await (await fetch(`${base}/health`)).json()) as object).toMatchObject({ googleSignIn: true, googleCalendar: true });
    expect((await (await fetch(`${offBase}/health`)).json()) as object).toMatchObject({ googleSignIn: false, googleCalendar: false });
    const off = await post(offBase, '/v1/auth/google', { code: fakes.code({ sub: 'g0', email: 'x@gmail.com', name: 'X' }) });
    expect(off.status).toBe(503);
    expect(off.body.code).toBe('google_signin_off');
  });

  it('a new person: one consent makes the account and profile, signs in, and connects the calendar', async () => {
    const u = { sub: 'g-dia', email: 'dia.aviles@gmail.com', name: 'Dia Aviles', given: 'Dia' };
    const r = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.calendar).toMatchObject({ available: true, status: 'connected', email: u.email });
    const t = r.body.session.access_token as string;
    // Signed in straight away, with a profile: no second step.
    const me = await as(t, 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.profile).toMatchObject({ displayName: 'Dia Aviles', username: 'dia' });
    expect((await as(t, 'GET', '/v1/google/calendar')).body.status).toBe('connected');
    // Google's tokens never reach the browser.
    expect(JSON.stringify(r.body)).not.toMatch(/rt-|at-/);
  });

  it('a returning person is the same account, and nothing is duplicated', async () => {
    const u = { sub: 'g-ben', email: 'ben@gmail.com', name: 'Ben Cruz', given: 'Ben' };
    const first = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    const uid = first.body.session.user.id;
    await as(first.body.session.access_token, 'PUT', '/v1/me', { username: first.body.session ? 'ben_cruz' : 'x', displayName: 'Benny' });
    // Later, Google sends no new refresh token (already granted) and a new name: same account, profile untouched, still connected.
    const again = await post(base, '/v1/auth/google', { code: fakes.code({ ...u, name: 'Benjamin Cruz' }, { refresh: false }) });
    expect(again.body.created).toBe(false);
    expect(again.body.session.user.id).toBe(uid);
    expect(again.body.calendar.status).toBe('connected');
    expect(await count('select count(*) as n from segue.profiles where id = $1', [uid])).toBe(1);
    expect(await count('select count(*) as n from segue.google_accounts where user_id = $1', [uid])).toBe(1);
    expect((await as(again.body.session.access_token, 'GET', '/v1/me')).body.profile).toMatchObject({ username: 'ben_cruz', displayName: 'Benny' });
  });

  it('calendar access refused: the account still works, and the answer says the calendar isn’t connected', async () => {
    const r = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-cy', email: 'cy@gmail.com', name: 'Cy' }, { calendar: false }) });
    expect(r.status).toBe(200);
    expect(r.body.calendar).toMatchObject({ status: 'disconnected', problem: 'scope_denied' });
    expect((await as(r.body.session.access_token, 'GET', '/v1/me')).status).toBe(200);
    // Connecting later, from inside the account, works and is the same account.
    const later = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-cy', email: 'cy@gmail.com', name: 'Cy' }) });
    expect(later.body.session.user.id).toBe(r.body.session.user.id);
    expect(later.body.calendar.status).toBe('connected');
  });

  it('an existing email-and-password account is kept: same user, same profile, now with the calendar', async () => {
    const uid = randomUUID();
    const t = jwt(uid, 'ana@gmail.com');
    expect((await as(t, 'PUT', '/v1/me', { username: 'ana_reyes', displayName: 'Ana' })).status).toBe(200);
    fakes.byVerifiedEmail.set('ana@gmail.com', uid); // Supabase links the verified Google email to the existing account
    const r = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-ana', email: 'ana@gmail.com', name: 'Ana R.' }) });
    expect(r.body.session.user.id).toBe(uid);
    expect(r.body.created).toBe(false);
    expect((await as(r.body.session.access_token, 'GET', '/v1/me')).body.profile.username).toBe('ana_reyes');
    expect(r.body.calendar.status).toBe('connected');
  });

  it('an unverified email is never merged into someone else’s account', async () => {
    const victim = randomUUID();
    await as(jwt(victim, 'eve@example.com'), 'PUT', '/v1/me', { username: 'real_eve', displayName: 'Eve' });
    fakes.byVerifiedEmail.set('eve@example.com', victim);
    // The stand-in behaves like Supabase: it links only when Google says the email is verified.
    const c = `code-${randomUUID()}`;
    fakes.codes.set(c, { u: { sub: 'g-mallory', email: 'eve@example.com', name: 'Not Eve' }, scope: `openid email ${EVENTS_SCOPE}`, refresh: true });
    const orig = fakes.fetch;
    fakes.fetch = async (input, init) => {
      const res = await orig(input, init);
      if (String(input) !== 'https://oauth2.googleapis.com/token') return res;
      const b = (await res.json()) as { id_token?: string };
      if (b.id_token) {
        const [h, p, s] = b.id_token.split('.');
        const claims = { ...JSON.parse(Buffer.from(p!, 'base64url').toString()), email_verified: false };
        b.id_token = `${h}.${b64(claims)}.${s}`;
      }
      return new Response(JSON.stringify(b), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    try {
      const r = await post(base, '/v1/auth/google', { code: c });
      expect(r.body.session.user.id).not.toBe(victim);
    } finally {
      fakes.fetch = orig;
    }
  });

  it('a calendar already connected to another Google account isn’t switched by signing in', async () => {
    const u = { sub: 'g-gus', email: 'gus@gmail.com', name: 'Gus' };
    const r = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    const t = r.body.session.access_token;
    // Gus switches his calendar to his work account on purpose.
    await as(t, 'POST', '/v1/google/calendar', { code: fakes.code({ sub: 'g-gus-work', email: 'gus@work.com', name: 'Gus' }), replace: true });
    const back = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    expect(back.body.session.user.id).toBe(r.body.session.user.id);
    expect(back.body.calendar).toMatchObject({ status: 'connected', email: 'gus@work.com', problem: 'other_account' });
  });

  it('two people with the same first name get different usernames', async () => {
    const a = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-jo1', email: 'jo.one@gmail.com', name: 'Jo One', given: 'Jo' }) });
    const b = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-jo2', email: 'jo.two@gmail.com', name: 'Jo Two', given: 'Jo' }) });
    const ua = (await as(a.body.session.access_token, 'GET', '/v1/me')).body.profile.username;
    const ub = (await as(b.body.session.access_token, 'GET', '/v1/me')).body.profile.username;
    expect(ua).not.toBe(ub);
  });

  it('when Supabase hasn’t switched Google on, it says so plainly (no half-made account)', async () => {
    fakes.supabaseGoogleOn = false;
    try {
      const r = await post(base, '/v1/auth/google', { code: fakes.code({ sub: 'g-new', email: 'new@gmail.com', name: 'New' }) });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('google_signin_off');
      expect(await count("select count(*) as n from segue.google_accounts where email = 'new@gmail.com'", [])).toBe(0);
    } finally {
      fakes.supabaseGoogleOn = true;
    }
  });

  it('a bad or reused code is refused', async () => {
    const c = fakes.code({ sub: 'g-kai', email: 'kai@gmail.com', name: 'Kai' });
    expect((await post(base, '/v1/auth/google', { code: c })).status).toBe(200);
    expect((await post(base, '/v1/auth/google', { code: c })).body.code).toBe('google_code_invalid');
    expect((await post(base, '/v1/auth/google', { code: 'nope' })).status).toBe(400);
  });

  it('signing out and back in with Google, after access was revoked, reconnects without a new account', async () => {
    const u = { sub: 'g-lee', email: 'lee@gmail.com', name: 'Lee' };
    const first = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    const uid = first.body.session.user.id;
    await db.query("update segue.google_accounts set status = 'needs_reauth' where user_id = $1", [uid]);
    const again = await post(base, '/v1/auth/google', { code: fakes.code(u) });
    expect(again.body.session.user.id).toBe(uid);
    expect(again.body.calendar.status).toBe('connected');
    expect(await count('select count(*) as n from segue.profiles where id = $1', [uid])).toBe(1);
  });
});
