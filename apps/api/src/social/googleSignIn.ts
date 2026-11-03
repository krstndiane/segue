/**
 * Continue with Google: one Google consent signs you in to Segue (creating the
 * account the first time) and connects Google Calendar.
 *
 * 1. The browser gets a one-time code from Google's popup (openid email profile
 *    plus the read-only calendar scopes) and posts it here. No Segue session yet.
 * 2. The server swaps the code once, with the client secret.
 * 3. Google's id token goes to Supabase Auth (grant_type=id_token, provider
 *    google). Supabase checks the token's signature and audience and finds or
 *    creates the user by the verified Google identity. It links to an existing
 *    account only when the email is verified, never on an unverified email.
 * 4. A Segue profile is made the first time (a username from the name or email,
 *    the Google name); an existing profile is never changed.
 * 5. The same grant is saved as the calendar connection (encrypted). If calendar
 *    access was refused, the account still works and the answer says so.
 *
 * The Supabase session goes back to the browser like any Segue sign-in; Google's
 * tokens stay on the server.
 */
import { checkUsername, normalizeUsername, usernameCandidates } from '@segue/schemas';
import { z } from 'zod';
import { AuthError } from '../auth';
import { HttpError } from '../http';
import type { SocialDeps } from './core';
import { GoogleRefused, statusOf, storeConnection, tokenCall, type GoogleCalendarStatus, type TokenAnswer } from './google';
import type { Row } from './views';

