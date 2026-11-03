/**
 * Google sign-in and Calendar reads, straight from the browser with Google
 * Identity Services. The access token is short-lived (about an hour), stays
 * in memory, and never reaches the Segue API. Scope is read-only.
 */
import { dayBounds, parseAllDay, parseEvents, type AllDayEvent, type CalendarEvent, type GoogleEvent, type GoogleEventPage } from './calendar';
import { keyOf } from './days';

export const GOOGLE_CLIENT_ID: string | undefined = import.meta.env?.VITE_GOOGLE_CLIENT_ID || undefined;
const EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
// Optional: lets Segue read every calendar you have switched on, not just your main one.
const LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const SCOPE = `${EVENTS_SCOPE} ${LIST_SCOPE}`;
const API = 'https://www.googleapis.com/calendar/v3';
/** Enough for work, personal and a few shared calendars without slowing sync down. */
const MAX_CALENDARS = 10;
/** Pages of 250 events per calendar: plenty for a day or a month. */
const MAX_PAGES = 4;
const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}
interface TokenClient {
  requestAccessToken(opts?: { prompt?: '' | 'consent' }): void;
}
interface Gis {
  accounts: {
    oauth2: {
      initTokenClient(cfg: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type: string }) => void;
      }): TokenClient;
      initCodeClient(cfg: {
        client_id: string;
        scope: string;
        ux_mode: 'popup';
        select_account?: boolean;
        callback: (r: { code?: string; scope?: string; error?: string }) => void;
        error_callback?: (e: { type: string }) => void;
      }): { requestCode(): void };
      hasGrantedAllScopes(r: TokenResponse, scope: string): boolean;
      revoke(token: string, done?: () => void): void;
    };
  };
}
declare global {
  interface Window {
    google?: Gis;
  }
}

export interface GoogleToken {
  value: string;
  expiresAt: number;
}

/** Why a calendar action failed, so the UI can say what to do. */
export class CalendarError extends Error {
  constructor(
    readonly kind: 'cancelled' | 'denied' | 'expired' | 'network' | 'unavailable' | 'busy' | 'reconnect' | 'other-account',
    message?: string,
  ) {
    super(message ?? kind);
  }
}

let loading: Promise<void> | null = null;

