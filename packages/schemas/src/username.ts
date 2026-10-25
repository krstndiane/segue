/**
 * Username rules, in one place for the API and the web app.
 *
 * Usernames are stored lowercase, so "Dia" and "dia" are the same name. The
 * submitted text is checked as typed (we never quietly change an invalid name
 * into a different valid one); only after it passes is it lowercased.
 *
 * Rules: 3 to 20 characters; English letters, numbers and underscores only;
 * starts with a letter; no leading, trailing or doubled underscores;
 * not on the reserved list.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;

export type UsernameReason = 'invalid_format' | 'too_short' | 'too_long' | 'reserved' | 'taken';

/** Names that could pass for Segue itself, official accounts, or pages of the app. Servers can add more (RESERVED_USERNAMES). */
export const RESERVED_USERNAMES: readonly string[] = [
  'admin', 'administrator', 'root', 'system', 'sysadmin', 'superuser', 'moderator', 'mod', 'staff',
  'support', 'help', 'helpdesk', 'official', 'team', 'security', 'abuse', 'contact', 'info', 'billing',
  'postmaster', 'webmaster', 'noreply', 'no_reply', 'segue', 'segue_team', 'segue_support', 'segue_app',
  'api', 'app', 'www', 'mail', 'null', 'undefined', 'none', 'anonymous', 'everyone', 'me', 'you',
  'login', 'logout', 'signin', 'signup', 'settings', 'account', 'privacy', 'terms',
  'together', 'notes', 'invitations', 'notifications', 'users', 'people', 'profile',
];

export interface UsernameProblem {
  reason: Exclude<UsernameReason, 'taken'>;
  /** Plain words for the person typing */
  message: string;
}

const CHARS = /^[A-Za-z0-9_]+$/;

/** What a name needs to be fixed, or null if its format is fine. Reserved names are checked separately. */
export function usernameFormatProblem(raw: string): UsernameProblem | null {
  const name = raw.trim();
  if (!CHARS.test(name) && name.length > 0) {
    return { reason: 'invalid_format', message: 'Only letters, numbers and underscores are allowed.' };
  }
  if (name.length < USERNAME_MIN) return { reason: 'too_short', message: `Username must have ${USERNAME_MIN} to ${USERNAME_MAX} characters.` };
  if (name.length > USERNAME_MAX) return { reason: 'too_long', message: `Username must have ${USERNAME_MIN} to ${USERNAME_MAX} characters.` };
  if (!/^[A-Za-z]/.test(name)) return { reason: 'invalid_format', message: 'Username must start with a letter.' };
  if (name.startsWith('_') || name.endsWith('_')) return { reason: 'invalid_format', message: "Username can't start or end with an underscore." };
  if (name.includes('__')) return { reason: 'invalid_format', message: "Consecutive underscores aren't allowed." };
  return null;
}

/** The one canonical form used for uniqueness, lookups and search. Call after the format passes. */
export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

export function isReservedUsername(raw: string, extra: readonly string[] = []): boolean {
  const name = normalizeUsername(raw);
  return RESERVED_USERNAMES.includes(name) || extra.some((x) => normalizeUsername(x) === name);
}

export type UsernameCheck = { ok: true; username: string } | { ok: false; reason: Exclude<UsernameReason, 'taken'>; message: string };

/** Format and reserved-name checks together: what both the form and the server run before asking the database. */
export function checkUsername(raw: string, extraReserved: readonly string[] = []): UsernameCheck {
  const problem = usernameFormatProblem(raw);
  if (problem) return { ok: false, ...problem };
  if (isReservedUsername(raw, extraReserved)) return { ok: false, reason: 'reserved', message: 'This username is reserved.' };
  return { ok: true, username: normalizeUsername(raw) };
}

export interface UsernameAvailability {
  username: string;
  available: boolean;
  reason: UsernameReason | null;
  /** true when the name is the caller's own current one */
  yours?: boolean;
  /** readable alternatives, each verified free at the time of the check (only when taken) */
  suggestions?: string[];
}

/** Readable alternatives for a taken name, most natural first. The server checks each is free. */
export function usernameCandidates(base: string, year: number): string[] {
  const root = base.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
  if (root.length < 2) return [];
  const make = (suffix: string) => `${root.slice(0, USERNAME_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
  const out = [make(String(year)), make('_segue'), make('_notes'), make('_plans'), make('_1'), make('_2'), make('_3'), make(`${year % 100}`)];
  return [...new Set(out)].filter((n) => usernameFormatProblem(n) === null && n !== root);
}
