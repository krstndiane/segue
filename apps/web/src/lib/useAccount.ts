/**
 * The Segue account on this device: signed out, signed in without a profile
 * yet, or ready. Using Segue without an account keeps working exactly as
 * before; the account only adds sync and the social features.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MyProfile } from '@segue/schemas';
import { accountsEnabled, getSession, onSession, signOut as authSignOut, takeRedirect, type Session } from './auth';
import { ApiError, getMe } from './social';
import { getItem, setItem } from './store';

export type AccountState = 'off' | 'signed-out' | 'loading' | 'needs-profile' | 'ready' | 'offline';

/** The last profile seen, so the app knows who's signed in while offline. */
const PROFILE_KEY = 'accountProfile';

export function useAccount() {
  const [session, setSession] = useState<Session | null>(() => (accountsEnabled ? getSession() : null));
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [state, setState] = useState<AccountState>(() => (!accountsEnabled ? 'off' : getSession() ? 'loading' : 'signed-out'));
  /** What an emailed link just did: confirmed the email, or opened "set a new password". */
  const [arrival, setArrival] = useState<{ kind: 'signup' | 'recovery' | 'other'; error?: string } | null>(() => (accountsEnabled ? takeRedirect() : null));

  useEffect(() => (accountsEnabled ? onSession(setSession) : undefined), []);

  const load = useCallback(async () => {
    if (!getSession()) {
      setProfile(null);
      setState(accountsEnabled ? 'signed-out' : 'off');
      return;
    }
    setState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const me = await getMe();
      setProfile(me.profile);
      void setItem(PROFILE_KEY, me.profile ?? undefined);
      setState(me.profile ? 'ready' : 'needs-profile');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await authSignOut();
        return;
      }
      // Offline or the server is waking up: carry on with the profile we last saw.
      const cached = await getItem<MyProfile>(PROFILE_KEY);
      if (cached && cached.id === getSession()?.user.id) {
        setProfile(cached);
        setState('ready');
      } else setState('offline');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [session?.user.id, load]);

  async function signOut() {
    await authSignOut();
    setProfile(null);
    void setItem(PROFILE_KEY, undefined);
  }

  return {
    enabled: accountsEnabled,
    state,
    session,
    userId: state === 'ready' ? (profile?.id ?? null) : null,
    email: session?.user.email,
    profile,
    setProfile: (p: MyProfile) => {
      setProfile(p);
      void setItem(PROFILE_KEY, p);
      setState('ready');
    },
    reload: load,
    signOut,
    arrival,
    clearArrival: () => setArrival(null),
  };
}

export type Account = ReturnType<typeof useAccount>;
