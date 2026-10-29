/**
 * Signing up with Google: one tap signs you in and connects Google Calendar.
 * Segue has no server accounts yet, so the profile (name, email, photo) and
 * today's events are saved on this device; the Google token stays in memory.
 */
import type { CalendarState } from './calendar';
import { fetchProfile, fetchTodayEvents, requestToken, type GoogleProfile } from './googleCalendar';
import { localDate } from './model';
import { getItem, setItem } from './store';

export interface Account extends GoogleProfile {
  provider: 'google';
  signedUpAt: string;
}

export const loadAccount = () => getItem<Account>('account');

/**
 * Call straight from a tap: Google's popup opens before the first await.
 * Resolves with who signed in and today's calendar, both already saved.
 */
export async function signUpWithGoogle(): Promise<{ account: Account | null; calendar: CalendarState }> {
  const token = await requestToken('consent', { profile: true });
  const [profile, today] = await Promise.all([fetchProfile(token).catch(() => null), fetchTodayEvents(token, new Date())]);
  const now = new Date().toISOString();
  const account: Account | null = profile ? { ...profile, provider: 'google', signedUpAt: now } : null;
  const calendar: CalendarState = { connected: true, date: localDate(), events: today.events, allDay: today.allDay, syncedAt: now };
  await Promise.all([account ? setItem('account', account) : Promise.resolve(), setItem('calendar', calendar)]);
  return { account, calendar };
}

export async function forgetAccount() {
  await setItem('account', undefined);
}

/** "Dia" from "Dia Aviles". */
export const firstName = (a: Pick<Account, 'name'> | null | undefined) => a?.name.split(/\s+/)[0] ?? '';