/** Load Google's sign-in script ahead of time, so the sign-in popup can open straight from a tap. */
export function preloadGoogle(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new CalendarError('network'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export const tokenValid = (t: GoogleToken | null): t is GoogleToken => !!t && t.expiresAt - Date.now() > 60_000;

/**
 * The one Google token for this page: memory only, never saved, never sent to
 * the Segue API. Used only when the server isn't keeping the connection.
 */
let current: GoogleToken | null = null;
export const currentToken = () => current;
export function forgetToken() {
  current = null;
}

/** Who signed in, from Google. */
export interface GoogleProfile {
  sub: string;
  name: string;
  email: string;
  picture?: string;
}

/**
 * Ask Google for a read-only token. Call it straight from a tap: when the
 * script is already loaded the popup opens in the same tick, which keeps
 * popup blockers happy. `consent` shows the full prompt; '' reuses an
 * earlier grant and usually closes on its own.
 */
export function requestToken(prompt: '' | 'consent'): Promise<GoogleToken> {
  return new Promise((resolve, reject) => {
    const open = () => {
      const oauth = window.google!.accounts.oauth2;
      oauth
        .initTokenClient({
          client_id: GOOGLE_CLIENT_ID!,
          scope: SCOPE,
          callback: (r) => {
            if (r.error || !r.access_token) return reject(new CalendarError('denied'));
            if (!oauth.hasGrantedAllScopes(r, EVENTS_SCOPE)) return reject(new CalendarError('denied'));
            const token = { value: r.access_token, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
            current = token;
            resolve(token);
          },
          error_callback: (e) => reject(new CalendarError(e.type === 'popup_closed' ? 'cancelled' : 'unavailable')),
        })
        .requestAccessToken({ prompt });
    };
    if (!GOOGLE_CLIENT_ID) return reject(new CalendarError('unavailable'));
    if (window.google?.accounts?.oauth2) return open();
    preloadGoogle().then(open, reject);
  });
}

async function getJson<T>(token: GoogleToken, url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token.value}` } });
  } catch {
    throw new CalendarError('network');
  }
  if (res.status === 401) throw new CalendarError('expired');
  if (res.status === 429) throw new CalendarError('busy');
  if (res.status === 403) {
    // Google also answers 403 when it's rate limiting, which isn't a permission problem.
    const reason = await res
      .json()
      .then((b: { error?: { errors?: { reason?: string }[] } }) => b.error?.errors?.[0]?.reason ?? '')
      .catch(() => '');
    throw new CalendarError(/rateLimit|quotaExceeded/i.test(reason) ? 'busy' : 'denied');
  }
  if (!res.ok) throw new CalendarError('network');
  return (await res.json()) as T;
}

/** The calendars switched on in Google Calendar, main one first. Just the main one without the list permission. */
async function calendarIds(token: GoogleToken): Promise<string[]> {
  try {
    const body = await getJson<{ items?: { id: string; primary?: boolean; selected?: boolean; hidden?: boolean; deleted?: boolean }[] }>(
      token,
      `${API}/users/me/calendarList?minAccessRole=reader&maxResults=50`,
    );
    const on = (body.items ?? []).filter((c) => c.selected !== false && !c.hidden && !c.deleted);
    const ids = [...on.filter((c) => c.primary), ...on.filter((c) => !c.primary)].map((c) => (c.primary ? 'primary' : c.id));
    return ids.length ? ids.slice(0, MAX_CALENDARS) : ['primary'];
  } catch (e) {
    if (e instanceof CalendarError && e.kind === 'expired') throw e;
    return ['primary'];
  }
}

/**
 * Where events come from: Segue's server (it keeps the connection) or this
 * page's own short-lived Google token. Either way, the raw Google items.
 */
export type EventSource = (start: string, end: string) => Promise<GoogleEvent[]>;
export const tokenSource =
  (token: GoogleToken): EventSource =>
  (start, end) =>
    fetchItems(token, start, end);
const asSource = (s: GoogleToken | EventSource): EventSource => (typeof s === 'function' ? s : tokenSource(s));

/** Today's busy events, and its all-day events, from every calendar that's switched on. */
export async function fetchTodayEvents(from: GoogleToken | EventSource, day: Date): Promise<{ events: CalendarEvent[]; allDay: AllDayEvent[] }> {
  const { start, end } = dayBounds(day);
  const items = await asSource(from)(start, end);
  return { events: parseEvents(items, start, end), allDay: parseAllDay(items, keyOf(day)) };
}

/**
 * Busy events between two ISO times, from every calendar that's switched on.
 * Used for today and for the days you open on the calendar.
 */
export async function fetchEvents(from: GoogleToken | EventSource, start: string, end: string): Promise<CalendarEvent[]> {
  return parseEvents(await asSource(from)(start, end), start, end);
}

/**
 * Ask Google for a one-time code that Segue's server swaps for a lasting,
 * read-only connection. Call straight from a tap (it opens Google's popup).
 * Includes "email" so the server can say which Google account is connected.
 */
export function requestCode({ profile = false }: { profile?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const open = () => {
      window
        .google!.accounts.oauth2.initCodeClient({
          client_id: GOOGLE_CLIENT_ID!,
          // Signing in also asks for the name, for the new account's profile.
          scope: `openid email${profile ? ' profile' : ''} ${SCOPE}`,
          ux_mode: 'popup',
          select_account: true,
          callback: (r) => {
            if (r.error || !r.code) return reject(new CalendarError('denied'));
            // Signing in still works without calendar access: the server makes the account and says the calendar isn't connected.
            if (!profile && !(r.scope ?? '').split(/\s+/).includes(EVENTS_SCOPE)) return reject(new CalendarError('denied'));
            resolve(r.code);
          },
          error_callback: (e) => reject(new CalendarError(e.type === 'popup_closed' ? 'cancelled' : 'unavailable')),
        })
        .requestCode();
    };
    if (!GOOGLE_CLIENT_ID) return reject(new CalendarError('unavailable'));
    if (window.google?.accounts?.oauth2) return open();
    preloadGoogle().then(open, reject);
  });
}

/** Every page of one calendar's events in the window (recurring events expanded). */
async function calendarItems(token: GoogleToken, id: string, start: string, end: string): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let page: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({ timeMin: start, timeMax: end, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    if (page) params.set('pageToken', page);
    const body = await getJson<GoogleEventPage>(token, `${API}/calendars/${encodeURIComponent(id)}/events?${params}`);
    out.push(...(body.items ?? []));
    page = body.nextPageToken;
    if (!page) break;
  }
  return out;
}

async function fetchItems(token: GoogleToken, start: string, end: string): Promise<GoogleEvent[]> {
  const ids = await calendarIds(token);
  const lists = await Promise.all(
    ids.map((id) =>
      calendarItems(token, id, start, end).catch((e) => {
        // The main calendar must work; a shared one that fails is skipped.
        if (id === 'primary' || (e instanceof CalendarError && e.kind === 'expired')) throw e;
        return [] as GoogleEvent[];
      }),
    ),
  );
  return lists.flat();
}

export function revokeToken(token: GoogleToken | null): void {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.value);
  current = null;
}

/** Plain words for each failure: what happened and what to do. */
export function calendarErrorMessage(e: unknown): string {
  const kind = e instanceof CalendarError ? e.kind : 'network';
  switch (kind) {
    case 'cancelled':
      // Also what happens when Google shows "Access blocked" (an address or account the Google project doesn't allow yet) and the window is closed.
      return "Google sign-in didn't finish. If Google said “Access blocked”, Segue's Google sign-in isn't open to your account yet. You can still use Segue without Google, or try the demo.";
    case 'denied':
      return "Google didn't give Segue access to your calendar. Try again and allow access, or use Segue without Google.";
    case 'expired':
      return 'Your Google sign-in has expired. Tap Sync now to sign in again.';
    case 'unavailable':
      return "Couldn't open Google sign-in. Allow pop-ups for this site, then try again.";
    case 'busy':
      return 'Google Calendar is busy right now. Try again in a minute.';
    case 'reconnect':
      return 'Your Google Calendar connection needs attention. Reconnect Google Calendar to bring your events back.';
    case 'other-account':
      return e instanceof CalendarError && e.message !== kind ? e.message : 'Segue is connected to a different Google account.';
    default:
      return "Couldn't reach Google Calendar. Check your connection and try again.";
  }
}
