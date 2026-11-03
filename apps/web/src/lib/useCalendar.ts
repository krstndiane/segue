import { useEffect, useRef, useState } from 'react';
import { EMPTY_CALENDAR, calendarBlocks, type CalendarState } from './calendar';
import { EMPTY_DAYS, addDays, mergeDays, rangeBounds, type CalendarDays } from './days';
import { clock } from './format';
import {
  CalendarError,
  calendarErrorMessage,
  currentToken,
  fetchEvents,
  fetchTodayEvents,
  forgetToken,
  requestCode,
  requestToken,
  revokeToken,
  tokenSource,
  tokenValid,
  type EventSource,
} from './googleCalendar';
import { usePersisted } from './hooks';
import { localDate } from './model';
import { ApiError, connectGoogleLink, disconnectGoogleLink, getGoogleLink, googleLinkEvents, type GoogleLink } from './social';

/** Older than this, a re-route mentions when the calendar was last synced. */
const CALENDAR_STALE_MS = 3 * 60 * 60_000;
/** The same days aren't fetched again sooner than this, unless you tap Sync. */
const RANGE_FRESH_MS = 5 * 60_000;
/** Today's events are refreshed on their own this often while the app is open. */
export const CALENDAR_REFRESH_MS = 15 * 60_000;

/**
 * How Google Calendar is connected on this device:
 * - `server`: Segue's server keeps the connection (signed in, and the server
 *   is set up for it). Never asks Google again unless access was revoked.
 * - `browser`: this page's own Google token, about an hour, in memory only
 *   (no Segue account, or a server that can't keep connections yet).
 * - `checking`: asking the server which one applies.
 */
export type CalendarMode = 'server' | 'browser' | 'checking';

/** Server errors in plain words, as CalendarErrors the rest of the app understands. */
function fromApi(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  if (e.code === 'google_reconnect' || e.code === 'google_not_connected') return new CalendarError('reconnect');
  if (e.code === 'google_other_account') return new CalendarError('other-account', e.message);
  if (e.code === 'google_busy') return new CalendarError('busy');
  if (e.code === 'google_scope_missing' || e.code === 'google_code_invalid' || e.code === 'google_no_offline' || e.code === 'google_denied')
    return new CalendarError('denied');
  return new CalendarError('network');
}

const serverSource: EventSource = async (start, end) => {
  try {
    return (await googleLinkEvents(start, end)).items;
  } catch (e) {
    throw fromApi(e);
  }
};

