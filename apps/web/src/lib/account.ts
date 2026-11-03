/**
 * A Google profile saved on this device by earlier versions of Segue (which
 * offered "Sign up with Google" before Segue accounts existed). Still read so
 * the app can greet those people by name; nothing new is saved here. Signing
 * in is a Segue account now, and Google Calendar is connected separately.
 */
import type { GoogleProfile } from './googleCalendar';
import { getItem } from './store';

export interface Account extends GoogleProfile {
  provider: 'google';
  signedUpAt: string;
}

export const loadAccount = () => getItem<Account>('account');

/** "Dia" from "Dia Aviles". */
export const firstName = (a: Pick<Account, 'name'> | null | undefined) => a?.name.split(/\s+/)[0] ?? '';
