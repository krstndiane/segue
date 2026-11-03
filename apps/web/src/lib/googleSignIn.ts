/**
 * Continue with Google: one Google consent that signs you in to Segue (or
 * creates your account), and connects Google Calendar. The browser only gets a
 * one-time code from Google's popup; Segue's server swaps it, gets the Segue
 * session from Supabase, makes the profile the first time and keeps the
 * calendar connection. Google's tokens never reach the browser.
 */
import { createContext, useContext } from 'react';
import { adoptSession, AuthFailure } from './auth';
import { CalendarError, GOOGLE_CLIENT_ID, requestCode } from './googleCalendar';
import { API_URL } from './reroute';
import type { GoogleLink } from './social';

export interface GoogleSignInResult {
  created: boolean;
  calendar: GoogleLink & { problem?: 'scope_denied' | 'other_account' | 'no_offline' };
  email?: string;
}

let features: Promise<{ googleSignIn: boolean; googleCalendar: boolean }> | null = null;

/** What this Segue server has switched on (from /health), asked once. */
export function serverFeatures(): Promise<{ googleSignIn: boolean; googleCalendar: boolean }> {
  features ??= fetch(`${API_URL}/health`)
    .then((r) => r.json())
    .then((h: { googleSignIn?: boolean; googleCalendar?: boolean }) => ({ googleSignIn: !!h.googleSignIn && !!GOOGLE_CLIENT_ID, googleCalendar: !!h.googleCalendar }))
    .catch(() => {
      features = null; // try again next time
      return { googleSignIn: false, googleCalendar: false };
    });
  return features;
}

/** Call straight from a tap: Google's popup opens before the first await. */
export async function continueWithGoogle(): Promise<GoogleSignInResult> {
  const code = await requestCode({ profile: true });
  let res: Response;
  try {
    res = await fetch(`${API_URL}/v1/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  } catch {
    throw new AuthFailure("Couldn't reach Segue. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; session?: Parameters<typeof adoptSession>[0]; created?: boolean; calendar?: GoogleSignInResult['calendar'] };
  if (!res.ok || !body.session) {
    throw new AuthFailure(res.status >= 500 && res.status !== 503 ? 'Something went wrong on our side. Try again in a moment.' : (body.error ?? 'That didn’t work. Try again.'));
  }
  const s = adoptSession(body.session);
  return { created: !!body.created, calendar: body.calendar!, email: s.user.email };
}

/** Plain words for a Google popup that didn't finish. */
export function signInErrorMessage(e: unknown): string {
  if (e instanceof AuthFailure) return e.message;
  if (e instanceof CalendarError && e.kind === 'cancelled') return "Google sign-in didn't finish. Try again when you're ready, or use email.";
  if (e instanceof CalendarError && e.kind === 'unavailable') return "Couldn't open Google sign-in. Allow pop-ups for this site, then try again.";
  return 'That didn’t work. Try again, or use email.';
}

/** Shared with every place that can sign you in: whether Continue with Google is on here, and how to start it. */
export interface GoogleSignInApi {
  available: boolean;
  busy: boolean;
  error: string | null;
  /** From a tap. Resolves true when signed in. */
  start: () => Promise<boolean>;
}
export const GoogleSignInContext = createContext<GoogleSignInApi>({ available: false, busy: false, error: null, start: async () => false });
export const useGoogleSignIn = () => useContext(GoogleSignInContext);
