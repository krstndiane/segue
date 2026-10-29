/**
 * Google Calendar → Segue, with Google's API answers mocked (shaped like real
 * Calendar API v3 responses). This is automated coverage only: it does not
 * show a real Google account syncing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { reroute } from '@segue/engine';
import { calendarBlockId, calendarBlocks, calendarDiff, dayBounds, parseAllDay } from '../src/lib/calendar';
import { CalendarError, calendarErrorMessage, fetchTodayEvents, type GoogleToken } from '../src/lib/googleCalendar';

const token: GoogleToken = { value: 'test-token', expiresAt: Date.now() + 3_600_000 };
const DAY = new Date(2026, 9, 30, 12); // Friday 30 Oct, local noon
const at = (h: number, m = 0, d = 30) => new Date(2026, 9, d, h, m).toISOString();
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Handler = (url: URL) => { status?: number; body: unknown };
function google(handler: Handler) {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(url);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test-token');
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return asked;
}
const list = (items: { id: string; primary?: boolean; selected?: boolean }[]) => ({ items });
const timed = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra });

describe('today from Google Calendar', () => {
  it('a connected user with events today: timed events, all-day events, in time order', async () => {
    google((u) =>
      u.pathname.endsWith('/calendarList')
        ? { body: list([{ id: 'me@example.com', primary: true }]) }
        : {
            body: {
              items: [
                timed('Standup', at(9, 30), at(9, 45)),
                timed('Client call', at(15), at(16)),
                { id: 'holiday', summary: 'All Saints’ Day (eve)', start: { date: '2026-10-30' }, end: { date: '2026-10-31' }, transparency: 'transparent' },
              ],
            },
          },
    );
    const { events, allDay } = await fetchTodayEvents(token, DAY);
    expect(events.map((e) => e.title)).toEqual(['Standup', 'Client call']);
    expect(allDay).toEqual([{ id: 'holiday', title: 'All Saints’ Day (eve)' }]);
  });

  it('asks Google for the local day, with recurring events expanded', async () => {
    const asked = google((u) => (u.pathname.endsWith('/calendarList') ? { body: list([{ id: 'primary-id', primary: true }]) } : { body: { items: [] } }));
    await fetchTodayEvents(token, DAY);
    const q = asked.find((u) => u.pathname.includes('/events'))!.searchParams;
    expect(q.get('timeMin')).toBe(new Date(2026, 9, 30).toISOString());
    expect(q.get('timeMax')).toBe(new Date(2026, 9, 31).toISOString());
    expect(q.get('singleEvents')).toBe('true');
  });

  it('a day is local midnight to midnight, even on a daylight-saving change (23 or 25 hours)', () => {
    const { start, end } = dayBounds(new Date(2026, 10, 1, 12)); // 1 Nov 2026: clocks go back in the US
    expect([new Date(start).getHours(), new Date(start).getDate(), new Date(end).getHours(), new Date(end).getDate()]).toEqual([0, 1, 0, 2]);
  });

  it('an empty calendar is an empty day, not an error', async () => {
    google((u) => (u.pathname.endsWith('/calendarList') ? { body: list([{ id: 'p', primary: true }]) } : { body: {} }));
    expect(await fetchTodayEvents(token, DAY)).toEqual({ events: [], allDay: [] });
  });

  it('events written in another time zone land at the right local time', async () => {
    // 1:00 PM in Tokyo (+09:00) is noon in Manila and 04:00 UTC: one instant, whatever the zone.
    google((u) => (u.pathname.endsWith('/calendarList') ? { body: list([{ id: 'p', primary: true }]) } : { body: { items: [timed('Call Tokyo', '2026-10-30T13:00:00+09:00', '2026-10-30T13:30:00+09:00')] } }));
    const instant = Date.UTC(2026, 9, 30, 4);
    const { events } = await fetchTodayEvents(token, new Date(instant));
    expect(events).toEqual([{ id: 'Call Tokyo', title: 'Call Tokyo', start: new Date(instant).toISOString(), end: new Date(instant + 30 * 60_000).toISOString() }]);
  });

  it('an overnight event counts only for the part inside today', async () => {
    google((u) => (u.pathname.endsWith('/calendarList') ? { body: list([{ id: 'p', primary: true }]) } : { body: { items: [timed('Night shift', at(22), at(6, 0, 31)), timed('Red-eye arrival', at(23, 0, 29), at(2))] } }));
    const { events } = await fetchTodayEvents(token, DAY);
    expect(events.map((e) => [e.title, e.start, e.end])).toEqual([
      ['Red-eye arrival', new Date(2026, 9, 30).toISOString(), at(2)],
      ['Night shift', at(22), new Date(2026, 9, 31).toISOString()],
    ]);
  });

  it('reads every page, and lists a meeting on two calendars once', async () => {
    const asked = google((u) => {
      if (u.pathname.endsWith('/calendarList')) return { body: list([{ id: 'me', primary: true }, { id: 'team@group' }]) };
      if (u.pathname.includes('team%40group') || u.pathname.includes('team@group')) return { body: { items: [timed('Planning', at(11), at(12), { iCalUID: 'plan-1' })] } };
      return u.searchParams.get('pageToken') === 'p2'
        ? { body: { items: [timed('Planning', at(11), at(12), { iCalUID: 'plan-1', id: 'Planning-copy' }), timed('Late review', at(18), at(19))] } }
        : { body: { items: [timed('Standup', at(9), at(9, 15))], nextPageToken: 'p2' } };
    });
    const { events } = await fetchTodayEvents(token, DAY);
    expect(events.map((e) => e.title)).toEqual(['Standup', 'Planning', 'Late review']);
    expect(asked.filter((u) => u.searchParams.get('pageToken') === 'p2')).toHaveLength(1);
  });

  it('skips cancelled, "free" and declined events, and recurring instances come through like any event', async () => {
    google((u) =>
      u.pathname.endsWith('/calendarList')
        ? { body: list([{ id: 'p', primary: true }]) }
        : {
            body: {
              items: [
                timed('Gym class', at(7), at(8), { recurringEventId: 'gym-weekly' }),
                timed('Moved away', at(10), at(11), { status: 'cancelled' }),
                timed('Focus (free)', at(13), at(14), { transparency: 'transparent' }),
                timed('Declined', at(16), at(17), { attendees: [{ self: true, responseStatus: 'declined' }] }),
              ],
            },
          },
    );
    expect((await fetchTodayEvents(token, DAY)).events.map((e) => e.title)).toEqual(['Gym class']);
  });
});

describe('when Google says no', () => {
  const failWith = (status: number, body: unknown = {}) => google((u) => (u.pathname.endsWith('/calendarList') ? { body: list([{ id: 'p', primary: true }]) } : { status, body }));
  const kind = async () => fetchTodayEvents(token, DAY).then(() => 'ok', (e: unknown) => (e instanceof CalendarError ? e.kind : 'other'));

  it('an expired sign-in asks to sign in again', async () => {
    failWith(401);
    expect(await kind()).toBe('expired');
    expect(calendarErrorMessage(new CalendarError('expired'))).toMatch(/expired/);
  });

  it('revoked access asks for permission again', async () => {
    failWith(403, { error: { errors: [{ reason: 'forbidden' }] } });
    expect(await kind()).toBe('denied');
  });

  it('rate limits say "busy, try again", not "no permission"', async () => {
    failWith(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } });
    expect(await kind()).toBe('busy');
    failWith(429);
    expect(await kind()).toBe('busy');
    expect(calendarErrorMessage(new CalendarError('busy'))).toBe('Google Calendar is busy right now. Try again in a minute.');
  });

  it('Google being down is a network error, never an empty day', async () => {
    failWith(503);
    expect(await kind()).toBe('network');
  });

  it('a shared calendar that fails is skipped; the main one still counts', async () => {
    google((u) => {
      if (u.pathname.endsWith('/calendarList')) return { body: list([{ id: 'me', primary: true }, { id: 'broken' }]) };
      if (u.pathname.includes('broken')) return { status: 404, body: {} };
      return { body: { items: [timed('Standup', at(9), at(9, 15))] } };
    });
    expect((await fetchTodayEvents(token, DAY)).events.map((e) => e.title)).toEqual(['Standup']);
  });
});

describe('the calendar and the plan stay consistent', () => {
  const ev = (id: string, s: string, e: string) => ({ id, title: id, start: s, end: e });
  const planFrom = (events: ReturnType<typeof ev>[]) =>
    reroute({
      blocks: [...calendarBlocks(events, 20), { id: 'read', title: 'Read', minMinutes: 60, maxMinutes: 60, priority: 'should', category: 'none', requirements: [] }],
      candidates: {},
      context: { now: at(8), endOfDay: at(22), location: { lat: 14.55, lng: 121.02 }, energy: 'medium', mode: 'local', utcOffsetMinutes: -DAY.getTimezoneOffset() },
    }).plan;

  it('syncing the same calendar again changes nothing', () => {
    const events = [ev('Standup', at(9), at(9, 30)), ev('Call', at(15), at(16))];
    const plan = planFrom(events);
    expect(calendarDiff(events, plan)).toEqual({ missing: [], changed: [], gone: [] });
    expect(calendarDiff([...events], plan)).toEqual({ missing: [], changed: [], gone: [] });
  });

  it('says what was added, moved or deleted in Google Calendar since the plan was made', () => {
    const plan = planFrom([ev('Standup', at(9), at(9, 30)), ev('Call', at(15), at(16)), ev('Dentist', at(17), at(18))]);
    const now = [ev('Standup', at(9), at(9, 30)), ev('Call', at(16), at(17)), ev('Lunch with Ana', at(12), at(13))];
    const d = calendarDiff(now, plan);
    expect(d.missing.map((e) => e.title)).toEqual(['Lunch with Ana']);
    expect(d.changed.map((e) => e.title)).toEqual(['Call']);
    expect(d.gone).toEqual([{ blockId: calendarBlockId('Dentist'), title: 'Dentist' }]);
  });

  it("doesn't nag about events you chose to leave out", () => {
    const plan = planFrom([ev('Standup', at(9), at(9, 30))]);
    expect(calendarDiff([ev('Standup', at(9), at(9, 30)), ev('Optional', at(11), at(12))], plan, [calendarBlockId('Optional')]).missing).toEqual([]);
  });

  it('calendar events are set times: the plan works around them and never moves them', () => {
    const events = [ev('Class', at(13), at(15))];
    const plan = planFrom(events);
    const cls = plan.items.find((i) => i.blockId === calendarBlockId('Class'))!;
    expect([cls.start, cls.end, cls.fixed]).toEqual([at(13), at(15), true]);
    const read = plan.items.find((i) => i.blockId === 'read')!;
    expect(Date.parse(read.end) <= Date.parse(at(13)) || Date.parse(read.start) >= Date.parse(at(15))).toBe(true);
  });

  it('all-day events cover the right days and never block time', () => {
    const trip = { id: 'trip', summary: 'Baguio trip', start: { date: '2026-10-29' }, end: { date: '2026-11-01' } };
    expect(parseAllDay([trip], '2026-10-30')).toEqual([{ id: 'trip', title: 'Baguio trip' }]);
    expect(parseAllDay([trip], '2026-11-01')).toEqual([]);
    expect(calendarBlocks([], 10)).toEqual([]);
  });
});
