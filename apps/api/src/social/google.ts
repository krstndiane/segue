/**
 * Google Calendar, connected once and kept connected.
 *
 * The browser asks Google for a one-time code (Google's popup, read-only
 * calendar scopes) and hands it to these routes. The server swaps it for a
 * refresh token, encrypts it (AES-256-GCM, bound to the Segue user id) and
 * keeps it in segue.google_accounts. From then on the server gets short-lived
 * access tokens on its own, so the app never has to ask again unless Google
 * says the access was revoked or expired for good.
 *
 * Events pass through to the app and are not stored here. Segue only reads
 * the calendar; nothing is written to Google.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../http';
import { parse, path, type Ctx, type Route } from './core';
import { iso, type Row } from './views';

export const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
/** Enough for work, personal and a few shared calendars. */
const MAX_CALENDARS = 10;
/** Pages of 250 events per calendar. */
const MAX_PAGES = 4;
/** The longest window one request may read (the calendar shows a month at a time). */
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000;

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  /** 32 bytes. Encrypts the tokens at rest. */
  key: Buffer;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** What the app shows: the server is the only source of truth for it. */
export interface GoogleCalendarStatus {
  /** The server can keep a connection (it has Google credentials). */
  available: boolean;
  status: 'connected' | 'needs_attention' | 'disconnected';
  email?: string;
  connectedAt?: string;
  lastSyncedAt?: string;
}

// ---- tokens at rest ----

export function sealToken(key: Buffer, userId: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function openToken(key: Buffer, userId: string, sealed: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown token format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(userId));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** GOOGLE_TOKEN_KEY: 32 bytes, as base64 or 64 hex characters. */
export function parseTokenKey(raw: string): Buffer {
  const v = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) throw new Error('GOOGLE_TOKEN_KEY must be 32 bytes (base64, or 64 hex characters)');
  return key;
}

// ---- talking to Google ----

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
}

class GoogleRefused extends Error {
  constructor(
    readonly reason: 'revoked' | 'unreachable' | 'denied' | 'busy',
    detail = '',
  ) {
    super(detail || reason);
  }
}

async function tokenCall(g: GoogleCalendarConfig, form: Record<string, string>): Promise<TokenAnswer> {
  let res: Response;
  try {
    res = await (g.fetch ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, ...form }).toString(),
    });
  } catch (e) {
    throw new GoogleRefused('unreachable', (e as Error).message);
  }
  const body = (await res.json().catch(() => ({}))) as TokenAnswer;
  if (res.ok && body.access_token) return body;
  // invalid_grant: the refresh token was revoked, expired, or the code was already used.
  if (body.error === 'invalid_grant') throw new GoogleRefused('revoked', 'invalid_grant');
  if (res.status >= 500) throw new GoogleRefused('unreachable', `token ${res.status}`);
  throw new GoogleRefused('denied', body.error ?? `token ${res.status}`);
}

