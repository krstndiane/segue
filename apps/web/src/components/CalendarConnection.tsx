import { useState } from 'react';
import { clock } from '../lib/format';
import type { CalendarMode } from '../lib/useCalendar';
import type { GoogleLink } from '../lib/social';

/** Google's "G", in its four colours. */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** "today at 3:05 PM", "yesterday at 9:00 AM", "Nov 2 at 8:15 AM". */
export function syncedWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const on = day(d) === day(now) ? 'today' : day(d) === day(y) ? 'yesterday' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${on} at ${clock(iso)}`;
}

export interface ConnectionProps {
  mode: CalendarMode;
  link: GoogleLink | null;
  /** This device has events from Google Calendar (browser mode, or the server's). */
  connected: boolean;
  /** When this device last brought events in (browser mode has nothing better). */
  deviceSyncedAt?: string;
  busy: boolean;
  error: string | null;
  otherAccount: { connected: string; offered: string } | null;
  /** Accounts exist on this build and nobody is signed in. */
  signedOut: boolean;
  onConnect: () => void;
  onSwitch: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  onSignIn: () => void;
  /** Smaller, for onboarding. */
  compact?: boolean;
}

/**
 * Google Calendar's one connection control. Exactly one action for each case:
 * - signed out of Segue: sign in (so it can stay connected), or connect for this visit
 * - signed in, never connected: Connect Google Calendar
 * - connected: the account, "Last synced", and Manage connection
 * - needs attention: Reconnect Google Calendar
 */
export function CalendarConnection(p: ConnectionProps) {
  const [managing, setManaging] = useState(false);
  const status = p.mode === 'server' ? (p.link?.status ?? 'disconnected') : p.connected ? 'connected' : 'disconnected';
  const lastSynced = p.mode === 'server' ? p.link?.lastSyncedAt : p.deviceSyncedAt;

  if (p.mode === 'checking') {
    return (
      <section className="gc-status" aria-label="Google Calendar" aria-busy="true">
        <p className="gc-line">
          <GoogleMark />
          <span>Checking your Google Calendar connection…</span>
        </p>
      </section>
    );
  }

  if (status === 'needs_attention') {
    return (
      <section className="gc-status gc-attention" aria-label="Google Calendar">
        <p className="gc-line">
          <GoogleMark />
          <strong>Your Google Calendar connection needs attention.</strong>
        </p>
        <p className="muted small">
          Google stopped letting Segue read {p.link?.email ? <strong>{p.link.email}</strong> : 'your calendar'}. This happens when access is removed in your Google
          account or hasn’t been used for a long time. Your plans are fine; calendar events are paused until you reconnect.
        </p>
        <button type="button" className="primary" onClick={p.onConnect} disabled={p.busy}>
          {p.busy ? 'Waiting for Google…' : 'Reconnect Google Calendar'}
        </button>
        <Problem {...p} />
      </section>
    );
  }

  if (status === 'connected') {
    return (
      <section className="gc-status gc-connected" aria-label="Google Calendar">
        <div className="gc-row">
          <p className="gc-line">
            <GoogleMark />
            <span>
              <strong>Connected</strong>
              {p.link?.email && <span className="muted small block">{p.link.email}</span>}
            </span>
          </p>
          <button type="button" className="ghost small-button" aria-expanded={managing} onClick={() => setManaging((m) => !m)}>
            Manage connection
          </button>
        </div>
        <p className="muted small">
          {lastSynced ? `Last synced ${syncedWhen(lastSynced)}` : 'Not synced yet'}
          {p.mode === 'browser' && ' · This visit only: Google asks again after about an hour.'}
        </p>
        {managing && (
          <div className="gc-manage">
            <button type="button" className="ghost" onClick={p.onSync} disabled={p.busy}>
              {p.busy ? 'Syncing…' : 'Sync now'}
            </button>
            {p.mode === 'server' && (
              <button type="button" className="text-button" onClick={p.onSwitch} disabled={p.busy}>
                Use a different Google account
              </button>
            )}
            <button type="button" className="text-button danger-text" onClick={p.onDisconnect} disabled={p.busy}>
              Disconnect Google Calendar
            </button>
          </div>
        )}
        <Problem {...p} />
      </section>
    );
  }

  // Not connected.
  if (p.signedOut) {
    return (
      <section className="gc-status" aria-label="Google Calendar">
        {!p.compact && (
          <p className="muted small">
            Sign in to Segue first and Google Calendar stays connected: on this device, after you close the browser, and on your other devices.
          </p>
        )}
        <button type="button" className="primary" onClick={p.onSignIn}>
          Sign in to Segue
        </button>
        <button type="button" className="text-button" onClick={p.onConnect} disabled={p.busy}>
          {p.busy ? 'Waiting for Google…' : 'Or connect for this visit only'}
        </button>
        <Problem {...p} />
      </section>
    );
  }

  return (
    <section className="gc-status" aria-label="Google Calendar">
      <button type="button" className="primary" onClick={p.onConnect} disabled={p.busy}>
        {p.busy ? 'Waiting for Google…' : 'Connect Google Calendar'}
      </button>
      <p className="muted small">
        {p.mode === 'server'
          ? 'Google asks you to choose an account and allow read-only access, once. After that it stays connected until you disconnect.'
          : 'Google asks you to choose an account and allow read-only access. On this version of Segue it lasts about an hour at a time.'}
      </p>
      <Problem {...p} />
    </section>
  );
}

function Problem(p: ConnectionProps) {
  if (p.otherAccount) {
    return (
      <div className="gc-problem" role="alert">
        <p>
          Segue is connected to <strong>{p.otherAccount.connected}</strong>, and you chose <strong>{p.otherAccount.offered}</strong>. Segue didn’t switch.
        </p>
        <button type="button" className="ghost" onClick={p.onSwitch} disabled={p.busy}>
          Switch to {p.otherAccount.offered}
        </button>
      </div>
    );
  }
  return p.error ? (
    <p className="error" role="alert">
      {p.error}
    </p>
  ) : null;
}
