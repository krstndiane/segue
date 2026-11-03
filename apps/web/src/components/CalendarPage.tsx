import { useEffect } from 'react';
import { calendarBlockId, type CalendarState } from '../lib/calendar';
import { clock, duration, minutesBetween } from '../lib/format';
import { GOOGLE_CLIENT_ID, preloadGoogle } from '../lib/googleCalendar';
import { CalendarConnection, type ConnectionProps } from './CalendarConnection';

interface Props {
  calendar: CalendarState;
  today: string;
  busy: boolean;
  excluded: Set<string>;
  connection: ConnectionProps;
  onToggleExclude: (blockId: string) => void;
  onBack: () => void;
  onPlan: () => void;
}

function CalendarGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <rect x="5" y="9" width="38" height="34" rx="8" fill="var(--surface)" stroke="currentColor" strokeWidth="3" />
      <path d="M5 19h38" stroke="currentColor" strokeWidth="3" />
      <path d="M15 5v8M33 5v8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <rect x="13" y="25" width="8" height="7" rx="2" fill="var(--brass)" />
      <rect x="25" y="25" width="8" height="7" rx="2" fill="currentColor" opacity=".25" />
      <rect x="13" y="34" width="8" height="4" rx="2" fill="currentColor" opacity=".25" />
    </svg>
  );
}

const promises = (server: boolean) => [
  { title: 'Reads, never writes', body: "Segue reads today's events, and the days you open on its calendar. It can't create, change or delete anything in your calendar." },
  { title: 'Plans around what makes you busy', body: 'Meetings and classes become fixed times. Events marked "free", ones you declined, cancelled ones and all-day events are left out.' },
  { title: 'Every calendar you have switched on', body: 'Work, personal and shared calendars all count. A meeting that is on two of them shows up once.' },
  server
    ? {
        title: 'Connected once, kept safe',
        body: "Segue's server keeps the read-only access Google gives it, encrypted, so you aren't asked to sign in again. Events pass through to your device and aren't stored on the server. Disconnecting removes the access, at Google too.",
      }
    : {
        title: 'Stays on your phone',
        body: "Google's sign-in happens in your browser and lasts about an hour. Segue's server never sees it. Events you've opened are kept on this phone so the calendar works offline; disconnecting removes them.",
      },
];

export function CalendarPage(props: Props) {
  const { calendar, today, busy, excluded, connection } = props;
  const events = calendar.date === today ? calendar.events : [];
  const PROMISES = promises(connection.mode === 'server');
  const attention = connection.mode === 'server' && connection.link?.status === 'needs_attention';

  // Load Google's sign-in early so the popup opens straight from the tap.
  useEffect(() => {
    if (GOOGLE_CLIENT_ID) preloadGoogle().catch(() => {});
  }, []);

  return (
    <div className="page calendar-page">
      <button type="button" className="back" onClick={props.onBack}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>

      <header className="page-head">
        <CalendarGlyph />
        <div>
          <h2 className="page-title">Google Calendar</h2>
          <p className="muted">Your meetings and classes become fixed times Segue plans around.</p>
        </div>
      </header>

      {!GOOGLE_CLIENT_ID ? (
        <section className="panel">
          <h3 className="panel-title">Not set up on this version of Segue</h3>
          <p className="muted">
            {import.meta.env?.DEV ? (
              <>
                Add <code>VITE_GOOGLE_CLIENT_ID</code> to <code>apps/web/.env</code> and restart the web app. The README explains how to get one.
              </>
            ) : (
              "Connecting Google Calendar isn't available here yet. You can still add meetings by typing them, like “Standup 9:30-10”."
            )}
          </p>
        </section>
      ) : !calendar.connected || attention ? (
        <>
          <CalendarConnection {...connection} />
          {!attention && (
            <ul className="promises">
              {PROMISES.map((p) => (
                <li key={p.title}>
                  <strong>{p.title}</strong>
                  <span className="muted">{p.body}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <CalendarConnection {...connection} />
          <section className="panel">
            <div className="panel-row">
              <h3 className="panel-title">Today</h3>
            </div>
            {calendar.date !== today ? (
              <p className="muted">{busy ? 'Bringing in today’s events…' : 'Today’s events aren’t in yet. Open Manage connection and tap Sync now.'}</p>
            ) : events.length === 0 ? (
              <p className="muted">Nothing on your calendar today. The whole day is yours to plan.</p>
            ) : (
              <ul className="event-list">
                {events.map((e) => {
                  const id = calendarBlockId(e.id);
                  const off = excluded.has(id);
                  return (
                    <li key={e.id} className={off ? 'off' : ''}>
                      <span className="event-time">
                        {clock(e.start)}
                        <span className="muted small">{duration(minutesBetween(e.start, e.end))}</span>
                      </span>
                      <span className="event-body">
                        <strong>{e.title}</strong>
                        {e.location && <span className="muted small">{e.location}</span>}
                        {off && <span className="small warn-text">Left out of today's plan</span>}
                      </span>
                      <label className="switch" title={off ? 'Plan around it' : 'Leave it out today'}>
                        <input type="checkbox" checked={!off} onChange={() => props.onToggleExclude(id)} />
                        <span className="visually-hidden">Plan around {e.title}</span>
                        <span className="track" aria-hidden="true" />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <button type="button" className="primary wide big" onClick={props.onPlan}>
            Plan my day around it
          </button>

          <section className="panel subtle">
            <h3 className="panel-title">How Segue uses it</h3>
            <ul className="plain-list">
              {PROMISES.map((p) => (
                <li key={p.title}>{p.body}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
