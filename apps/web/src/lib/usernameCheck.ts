/**
 * Live username checking for the sign-up and profile forms.
 *
 * Format problems are shown straight away (no request). A well-formed name is
 * checked with the server after a short pause in typing; a newer keystroke
 * cancels the old request, and an answer for an older name is ignored, so the
 * message always matches what's in the box. The answer is advisory: saving is
 * checked again by the server and the database.
 */
import { checkUsername, normalizeUsername, usernameFormatProblem, type UsernameAvailability } from '@segue/schemas';

export type UsernameStatus = 'empty' | 'hint' | 'invalid' | 'checking' | 'available' | 'yours' | 'taken' | 'reserved' | 'error';

export interface UsernameState {
  status: UsernameStatus;
  /** Plain words shown beside the field */
  message: string;
  suggestions: string[];
}

export const EMPTY_STATE: UsernameState = { status: 'empty', message: 'Enter a username.', suggestions: [] };

/** What can be said without asking the server. `null` means the name is well-formed and needs a check. */
export function localUsernameState(raw: string, current?: string): UsernameState | null {
  const name = raw.trim();
  if (!name) return EMPTY_STATE;
  // Their own existing name is always theirs, even if it predates today's rules.
  if (current && normalizeUsername(name) === current) return { status: 'yours', message: 'This is your current username.', suggestions: [] };
  const problem = usernameFormatProblem(name);
  if (problem) {
    // Still typing toward the minimum length: a hint, not an error.
    if (problem.reason === 'too_short' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return { status: 'hint', message: problem.message, suggestions: [] };
    return { status: 'invalid', message: problem.message, suggestions: [] };
  }
  const c = checkUsername(name);
  if (!c.ok) return { status: 'reserved', message: c.message, suggestions: [] };
  return null;
}

export function stateFromAnswer(a: UsernameAvailability): UsernameState {
  if (a.available) return a.yours ? { status: 'yours', message: 'This is your current username.', suggestions: [] } : { status: 'available', message: 'Username is available.', suggestions: [] };
  if (a.reason === 'taken') return { status: 'taken', message: 'Username is already taken.', suggestions: a.suggestions ?? [] };
  if (a.reason === 'reserved') return { status: 'reserved', message: 'This username is reserved.', suggestions: [] };
  const local = usernameFormatProblem(a.username);
  return { status: 'invalid', message: local?.message ?? 'That username isn’t allowed.', suggestions: [] };
}

export interface CheckerOptions {
  ask: (name: string, signal: AbortSignal) => Promise<UsernameAvailability>;
  onState: (s: UsernameState) => void;
  delayMs?: number;
  /** injectable for tests */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class UsernameChecker {
  private seq = 0;
  private timer: unknown;
  private abort: AbortController | null = null;
  private last: { raw: string; current?: string } | null = null;
  private readonly delay: number;
  private readonly setT: NonNullable<CheckerOptions['setTimer']>;
  private readonly clearT: NonNullable<CheckerOptions['clearTimer']>;

  constructor(private readonly o: CheckerOptions) {
    this.delay = o.delayMs ?? 400;
    this.setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Call whenever the text (or the person's current username) changes. */
  update(raw: string, current?: string) {
    this.last = { raw, current };
    this.cancel();
    const mine = ++this.seq;
    const local = localUsernameState(raw, current);
    if (local) {
      this.o.onState(local);
      return;
    }
    this.o.onState({ status: 'checking', message: 'Checking availability…', suggestions: [] });
    this.timer = this.setT(() => void this.run(raw.trim(), mine), this.delay);
  }

  retry() {
    if (this.last) {
      const { raw, current } = this.last;
      this.update(raw, current);
    }
  }

  /** The save was refused because someone got the name first. */
  markTaken(raw: string) {
    this.cancel();
    const mine = ++this.seq;
    this.o.onState({ status: 'taken', message: 'That username was just taken. Pick another one.', suggestions: [] });
    // fetch fresh suggestions in the background
    void this.run(raw.trim(), mine, true);
  }

  dispose() {
    this.cancel();
    this.seq++;
  }

  private cancel() {
    if (this.timer !== undefined) this.clearT(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    this.abort = null;
  }

  private async run(name: string, mine: number, keepMessage = false) {
    const ctl = new AbortController();
    this.abort = ctl;
    try {
      const a = await this.o.ask(name, ctl.signal);
      if (mine !== this.seq) return; // a newer edit has happened: this answer is out of date
      const next = stateFromAnswer(a);
      this.o.onState(keepMessage && next.status === 'taken' ? { ...next, message: 'That username was just taken. Pick another one.' } : next);
    } catch (e) {
      if (mine !== this.seq || (e as Error).name === 'AbortError') return;
      this.o.onState({ status: 'error', message: 'Unable to check availability. Please try again.', suggestions: [] });
    }
  }
}