/** The Google account behind an id token straight from Google's token endpoint (over TLS, so no signature check is needed). */
function whoFromIdToken(idToken: string | undefined): { sub: string; email: string } | null {
  try {
    const payload = JSON.parse(Buffer.from((idToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; email?: string };
    return payload.sub ? { sub: payload.sub, email: payload.email ?? '' } : null;
  } catch {
    return null;
  }
}

async function revoke(g: GoogleCalendarConfig, token: string): Promise<void> {
  try {
    await (g.fetch ?? fetch)(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
  } catch {
    // Best effort: the connection is removed from Segue either way.
  }
}

async function calendarGet<T>(g: GoogleCalendarConfig, access: string, url: string): Promise<T> {
  let res: Response;
  try {
    res = await (g.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${access}` } });
  } catch (e) {
    throw new GoogleRefused('unreachable', (e as Error).message);
  }
  if (res.status === 401) throw new GoogleRefused('revoked', 'calendar 401');
  if (res.status === 429) throw new GoogleRefused('busy');
  if (res.status === 403) {
    const reason = await res
      .json()
      .then((b: { error?: { errors?: { reason?: string }[] } }) => b.error?.errors?.[0]?.reason ?? '')
      .catch(() => '');
    throw new GoogleRefused(/rateLimit|quotaExceeded/i.test(reason) ? 'busy' : 'denied', reason);
  }
  if (!res.ok) throw new GoogleRefused('unreachable', `calendar ${res.status}`);
  return (await res.json()) as T;
}

/** Only what the app needs from each event: no descriptions, attendee lists or links. */
interface EventItem {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  location?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self: true; responseStatus?: string }[];
}

function slim(e: Record<string, unknown>): EventItem | null {
  if (typeof e.id !== 'string') return null;
  const when = (v: unknown) => {
    const o = (v ?? {}) as { dateTime?: unknown; date?: unknown };
    return { ...(typeof o.dateTime === 'string' ? { dateTime: o.dateTime } : {}), ...(typeof o.date === 'string' ? { date: o.date } : {}) };
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const me = Array.isArray(e.attendees) ? (e.attendees as { self?: boolean; responseStatus?: string }[]).find((a) => a?.self) : undefined;
  return {
    id: e.id,
    iCalUID: str(e.iCalUID),
    status: str(e.status),
    summary: str(e.summary),
    location: str(e.location),
    transparency: str(e.transparency),
    start: when(e.start),
    end: when(e.end),
    ...(me ? { attendees: [{ self: true as const, responseStatus: str(me.responseStatus) }] } : {}),
  };
}

async function readEvents(g: GoogleCalendarConfig, access: string, start: string, end: string, withList: boolean): Promise<EventItem[]> {
  let ids = ['primary'];
  if (withList) {
    try {
      const body = await calendarGet<{ items?: { id: string; primary?: boolean; selected?: boolean; hidden?: boolean; deleted?: boolean }[] }>(
        g,
        access,
        `${API}/users/me/calendarList?minAccessRole=reader&maxResults=50`,
      );
      const on = (body.items ?? []).filter((c) => c.selected !== false && !c.hidden && !c.deleted);
      const list = [...on.filter((c) => c.primary), ...on.filter((c) => !c.primary)].map((c) => (c.primary ? 'primary' : c.id));
      if (list.length) ids = list.slice(0, MAX_CALENDARS);
    } catch (e) {
      if (e instanceof GoogleRefused && e.reason === 'revoked') throw e;
    }
  }
  const one = async (id: string) => {
    const out: EventItem[] = [];
    let page: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const p = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      if (page) p.set('pageToken', page);
      const body = await calendarGet<{ items?: Record<string, unknown>[]; nextPageToken?: string }>(g, access, `${API}/calendars/${encodeURIComponent(id)}/events?${p}`);
      for (const e of body.items ?? []) {
        const s = slim(e);
        if (s) out.push(s);
      }
      page = body.nextPageToken;
      if (!page) break;
    }
    return out;
  };
  const lists = await Promise.all(
    ids.map((id) =>
      one(id).catch((e) => {
        // The main calendar must work; a shared one that fails is skipped.
        if (id === 'primary' || (e instanceof GoogleRefused && e.reason === 'revoked')) throw e;
        return [] as EventItem[];
      }),
    ),
  );
  return lists.flat();
}

// ---- the routes ----

const ConnectSchema = z.object({
  code: z.string().min(10).max(2048),
  /** Deliberately switch to a different Google account than the one connected now. */
  replace: z.boolean().optional(),
});

const RangeSchema = z
  .object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) })
  .refine((r) => Date.parse(r.end) > Date.parse(r.start) && Date.parse(r.end) - Date.parse(r.start) <= MAX_RANGE_MS, 'end must be after start, within 62 days');

function statusOf(row: Row | undefined, available: boolean): GoogleCalendarStatus {
  if (!row) return { available, status: 'disconnected' };
  return {
    available,
    status: row.status === 'active' ? 'connected' : 'needs_attention',
    email: String(row.email || '') || undefined,
    connectedAt: iso(row.created_at) ?? undefined,
    lastSyncedAt: iso(row.last_synced_at) ?? undefined,
  };
}

const rowFor = async (ctx: Ctx) => (await ctx.db.query('select * from segue.google_accounts where user_id = $1', [ctx.user.id]))[0];

function needs(ctx: Ctx): GoogleCalendarConfig {
  const g = ctx.deps.google;
  if (!g) throw new HttpError(503, "Staying connected to Google Calendar isn't set up on this server yet", undefined, {}, 'google_off');
  return g;
}

async function markNeedsAttention(ctx: Ctx, why: string) {
  await ctx.db.query(
    `update segue.google_accounts set status = 'needs_reauth', access_token_enc = null, access_expires_at = null, last_error = $2, updated_at = now() where user_id = $1`,
    [ctx.user.id, why.slice(0, 300)],
  );
}

const reconnect = () => new HttpError(409, 'Your Google Calendar connection needs attention. Reconnect Google Calendar.', undefined, {}, 'google_reconnect');

/** A live access token: the saved one if it has a minute left, otherwise a fresh one from the refresh token. */
async function accessToken(ctx: Ctx, g: GoogleCalendarConfig, row: Row, force = false): Promise<string> {
  const uid = ctx.user.id;
  const now = ctx.deps.now?.() ?? Date.now();
  const exp = row.access_expires_at ? Date.parse(String(iso(row.access_expires_at))) : 0;
  if (!force && row.access_token_enc && exp - now > 60_000) {
    try {
      return openToken(g.key, uid, String(row.access_token_enc));
    } catch {
      // fall through to a refresh
    }
  }
  if (!row.refresh_token_enc) {
    await markNeedsAttention(ctx, 'no refresh token');
    throw reconnect();
  }
  let refresh: string;
  try {
    refresh = openToken(g.key, uid, String(row.refresh_token_enc));
  } catch {
    // The key changed: the saved token can't be read any more.
    await markNeedsAttention(ctx, 'token unreadable');
    throw reconnect();
  }
  try {
    const t = await tokenCall(g, { grant_type: 'refresh_token', refresh_token: refresh });
    const expires = new Date(now + (t.expires_in ?? 3600) * 1000);
    await ctx.db.query(
      `update segue.google_accounts set access_token_enc = $2, access_expires_at = $3, status = 'active', last_error = null, updated_at = now() where user_id = $1`,
      [uid, sealToken(g.key, uid, t.access_token!), expires],
    );
    return t.access_token!;
  } catch (e) {
    if (e instanceof GoogleRefused && (e.reason === 'revoked' || e.reason === 'denied')) {
      await markNeedsAttention(ctx, e.message);
      throw reconnect();
    }
    throw new HttpError(502, "Couldn't reach Google Calendar. Try again in a minute.", undefined, {}, 'google_unreachable');
  }
}

export const googleRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/google/calendar'),
    async handler(ctx) {
      return { status: 200, body: statusOf(await rowFor(ctx), !!ctx.deps.google) };
    },
  },
  {
    method: 'POST',
    path: path('/v1/google/calendar'),
    async handler(ctx) {
      const g = needs(ctx);
      await ctx.profile();
      ctx.limit('write');
      const { code, replace } = parse(ConnectSchema, await ctx.body());
      let t: TokenAnswer;
      try {
        // "postmessage": the code came from Google's popup on Segue's own page.
        t = await tokenCall(g, { grant_type: 'authorization_code', code, redirect_uri: 'postmessage' });
      } catch (e) {
        if (e instanceof GoogleRefused && e.reason === 'unreachable') throw new HttpError(502, "Couldn't reach Google. Try again in a minute.", undefined, {}, 'google_unreachable');
        throw new HttpError(400, "Google didn't accept that sign-in. Try connecting again.", undefined, {}, 'google_code_invalid');
      }
      const scopes = (t.scope ?? '').split(/\s+/).filter(Boolean);
      if (!scopes.includes(EVENTS_SCOPE)) {
        await revoke(g, t.access_token!);
        throw new HttpError(400, "Google didn't give Segue access to your calendar. Connect again and allow access.", undefined, {}, 'google_scope_missing');
      }
      const who = whoFromIdToken(t.id_token);
      if (!who) {
        await revoke(g, t.access_token!);
        throw new HttpError(400, "Google didn't say which account this is. Try connecting again.", undefined, {}, 'google_code_invalid');
      }
      const existing = await rowFor(ctx);
      if (existing && existing.google_sub !== who.sub && !replace) {
        // Don't switch accounts silently: the app asks first.
        await revoke(g, t.access_token!);
        throw new HttpError(
          409,
          `Segue is connected to ${existing.email}. Disconnect it first, or choose to switch to ${who.email}.`,
          { connected: existing.email, offered: who.email },
          {},
          'google_other_account',
        );
      }
      const uid = ctx.user.id;
      // Google only sends a refresh token on first consent; keep the one we have for the same account.
      const refreshSealed = t.refresh_token
        ? sealToken(g.key, uid, t.refresh_token)
        : existing && existing.google_sub === who.sub && existing.refresh_token_enc
          ? String(existing.refresh_token_enc)
          : null;
      if (!refreshSealed) {
        await revoke(g, t.access_token!);
        throw new HttpError(400, "Google didn't give Segue lasting access. Try connecting again.", undefined, {}, 'google_no_offline');
      }
      if (existing && existing.google_sub !== who.sub && existing.refresh_token_enc) {
        // Switching accounts: let go of the old one at Google too.
        try {
          await revoke(g, openToken(g.key, uid, String(existing.refresh_token_enc)));
        } catch {
          // unreadable: nothing to revoke
        }
      }
      const now = ctx.deps.now?.() ?? Date.now();
      const rows = await ctx.db.query(
        `insert into segue.google_accounts (user_id, google_sub, email, scopes, refresh_token_enc, access_token_enc, access_expires_at, status, last_error)
         values ($1, $2, $3, $4, $5, $6, $7, 'active', null)
         on conflict (user_id) do update set
           google_sub = excluded.google_sub, email = excluded.email, scopes = excluded.scopes,
           refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
           access_expires_at = excluded.access_expires_at, status = 'active', last_error = null,
           created_at = case when segue.google_accounts.google_sub = excluded.google_sub then segue.google_accounts.created_at else now() end,
           last_synced_at = case when segue.google_accounts.google_sub = excluded.google_sub then segue.google_accounts.last_synced_at else null end,
           updated_at = now()
         returning *`,
        [uid, who.sub, who.email.slice(0, 320), scopes.join(' '), refreshSealed, sealToken(g.key, uid, t.access_token!), new Date(now + (t.expires_in ?? 3600) * 1000)],
      );
      return { status: 200, body: statusOf(rows[0], true) };
    },
  },
  {
    method: 'GET',
    path: path('/v1/google/calendar/events'),
    async handler(ctx) {
      const g = needs(ctx);
      ctx.limit('sync');
      const { start, end } = parse(RangeSchema, { start: ctx.url.searchParams.get('start'), end: ctx.url.searchParams.get('end') });
      const row = await rowFor(ctx);
      if (!row) throw new HttpError(404, "Google Calendar isn't connected", undefined, {}, 'google_not_connected');
      if (row.status !== 'active') throw reconnect();
      const withList = String(row.scopes ?? '').split(/\s+/).includes(LIST_SCOPE);
      let items: EventItem[];
      try {
        items = await readEvents(g, await accessToken(ctx, g, row), start, end, withList);
      } catch (e) {
        if (!(e instanceof GoogleRefused)) throw e;
        if (e.reason === 'revoked') {
          // The saved access token stopped working early: one fresh try.
          try {
            items = await readEvents(g, await accessToken(ctx, g, row, true), start, end, withList);
          } catch (again) {
            if (again instanceof GoogleRefused && again.reason === 'revoked') {
              await markNeedsAttention(ctx, again.message);
              throw reconnect();
            }
            throw again instanceof GoogleRefused ? refusedToHttp(again) : again;
          }
        } else throw refusedToHttp(e);
      }
      const syncedAt = new Date(ctx.deps.now?.() ?? Date.now());
      await ctx.db.query('update segue.google_accounts set last_synced_at = $2 where user_id = $1', [ctx.user.id, syncedAt]);
      return { status: 200, body: { items, syncedAt: syncedAt.toISOString(), email: row.email } };
    },
  },
  {
    method: 'DELETE',
    path: path('/v1/google/calendar'),
    async handler(ctx) {
      await forgetGoogle(ctx);
      return { status: 200, body: statusOf(undefined, !!ctx.deps.google) };
    },
  },
];

/** Disconnect: revoke the grant at Google (best effort) and remove it from Segue. Also used when an account is deleted. */
export async function forgetGoogle(ctx: Ctx): Promise<void> {
  const row = await rowFor(ctx);
  const g = ctx.deps.google;
  if (row && g) {
    for (const col of ['refresh_token_enc', 'access_token_enc'] as const) {
      if (!row[col]) continue;
      try {
        await revoke(g, openToken(g.key, ctx.user.id, String(row[col])));
        break; // revoking either one ends the whole grant
      } catch {
        // unreadable: try the other
      }
    }
  }
  await ctx.db.query('delete from segue.google_accounts where user_id = $1', [ctx.user.id]);
}

function refusedToHttp(e: GoogleRefused): HttpError {
  if (e.reason === 'busy') return new HttpError(503, 'Google Calendar is busy right now. Try again in a minute.', undefined, {}, 'google_busy');
  if (e.reason === 'denied') return new HttpError(502, "Google Calendar didn't let Segue read that calendar.", undefined, {}, 'google_denied');
  return new HttpError(502, "Couldn't reach Google Calendar. Try again in a minute.", undefined, {}, 'google_unreachable');
}