export interface GoogleSignInConfig {
  /** https://<project>.supabase.co */
  supabaseUrl: string;
  /** The project's anon (publishable) key, or the service key: Supabase needs one on every call. */
  apiKey: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const BodySchema = z.object({ code: z.string().min(10).max(2048) });

export interface GoogleSignInAnswer {
  /** Supabase's session, as its own sign-in returns it */
  session: { access_token: string; refresh_token: string; expires_in?: number; expires_at?: number; user: { id: string; email?: string } };
  /** true the first time: the account (or at least the Segue profile) was just made */
  created: boolean;
  calendar: GoogleCalendarStatus & { problem?: 'scope_denied' | 'other_account' | 'no_offline' };
}

function claims(idToken: string | undefined): { sub?: string; email?: string; email_verified?: boolean; name?: string; given_name?: string } {
  try {
    return JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** A username for a new account: from the Google name or the email, made unique. */
async function newUsername(db: SocialDeps['db'], base: string, reserved: string[]): Promise<string[]> {
  const root = normalizeUsername(base).replace(/[^a-z0-9_]/g, '');
  const year = new Date().getUTCFullYear();
  const list = [root, ...usernameCandidates(root, year)];
  for (let i = 0; i < 6; i++) list.push(`${root.slice(0, 14) || 'segue'}_${Math.random().toString(36).slice(2, 6)}`);
  const ok = [...new Set(list)].filter((n) => checkUsername(n, reserved).ok);
  if (!ok.length) return [];
  const taken = new Set((await db.query<{ username: string }>('select username from segue.profiles where username = any($1::text[])', [ok])).map((r) => r.username));
  return ok.filter((n) => !taken.has(n));
}

async function ensureProfile(deps: SocialDeps, uid: string, c: ReturnType<typeof claims>): Promise<boolean> {
  const db = deps.db;
  if ((await db.query('select 1 from segue.profiles where id = $1', [uid])).length) return false;
  const display = (c.name || c.given_name || (c.email ?? '').split('@')[0] || 'Segue user').trim().slice(0, 50);
  const bases = [c.given_name, c.name?.replace(/\s+/g, '_'), (c.email ?? '').split('@')[0]].filter((x): x is string => !!x);
  for (const base of bases) {
    for (const username of await newUsername(db, base, deps.reservedUsernames ?? [])) {
      const rows = await db.query(
        `insert into segue.profiles (id, username, display_name) values ($1, $2, $3) on conflict do nothing returning id`,
        [uid, username, display],
      );
      if (rows.length) return true;
      // Someone took that name a moment ago, or the profile now exists (a second tab): check and go on.
      if ((await db.query('select 1 from segue.profiles where id = $1', [uid])).length) return false;
    }
  }
  throw new HttpError(500, "Couldn't finish setting up your account. Try again.", undefined, {}, 'profile_failed');
}

export async function signInWithGoogle(deps: SocialDeps, raw: unknown): Promise<{ status: number; body: unknown }> {
  const g = deps.google;
  const s = deps.googleSignIn;
  if (!g || !s) throw new HttpError(503, 'Continue with Google isn’t switched on yet. Use email for now.', undefined, {}, 'google_signin_off');
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'Some of those details are not valid');

  let t: TokenAnswer;
  try {
    t = await tokenCall(g, { grant_type: 'authorization_code', code: parsed.data.code, redirect_uri: 'postmessage' });
  } catch (e) {
    if (e instanceof GoogleRefused && e.reason === 'unreachable') throw new HttpError(502, "Couldn't reach Google. Try again in a minute.", undefined, {}, 'google_unreachable');
    throw new HttpError(400, "Google didn't accept that sign-in. Try again.", undefined, {}, 'google_code_invalid');
  }
  if (!t.id_token) throw new HttpError(400, "Google didn't say who you are. Try again.", undefined, {}, 'google_code_invalid');

  // Supabase checks the id token (signature, audience, expiry) and finds or creates the user by the verified Google identity.
  let res: Response;
  try {
    res = await (s.fetch ?? fetch)(`${s.supabaseUrl}/auth/v1/token?grant_type=id_token`, {
      method: 'POST',
      headers: { apikey: s.apiKey, authorization: `Bearer ${s.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', id_token: t.id_token }),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Segue's sign-in. Try again in a minute.", undefined, {}, 'signin_unreachable');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<GoogleSignInAnswer['session']> & { msg?: string; error_description?: string; error_code?: string };
  if (!res.ok || !body.access_token || !body.refresh_token || !body.user?.id) {
    const why = `${body.error_code ?? ''} ${body.msg ?? body.error_description ?? ''}`.toLowerCase();
    if (/provider|not enabled|unsupported/.test(why)) {
      throw new HttpError(503, 'Continue with Google isn’t switched on yet. Use email for now.', undefined, {}, 'google_signin_off');
    }
    if (res.status >= 500) throw new HttpError(502, "Couldn't reach Segue's sign-in. Try again in a minute.", undefined, {}, 'signin_unreachable');
    throw new HttpError(400, "Couldn't sign you in with that Google account. Try again.", undefined, {}, 'google_signin_refused');
  }
  // Trust the session only after checking it like any other request's.
  let uid: string;
  try {
    uid = (await deps.verifier.verify(body.access_token)).id;
  } catch (e) {
    if (!(e instanceof AuthError)) deps.log?.(`google sign-in token check failed: ${(e as Error).message}`);
    throw new HttpError(502, "Couldn't finish signing you in. Try again.", undefined, {}, 'signin_unreachable');
  }
  if (uid !== body.user.id) throw new HttpError(502, "Couldn't finish signing you in. Try again.", undefined, {}, 'signin_unreachable');

  const c = claims(t.id_token);
  const created = await ensureProfile(deps, uid, c);

  // The same consent connects Google Calendar, unless calendar access was refused.
  let calendar: GoogleSignInAnswer['calendar'];
  const existing = (await deps.db.query<Row>('select * from segue.google_accounts where user_id = $1', [uid]))[0];
  try {
    calendar = statusOf(await storeConnection(deps.db, g, uid, t, { now: deps.now?.() ?? Date.now() }), true);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : undefined;
    if (code === 'google_scope_missing') calendar = { ...statusOf(existing, true), problem: 'scope_denied' };
    else if (code === 'google_other_account') calendar = { ...statusOf(existing, true), problem: 'other_account' };
    else if (code === 'google_no_offline') calendar = { ...statusOf(existing, true), problem: 'no_offline' };
    else throw e;
  }
  const answer: GoogleSignInAnswer = {
    session: { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, expires_at: body.expires_at, user: { id: uid, email: body.user.email } },
    created,
    calendar,
  };
  return { status: 200, body: answer };
}