/** Google Calendar: connect, sync, disconnect, blocks for a re-route, and events for the days you open. */
export function useCalendar(ready: boolean, notify: (message: string) => void, { signedIn = false }: { signedIn?: boolean } = {}) {
  const [calendar, setCalendar] = usePersisted<CalendarState>('calendar', EMPTY_CALENDAR, ready);
  const [days, setDays] = usePersisted<CalendarDays>('calendarDays', EMPTY_DAYS, ready);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rangeBusy, setRangeBusy] = useState(false);
  const [rangeError, setRangeError] = useState<string | null>(null);
  /** Browser mode only: today's events are due a refresh but Google needs a tap (its token lives in memory). */
  const [needsTap, setNeedsTap] = useState(false);
  /** What the server says about the connection. null: not asked (signed out) or not known yet. */
  const [link, setLink] = useState<GoogleLink | null>(null);
  const [linkChecked, setLinkChecked] = useState(!signedIn);
  /** A connect was refused because a different Google account is connected: who's connected, who was offered. */
  const [otherAccount, setOtherAccount] = useState<{ connected: string; offered: string } | null>(null);
  const lastRange = useRef<{ key: string; at: number } | null>(null);
  const refreshing = useRef(false);

  const mode: CalendarMode = signedIn ? (!linkChecked ? 'checking' : link?.available ? 'server' : 'browser') : 'browser';
  /** Connected as far as the planner is concerned: the server says so, or this device's browser connection. */
  const serverConnected = mode === 'server' && link?.status === 'connected';
  const needsAttention = mode === 'server' && link?.status === 'needs_attention';

  // Ask the server once per sign-in (and when the app comes back after a while; see refresh below).
  useEffect(() => {
    if (!signedIn) {
      setLink(null);
      setLinkChecked(true);
      return;
    }
    let live = true;
    setLinkChecked(false);
    getGoogleLink()
      .then((l) => live && setLink(l))
      .catch(() => live && setLink(null)) // offline or asleep: fall back to what this device has
      .finally(() => live && setLinkChecked(true));
    return () => {
      live = false;
    };
  }, [signedIn]);

  // The server is the source of truth: keep this device's "connected" in step with it.
  useEffect(() => {
    if (mode !== 'server' || !link) return;
    if (link.status === 'disconnected' && calendar.connected && !tokenValid(currentToken())) {
      // Disconnected on another device, or never connected through the server: show it as not connected.
      setCalendar(EMPTY_CALENDAR);
      setDays(EMPTY_DAYS);
    } else if (link.status !== 'disconnected' && !calendar.connected) {
      setCalendar((c) => ({ ...c, connected: true }));
    }
  }, [mode, link?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Where events come from right now, or null when a tap is needed first (browser mode without a live token). */
  function source(): EventSource | null {
    if (mode === 'server' && link?.status === 'connected') return serverSource;
    const t = currentToken();
    return tokenValid(t) ? tokenSource(t) : null;
  }

  function afterFailure(e: unknown) {
    if (e instanceof CalendarError && e.kind === 'expired') forgetToken();
    if (e instanceof CalendarError && e.kind === 'reconnect' && link) setLink({ ...link, status: 'needs_attention' });
  }

  async function saveToday(from: EventSource, now: Date) {
    const { events, allDay } = await fetchTodayEvents(from, now);
    const syncedAt = new Date().toISOString();
    setCalendar({ connected: true, date: localDate(now), events, allDay, syncedAt });
    setDays((d) => mergeDays(d, localDate(now), addDays(localDate(now), 1), events, syncedAt));
    if (mode === 'server' && link) setLink({ ...link, status: 'connected', lastSyncedAt: syncedAt });
    return events;
  }

  /**
   * Connect Google Calendar. Runs from a tap: Google's popup opens before the
   * first await. With the server, this happens once; it then stays connected.
   * `replace` switches to a different Google account on purpose.
   */
  async function connect({ replace = false }: { replace?: boolean } = {}) {
    setBusy(true);
    setError(null);
    setOtherAccount(null);
    try {
      if (mode !== 'server') return await sync('consent');
      const code = await requestCode();
      let next: GoogleLink;
      try {
        next = await connectGoogleLink(code, replace);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'google_other_account') {
          const d = (e.details ?? {}) as { connected?: string; offered?: string };
          setOtherAccount({ connected: d.connected ?? '', offered: d.offered ?? '' });
        }
        throw fromApi(e);
      }
      setLink(next);
      const events = await saveToday(serverSource, new Date());
      const count = events.length === 1 ? '1 event' : `${events.length} events`;
      notify(`Google Calendar connected${next.email ? ` (${next.email})` : ''}: ${count} today. It stays connected.`);
      return true;
    } catch (e) {
      afterFailure(e);
      setError(calendarErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Fetch today's events. With the server, never opens anything. In browser
   * mode, a new Google token may be needed, and the popup opens before the first await.
   */
  async function sync(prompt: '' | 'consent' = '') {
    setBusy(true);
    setError(null);
    try {
      let from = prompt === 'consent' && mode !== 'server' ? null : source();
      if (!from) {
        if (mode === 'server') throw new CalendarError('reconnect');
        from = tokenSource(await requestToken(prompt));
      }
      const wasConnected = calendar.connected;
      const events = await saveToday(from, new Date());
      setNeedsTap(false);
      const count = events.length === 1 ? '1 event' : `${events.length} events`;
      notify(!wasConnected ? `Google Calendar connected: ${count} today.` : `Calendar synced: ${count} today.`);
      return true;
    } catch (e) {
      afterFailure(e);
      setError(calendarErrorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Events for the days on screen, [from, to). In browser mode without a live
   * token it only fetches when `interactive` (a tap), since that may open Google's window.
   */
  async function loadRange(from: string, toExclusive: string, { interactive = false } = {}) {
    if (!calendar.connected && !serverConnected) return;
    const key = `${from}|${toExclusive}`;
    let src = source();
    if (!interactive) {
      if (!src) return;
      if (lastRange.current?.key === key && Date.now() - lastRange.current.at < RANGE_FRESH_MS) return;
    }
    setRangeBusy(true);
    setRangeError(null);
    try {
      if (!src) {
        if (mode === 'server') throw new CalendarError('reconnect');
        src = tokenSource(await requestToken(''));
      }
      const { start, end } = rangeBounds(from, toExclusive);
      const events = await fetchEvents(src, start, end);
      const at = new Date().toISOString();
      setDays((d) => mergeDays(d, from, toExclusive, events, at));
      lastRange.current = { key, at: Date.now() };
    } catch (e) {
      afterFailure(e);
      setRangeError(calendarErrorMessage(e));
    } finally {
      setRangeBusy(false);
    }
  }

  /**
   * Refresh today's events without opening anything: on opening the app,
   * coming back to it, and every 15 minutes. With the server it just works;
   * in browser mode without a live token it flags that a tap is needed.
   */
  async function refresh(force = false) {
    if ((!calendar.connected && !serverConnected) || refreshing.current || needsAttention) return;
    const now = new Date();
    const due = force || calendar.date !== localDate(now) || !calendar.syncedAt || now.getTime() - Date.parse(calendar.syncedAt) > CALENDAR_REFRESH_MS;
    if (!due) return;
    const src = source();
    if (!src) {
      if (mode === 'browser') setNeedsTap(true);
      return;
    }
    refreshing.current = true;
    try {
      await saveToday(src, now);
      setNeedsTap(false);
      setError(null);
    } catch (e) {
      // Keep the last events; say what went wrong.
      afterFailure(e);
      if (e instanceof CalendarError && e.kind === 'expired') setNeedsTap(true);
      else setError(calendarErrorMessage(e));
    } finally {
      refreshing.current = false;
    }
  }

  // On opening, on coming back to the app, and every 15 minutes while it's open.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const connected = calendar.connected || serverConnected;
  useEffect(() => {
    if (!ready || !connected || mode === 'checking') return;
    void refreshRef.current();
    const onVisible = () => document.visibilityState === 'visible' && void refreshRef.current();
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => document.visibilityState === 'visible' && void refreshRef.current(), CALENDAR_REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [ready, connected, mode]);

  async function disconnect() {
    setBusy(true);
    try {
      if (mode === 'server' && link && link.status !== 'disconnected') {
        try {
          setLink(await disconnectGoogleLink());
        } catch (e) {
          setError(calendarErrorMessage(fromApi(e)));
          return;
        }
      }
      revokeToken(currentToken());
      setCalendar(EMPTY_CALENDAR);
      setDays(EMPTY_DAYS);
      lastRange.current = null;
      setError(null);
      setRangeError(null);
      setNeedsTap(false);
      setOtherAccount(null);
      notify('Google Calendar disconnected. Re-route to take its events out of your plan.');
    } finally {
      setBusy(false);
    }
  }

  /** Calendar blocks for a re-route, refreshed first when that's possible without a tap. */
  async function forReroute(start: Date, room: number) {
    let cal = calendar;
    if (!cal.connected && !serverConnected) return { extra: [], warnings: [] as string[] };
    const src = source();
    if (src) {
      try {
        const { events, allDay } = await fetchTodayEvents(src, start);
        cal = { connected: true, date: localDate(start), events, allDay, syncedAt: start.toISOString() };
        setCalendar(cal);
        const today = localDate(start);
        setDays((d) => mergeDays(d, today, addDays(today, 1), events, start.toISOString()));
      } catch (e) {
        afterFailure(e);
        // keep what was saved; the warnings below say how old it is
      }
    }
    const warnings: string[] = [];
    if (cal.date !== localDate(start)) {
      warnings.push(
        needsAttention
          ? 'Your Google Calendar connection needs attention, so its events aren’t in this plan. Reconnect it on the Google Calendar page.'
          : "Calendar hasn't synced today, so its events aren't in this plan. Sync it on the Google Calendar page.",
      );
      return { extra: [], warnings };
    }
    if (cal.syncedAt && start.getTime() - Date.parse(cal.syncedAt) > CALENDAR_STALE_MS) {
      warnings.push(`Calendar events are from ${clock(cal.syncedAt)}. Sync on the Google Calendar page if anything changed.`);
    }
    if (cal.events.length > room) {
      warnings.push(`Only ${room} of today's ${cal.events.length} calendar events fit in one plan.`);
    }
    return { extra: calendarBlocks(cal.events, room), warnings };
  }

  return {
    calendar: connected && !calendar.connected ? { ...calendar, connected: true } : calendar,
    setCalendar,
    days,
    setDays,
    busy,
    error,
    needsTap: mode === 'browser' && needsTap,
    mode,
    link,
    needsAttention,
    otherAccount,
    connect,
    sync,
    refresh,
    disconnect,
    forReroute,
    loadRange,
    rangeBusy,
    rangeError,
  };
}
