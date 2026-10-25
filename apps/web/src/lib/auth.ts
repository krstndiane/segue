/**
 * Segue accounts: email and password through Supabase Auth, spoken to over
 * its REST API (no SDK). The session (access + refresh token) lives in
 * localStorage under its own key, apart from the planner's data, and is
 * never synced. The Segue API checks the access token on every request.
 */

export const SUPABASE_URL: string | undefined = (import.meta.env?.VITE_SUPABASE_URL as string | undefined)?.replace(/\/+$/, '') || undefined;
/** The project's public ("anon" / publishable) key. Safe in the browser; it can't read Segue's tables. */
const SUPABASE_KEY: string | undefined = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined) || undefined;

/** Accounts are switched on for this build. */
export const accountsEnabled = !!SUPABASE_URL && !!SUPABASE_KEY;

const STORAGE_KEY = 'segue.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
  user: { id: string; email?: string };
}

export class AuthFailure extends Error {}

type Listener = (s: Session | null) => void;
const listeners = new Set<Listener>();
let current: Session | null = read();

function read(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    return s?.accessToken && s.refreshToken && s.user?.id ? s : null;
  } catch {
    return null;
  }
}

function write(s: Session | null) {
  current = s;
  try {
    if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode: the session lasts as long as the tab
  }
  listeners.forEach((l) => l(s));
}

export const getSession = () => current;

export function onSession(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Another tab signed in or out.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = read();
    listeners.forEach((l) => l(current));
  });
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id: string; email?: string };
  id?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  msg?: string;
  message?: string;
}

/** Plain words for what Supabase said. */
function explain(status: number, b: TokenBody): string {
  const code = b.error_code ?? b.error ?? '';
  const text = `${b.msg ?? b.message ?? b.error_description ?? ''}`.toLowerCase();
  if (code === 'invalid_credentials' || text.includes('invalid login')) return "That email and password don't match. Try again or reset your password.";
  if (code === 'email_not_confirmed' || text.includes('not confirmed')) return 'Confirm your email first: open the link we sent you.';
  if (code === 'user_already_exists' || text.includes('already registered')) return 'There is already an account with that email. Sign in instead.';
  if (code === 'weak_password' || text.includes('password should')) return 'Use a longer password: at least 8 characters, with letters and numbers.';
  if (code === 'over_email_send_rate_limit' || status === 429) return 'Too many tries. Wait a minute and try again.';
  if (code === 'validation_failed' || text.includes('email')) return 'Check the email address.';
  if (code === 'same_password') return 'Pick a password you haven’t used here before.';
  return "Couldn't reach Segue's sign-in just now. Check your connection and try again.";
}

async function call(path: string, body: unknown, token?: string, method = 'POST'): Promise<TokenBody> {
  if (!accountsEnabled) throw new AuthFailure('Accounts aren’t switched on in this version of Segue.');
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
      method,
      headers: { apikey: SUPABASE_KEY!, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AuthFailure("Couldn't reach Segue's sign-in. Check your connection and try again.");
  }
  const b = (await res.json().catch(() => ({}))) as TokenBody;
  if (!res.ok) throw new AuthFailure(explain(res.status, b));
  return b;
}

function sessionFrom(b: TokenBody): Session | null {
  if (!b.access_token || !b.refresh_token || !b.user?.id) return null;
  const expiresAt = b.expires_at ? b.expires_at * 1000 : Date.now() + (b.expires_in ?? 3600) * 1000;
  return { accessToken: b.access_token, refreshToken: b.refresh_token, expiresAt, user: { id: b.user.id, email: b.user.email } };
}

/** Where the emailed links bring people back to. Add it to Supabase → Authentication → URL Configuration. */
const returnTo = () => `${window.location.origin}/app`;

/** Creates the account. Usually Supabase emails a confirmation link first; then there's no session yet. */
export async function signUp(email: string, password: string): Promise<{ confirmEmail: boolean }> {
  const b = await call(`/signup?redirect_to=${encodeURIComponent(returnTo())}`, { email: email.trim(), password });
  const s = sessionFrom(b);
  if (s) write(s);
  return { confirmEmail: !s };
}

export async function signIn(email: string, password: string): Promise<Session> {
  const s = sessionFrom(await call('/token?grant_type=password', { email: email.trim(), password }));
  if (!s) throw new AuthFailure("Couldn't sign in just now. Try again.");
  write(s);
  return s;
}

export async function signOut(): Promise<void> {
  const s = current;
  write(null);
  if (s) await call('/logout', undefined, s.accessToken).catch(() => {});
}

/** Emails a link that brings you back to set a new password. Says the same thing whether or not the email has an account. */
export async function sendPasswordReset(email: string): Promise<void> {
  await call(`/recover?redirect_to=${encodeURIComponent(returnTo())}`, { email: email.trim() });
}

export async function updatePassword(password: string): Promise<void> {
  const token = await accessToken();
  if (!token) throw new AuthFailure('Sign in again to change your password.');
  await call('/user', { password }, token, 'PUT');
}

let refreshing: Promise<Session | null> | null = null;

async function refresh(): Promise<Session | null> {
  const s = current;
  if (!s) return null;
  refreshing ??= call('/token?grant_type=refresh_token', { refresh_token: s.refreshToken })
    .then((b) => {
      const next = sessionFrom(b);
      write(next);
      return next;
    })
    .catch((e: unknown) => {
      // A rejected refresh token means signed out; a network failure keeps the session for later.
      if (e instanceof AuthFailure && !/connection/.test(e.message)) write(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** A valid access token, refreshed when it's about to run out; null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = current;
  if (!s) return null;
  if (s.expiresAt - Date.now() > 60_000) return s.accessToken;
  return (await refresh())?.accessToken ?? null;
}

/** After an emailed link (confirm or reset), Supabase returns with the session in the URL fragment. */
export function takeRedirect(): { kind: 'signup' | 'recovery' | 'other'; error?: string } | null {
  if (typeof window === 'undefined' || !window.location.hash.includes('=')) return null;
  const p = new URLSearchParams(window.location.hash.slice(1));
  const hasAuth = p.has('access_token') || p.has('error_description') || p.has('error');
  if (!hasAuth) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (p.get('error_description') || p.get('error')) {
    return { kind: 'other', error: 'That link has expired or was already used. Ask for a new one.' };
  }
  const expiresIn = Number(p.get('expires_in') ?? 3600);
  const token = p.get('access_token')!;
  let user: Session['user'] | null = null;
  try {
    const claims = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { sub: string; email?: string };
    user = { id: claims.sub, email: claims.email };
  } catch {
    user = null;
  }
  const refreshToken = p.get('refresh_token');
  if (user && refreshToken) write({ accessToken: token, refreshToken, expiresAt: Date.now() + expiresIn * 1000, user });
  const type = p.get('type');
  return { kind: type === 'recovery' ? 'recovery' : type === 'signup' || type === 'email' ? 'signup' : 'other' };
}

/** A password Segue accepts: 8+ characters with a letter and a number. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'At least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  return null;
}
