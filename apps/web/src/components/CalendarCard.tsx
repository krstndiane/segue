import { useEffect } from 'react';
import type { CalendarState } from '../lib/calendar';
import { clock } from '../lib/format';
import { GOOGLE_CLIENT_ID, preloadGoogle } from '../lib/googleCalendar';
import { CalendarConnection, type ConnectionProps } from './CalendarConnection';

interface Props {
  calendar: CalendarState;
  today: string;
  connection: ConnectionProps;
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="15" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** Google Calendar during onboarding: the same one connection control as the Calendar page, plus today's events once they're in. */
export function CalendarCard({ calendar, today, connection }: Props) {
  // Load Google's sign-in script early so the popup opens straight from the tap.
  useEffect(() => {
    if (GOOGLE_CLIENT_ID) preloadGoogle().catch(() => {});
  }, []);

  if (!GOOGLE_CLIENT_ID) {
    // Only developers can fix a missing client id, so only they see this.
    if (!import.meta.env?.DEV) return null;
    return (
      <section className="calendar-card" aria-label="Google Calendar">
        <p className="calendar-head">
          <CalendarIcon />
          <strong>Google Calendar</strong>
        </p>
        <p className="muted small">
          To turn this on, add <code>VITE_GOOGLE_CLIENT_ID</code> to <code>apps/web/.env</code>. The README explains how to get one.
        </p>
      </section>
    );
  }

  const events = calendar.connected && calendar.date === today ? calendar.events : [];
  return (
    <section className="calendar-card" aria-label="Google Calendar">
      <p className="calendar-head">
        <CalendarIcon />
        <strong>Google Calendar</strong>
      </p>
      {!calendar.connected && (
        <p className="muted small">Bring in today's meetings and classes. Segue plans around them and never changes your calendar.</p>
      )}
      <CalendarConnection {...connection} compact />
      {events.length > 0 && (
        <ul className="calendar-events">
          {events.map((e) => (
            <li key={e.id}>
              <span className="stave-time">{clock(e.start)}</span>
              <span className="stave-body">
                <span className="stave-title">{e.title}</span>
                <span className="stave-sub">
                  Until {clock(e.end)}
                  {e.location && ` · ${e.location}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
