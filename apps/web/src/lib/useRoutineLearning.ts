/**
 * Learning someone's weekly routine from their Google Calendar, in the app.
 *
 * After a sync (at most every few hours, never with a popup) it reads the last
 * four weeks and the next two, finds weekly patterns (lib/routines.ts), and
 * compares them with the routines already confirmed. What it finds waits as
 * suggestions until the person confirms, corrects or turns them down;
 * confirmed ones become ordinary Segue routines that the planner uses.
 *
 * The learning state lives on this device (IndexedDB). Confirmed routines live
 * with the rest of the routines (and sync with the account, like any routine).
 */
import { useEffect, useRef } from 'react';
import { addDays } from './days';
import { usePersisted } from './hooks';
import { localDate, type StoredBlock } from './model';
import {
  EMPTY_LEARNING,
  detectPatterns,
  learnedOf,
  mergeSuggestions,
  minutesOf,
  occurrencesOf,
  reconcile,
  routineFrom,
  FLEX_AFTER,
  FLEX_BEFORE,
  type LearnedRoutine,
  type LearningState,
  type Suggestion,
} from './routines';
import type { CalendarEvent } from './calendar';

/** How far back and ahead the calendar is read. Four weeks back is enough to see a weekly pattern and to tell a gap from an ending. */
const BACK_DAYS = 28;
const AHEAD_DAYS = 15;
/** Not more often than this, unless asked. */
const EVERY_MS = 6 * 60 * 60_000;

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function useRoutineLearning(opts: {
  ready: boolean;
  connected: boolean;
  syncedAt?: string;
  blocks: StoredBlock[];
  setBlocks: (fn: (list: StoredBlock[]) => StoredBlock[]) => void;
  fetchWindow: (start: string, end: string) => Promise<CalendarEvent[] | null>;
  notify: (text: string) => void;
}) {
  const [state, setState] = usePersisted<LearningState>('routineLearning', EMPTY_LEARNING, opts.ready);
  const running = useRef(false);
  const blocksRef = useRef(opts.blocks);
  blocksRef.current = opts.blocks;

  async function analyse(force = false) {
    if (running.current || !opts.connected) return false;
    if (!force && state.analyzedAt && Date.now() - Date.parse(state.analyzedAt) < EVERY_MS) return false;
    running.current = true;
    try {
      const today = localDate();
      const windowStart = addDays(today, -BACK_DAYS);
      const start = new Date(`${windowStart}T00:00:00`).toISOString();
      const end = new Date(`${addDays(today, AHEAD_DAYS)}T00:00:00`).toISOString();
      const events = await opts.fetchWindow(start, end);
      if (!events) return false;
      const patterns = detectPatterns(occurrencesOf(events), today);
      setState((s) => ({ ...reconcile(s, blocksRef.current, patterns, today, windowStart), analyzedAt: new Date().toISOString() }));
      return true;
    } finally {
      running.current = false;
    }
  }

  // After each successful sync (a connect, Sync now, the 15-minute refresh), at most every few hours.
  const analyseRef = useRef(analyse);
  analyseRef.current = analyse;
  useEffect(() => {
    if (!opts.ready || !opts.connected || !opts.syncedAt) return;
    void analyseRef.current();
  }, [opts.ready, opts.connected, opts.syncedAt]);

  // Disconnecting Google Calendar forgets what was being suggested (confirmed routines stay: they're the person's).
  useEffect(() => {
    if (opts.ready && !opts.connected && (state.suggestions.length || state.changes.length)) setState((s) => ({ ...s, suggestions: [], changes: [], analyzedAt: undefined }));
  }, [opts.ready, opts.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const without = (id: string) => (s: LearningState) => ({ ...s, suggestions: s.suggestions.filter((x) => x.id !== id) });

  function confirm(s: Suggestion) {
    const r = routineFrom(s, new Date().toISOString());
    opts.setBlocks((list) => [...list, r]);
    setState(without(s.id));
    return r;
  }

  return {
    state,
    /** pending suggestions, sure ones first */
    suggestions: [...state.suggestions].sort((a, b) => Number(a.needsReview) - Number(b.needsReview) || b.confidence - a.confidence),
    changes: state.changes,
    analyse,
    /** Save it as a routine, with the person's corrections if they made any. */
    confirm(id: string, patch: Partial<Pick<Suggestion, 'name' | 'category' | 'kind' | 'days' | 'start' | 'end'>> = {}) {
      const s = state.suggestions.find((x) => x.id === id);
      if (!s) return;
      const r = confirm({ ...s, ...patch });
      opts.notify(`Saved “${r.title}” as a routine. Segue plans around it from now on.`);
    },
    /** Confirm every suggestion Segue is sure about (the person presses one button for it). */
    confirmSure() {
      const sure = state.suggestions.filter((s) => !s.needsReview);
      const made = sure.map((s) => routineFrom(s, new Date().toISOString()));
      opts.setBlocks((list) => [...list, ...made]);
      setState((st) => ({ ...st, suggestions: st.suggestions.filter((s) => s.needsReview) }));
      opts.notify(made.length === 1 ? `Saved “${made[0]!.title}” as a routine.` : `Saved ${made.length} routines.`);
    },
    /** Correct a pending suggestion (name, category, fixed or flexible, days, times). It stays a suggestion until confirmed. */
    update(id: string, patch: Partial<Pick<Suggestion, 'name' | 'category' | 'kind' | 'days' | 'start' | 'end'>>) {
      setState((s) => ({ ...s, suggestions: s.suggestions.map((x) => (x.id === id ? { ...x, ...patch, needsReview: false } : x)) }));
    },
    /** Not a routine: never suggested again. */
    exclude(id: string) {
      const s = state.suggestions.find((x) => x.id === id);
      if (!s) return;
      setState((st) => ({
        ...without(id)(st),
        excluded: {
          keys: [...new Set([...st.excluded.keys, s.key])],
          seriesIds: [...new Set([...st.excluded.seriesIds, ...s.seriesIds])],
          titles: [...new Set([...st.excluded.titles, ...s.titles])],
        },
      }));
      opts.notify(`“${s.name}” won’t be suggested again.`);
    },
    /** Same thing under two names: one suggestion. */
    merge(id: string, otherId: string) {
      setState((st) => {
        const a = st.suggestions.find((x) => x.id === id);
        const b = st.suggestions.find((x) => x.id === otherId);
        if (!a || !b) return st;
        return { ...st, suggestions: st.suggestions.filter((x) => x.id !== otherId).map((x) => (x.id === id ? mergeSuggestions(a, b) : x)) };
      });
    },
    /** The first summary was shown. */
    introduced() {
      if (!state.introduced) setState((s) => ({ ...s, introduced: true }));
    },
    /** A confirmed routine's calendar pattern changed: update it as suggested. */
    applyChange(id: string) {
      const c = state.changes.find((x) => x.id === id);
      if (!c) return;
      if (c.kind === 'gone') {
        opts.setBlocks((list) => list.filter((b) => b.id !== c.routineId));
      } else {
        opts.setBlocks((list) =>
          list.map((b) => {
            if (b.id !== c.routineId || !learnedOf(b)) return b;
            const r = b as LearnedRoutine;
            if (c.kind === 'days') return { ...r, days: c.days };
            const start = c.start!;
            const end = c.end!;
            return r.fixedStart
              ? { ...r, fixedStart: start, fixedEnd: end, learned: { ...r.learned, usualStart: start } }
              : { ...r, earliest: hhmm(Math.max(0, minutesOf(start) - FLEX_BEFORE)), latest: hhmm(Math.min(23 * 60 + 59, minutesOf(end) + FLEX_AFTER)), learned: { ...r.learned, usualStart: start } };
          }),
        );
      }
      setState((s) => ({ ...s, changes: s.changes.filter((x) => x.id !== id) }));
      opts.notify(c.kind === 'gone' ? 'Routine removed.' : 'Routine updated.');
    },
    /** Keep it as it is (a temporary change); don't ask again about this one. */
    dismiss(id: string) {
      setState((s) => ({ ...s, changes: s.changes.filter((x) => x.id !== id), suggestions: s.suggestions.filter((x) => x.id !== id), dismissed: [...new Set([...s.dismissed, id])] }));
    },
  };
}
