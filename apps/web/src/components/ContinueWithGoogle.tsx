import { useEffect } from 'react';
import { GOOGLE_CLIENT_ID, preloadGoogle } from '../lib/googleCalendar';
import { useGoogleSignIn } from '../lib/googleSignIn';
import { GoogleMark } from './GoogleMark';

/**
 * The one Google entry point, for people who aren't signed in. One consent
 * signs them in to Segue (creating the account the first time) and connects
 * Google Calendar. Shows nothing when this server can't do it.
 */
export function ContinueWithGoogle({ onDone, explain = true, className = '' }: { onDone?: () => void; explain?: boolean; className?: string }) {
  const g = useGoogleSignIn();
  // Load Google's script early so the popup opens straight from the tap.
  useEffect(() => {
    if (g.available && GOOGLE_CLIENT_ID) preloadGoogle().catch(() => {});
  }, [g.available]);
  if (!g.available) return null;
  return (
    <div className={`cwg ${className}`}>
      <button type="button" className="google-button" disabled={g.busy} onClick={() => void g.start().then((ok) => ok && onDone?.())}>
        <GoogleMark size={20} />
        <span>{g.busy ? 'Waiting for Google…' : 'Continue with Google'}</span>
      </button>
      {explain && (
        <p className="muted small">One step: this signs you in to Segue (or creates your account) and connects your Google Calendar, read-only.</p>
      )}
      {g.error && (
        <p className="error small" role="alert">
          {g.error}
        </p>
      )}
    </div>
  );
}
