import { useState } from 'react';
import { useGoogleSignIn } from '../lib/googleSignIn';
import { ContinueWithGoogle } from './ContinueWithGoogle';
import { clock } from '../lib/format';
import type { CalendarMode } from '../lib/useCalendar';
import type { GoogleLink } from '../lib/social';

export { GoogleMark } from './GoogleMark';
import { GoogleMark } from './GoogleMark';

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
  const google = useGoogleSignIn();
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
  if (p.signedOut && google.available) {
    // One Google step makes the account, signs in and connects the calendar.
    return (
      <section className="gc-status" aria-label="Google Calendar">
        <ContinueWithGoogle />
        <button type="button" className="text-button" onClick={p.onSignIn}>
          Have a Segue account with email? Sign in
        </button>
      </section>
    );
  }
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
