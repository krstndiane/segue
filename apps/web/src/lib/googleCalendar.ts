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
/** Signing up also asks for your name, email and photo, to greet you and show who's signed in. */
const PROFILE_SCOPE = 'openid email profile';
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
  constructor(readonly kind: 'cancelled' | 'denied' | 'expired' | 'network' | 'unavailable' | 'busy') {
    super(kind);
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
 * the Segue API. Shared so signing up on the landing page carries into the app
 * (they switch without a page load).
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

export async function fetchProfile(token: GoogleToken): Promise<GoogleProfile> {
  const p = await getJson<{ sub: string; name?: string; given_name?: string; email?: string; picture?: string }>(
    token,
    'https://www.googleapis.com/oauth2/v3/userinfo',
  );
  return { sub: p.sub, name: p.name ?? p.given_name ?? 'there', email: p.email ?? '', picture: p.picture };
}

/**
 * Ask Google for a read-only token. Call it straight from a tap: when the
 * script is already loaded the popup opens in the same tick, which keeps
 * popup blockers happy. `consent` shows the full prompt; '' reuses an
 * earlier grant and usually closes on its own.
 */
export function requestToken(prompt: '' | 'consent', { profile = false } = {}): Promise<GoogleToken> {
  return new Promise((resolve, reject) => {
    const open = () => {
      const oauth = window.google!.accounts.oauth2;
      oauth
        .initTokenClient({
          client_id: GOOGLE_CLIENT_ID!,
          scope: profile ? `${PROFILE_SCOPE} ${SCOPE}` : SCOPE,
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

/** Today's busy events, and its all-day events, from every calendar that's switched on. */
export async function fetchTodayEvents(token: GoogleToken, day: Date): Promise<{ events: CalendarEvent[]; allDay: AllDayEvent[] }> {
  const { start, end } = dayBounds(day);
  const items = await fetchItems(token, start, end);
  return { events: parseEvents(items, start, end), allDay: parseAllDay(items, keyOf(day)) };
}

/**
 * Busy events between two ISO times, from every calendar that's switched on.
 * Used for today and for the days you open on the calendar.
 */
export async function fetchEvents(token: GoogleToken, start: string, end: string): Promise<CalendarEvent[]> {
  return parseEvents(await fetchItems(token, start, end), start, end);
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
      return 'Google sign-in was closed before it finished. Try again when you are ready.';
    case 'denied':
      return 'Segue needs permission to see your calendar events. Try again and allow access.';
    case 'expired':
      return 'Your Google sign-in has expired. Tap Sync now to sign in again.';
    case 'unavailable':
      return "Couldn't open Google sign-in. Allow pop-ups for this site, then try again.";
    case 'busy':
      return 'Google Calendar is busy right now. Try again in a minute.';
    default:
      return "Couldn't reach Google Calendar. Check your connection and try again.";
  }
}
