/**
 * Routine recognition: Segue learns the shape of someone's week from their
 * Google Calendar, and plans around it.
 *
 * Deterministic and pure (no I/O, no clock unless given), so it's tested like
 * the engine. Seven parts, each a function below:
 *
 * 1. Ingestion      `occurrencesOf`: calendar events → local weekday, minutes, normalised title
 * 2. Detection      `detectPatterns`: series ids and same-title/same-time clusters → weekly patterns
 * 3. Classification `classify`: what kind of thing it is (class, fitness, work, study, appointment, personal)
 * 4. Confidence     inside `detectPatterns` / `reconcile`: how sure, and whether to ask
 * 5. Profile        confirmed routines are ordinary Segue routines (StoredBlock) with a `learned` link
 * 6. Scheduling     `applyRoutines`: today's plan uses them (fixed stay protected, flexible get a window)
 * 7. Change         `reconcile`: new patterns, moved times or days, routines that stopped appearing
 *
 * Nothing becomes a routine without the person confirming it, and an
 * inference never overrides something they set.
 */
import type { CalendarEvent } from './calendar';
import { calendarBlockId } from './calendar';
import { newId, type StoredBlock } from './model';

// ---------------------------------------------------------------- types

export type RoutineCategory = 'class' | 'fitness' | 'work' | 'study' | 'appointment' | 'personal';
export type RoutineKind = 'fixed' | 'flexible';

export const CATEGORY_WORDS: Record<RoutineCategory, string> = {
  class: 'Class',
  fitness: 'Fitness',
  work: 'Work',
  study: 'Study',
  appointment: 'Appointment',
  personal: 'Personal',
};

/** How a confirmed routine links back to the calendar, kept on the StoredBlock. */
export interface LearnedLink {
  source: 'google' | 'manual';
  category: RoutineCategory;
  kind: RoutineKind;
  /** Google's recurring-series ids that belong to it */
  seriesIds: string[];
  /** normalised titles that belong to it (after merges) */
  titles: string[];
  /** usual start, "HH:MM", for matching an event to it */
  usualStart: string;
  confirmedAt: string;
}

/** A routine as Segue knows it: one of the person's routines, with its calendar link. */
export type LearnedRoutine = StoredBlock & { learned: LearnedLink };

/** One timed calendar event, as the detector sees it. */
export interface Occurrence {
  id: string;
  seriesId?: string;
  title: string;
  norm: string;
  date: string; // local "YYYY-MM-DD"
  weekday: number; // 0 = Sunday
  startMin: number; // minutes after local midnight
  endMin: number;
  location?: string;
}

/** A weekly pattern found in the calendar. */
export interface Pattern {
  key: string;
  name: string;
  norm: string;
  titles: string[];
  seriesIds: string[];
  days: number[];
  start: string; // "HH:MM" (median)
  end: string;
  minutes: number;
  location?: string;
  occurrences: number;
  /** distinct weeks it was seen in */
  weeks: number;
  firstSeen: string;
  lastSeen: string;
  /** dates it is still on the calendar after `today` */
  upcoming: number;
  /** 0..1: how sure Segue is that this is a weekly pattern */
  confidence: number;
  /** recent occurrences only (last 14 days): for change detection */
  recent: { days: number[]; start: string; end: string; count: number };
}

/** What Segue would like the person to look at. Nothing here is saved as a routine until confirmed. */
export interface Suggestion {
  id: string;
  key: string;
  name: string;
  category: RoutineCategory;
  kind: RoutineKind;
  days: number[];
  start: string;
  end: string;
  location?: string;
  seriesIds: string[];
  titles: string[];
  occurrences: number;
  /** 0..1, pattern and category together */
  confidence: number;
  /** under 0.7: the card asks rather than states */
  needsReview: boolean;
  /** why Segue thinks so, in plain words */
  reason: string;
  /** another suggestion that looks like the same thing (offer to merge) */
  similarTo?: string;
}

/** A confirmed routine whose calendar pattern changed (or stopped). Asked about, never applied silently. */
export interface RoutineChange {
  id: string;
  routineId: string;
  kind: 'time' | 'days' | 'gone';
  start?: string;
  end?: string;
  days?: number[];
  reason: string;
}

export interface LearningState {
  suggestions: Suggestion[];
  changes: RoutineChange[];
  /** keys and series the person said aren't routines */
  excluded: { keys: string[]; seriesIds: string[]; titles: string[] };
  /** suggestions or changes the person dismissed ("Not now"), by id-ish key, so they don't come back each sync */
  dismissed: string[];
  analyzedAt?: string;
  /** the first summary has been shown */
  introduced?: boolean;
}

export const EMPTY_LEARNING: LearningState = { suggestions: [], changes: [], excluded: { keys: [], seriesIds: [], titles: [] }, dismissed: [] };

// ---------------------------------------------------------------- 1. ingestion

const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'at', 'with', 'for', 'to', 'in', 'on', 'my', 'session']);

/** "Programming 1 – Lecture!" → "programming 1 lecture". Numbers stay: Programming 1 and Programming 2 are different classes. */
export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const tokens = (norm: string) => norm.split(' ').filter((t) => t && !STOP.has(t));

/** Local date, weekday and minutes for an ISO time in a time zone (the device's by default). */
function localParts(iso: string, zone?: string): { date: string; weekday: number; minutes: number } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!);
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function occurrencesOf(events: CalendarEvent[], zone?: string): Occurrence[] {
  const seen = new Set<string>();
  const out: Occurrence[] = [];
  for (const e of events) {
    // The same event can be stored for several days (the calendar keeps days), so key on id + start.
    const k = `${e.id}|${e.start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const s = localParts(e.start, zone);
    const en = localParts(e.end, zone);
    const endMin = en.date === s.date ? en.minutes : 24 * 60;
    if (endMin <= s.minutes) continue;
    out.push({ id: e.id, seriesId: e.seriesId, title: e.title, norm: normTitle(e.title), date: s.date, weekday: s.weekday, startMin: s.minutes, endMin, location: e.location });
  }
  return out.sort((a, b) => (a.date + String(a.startMin).padStart(4, '0')).localeCompare(b.date + String(b.startMin).padStart(4, '0')));
}

// ---------------------------------------------------------------- 2. detection

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const minutesOf = (hm: string) => {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return h * 60 + m;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};
const mode = <T,>(xs: T[]): T | undefined => {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
/** Monday-based week id, so a Mon/Wed/Fri pattern falls in one week. */
const weekOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d!);
  const wd = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - wd * 86_400_000).toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const addDaysTo = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** How far apart two start times can be and still be "the same time" (a class that sometimes starts 15 min late). */
const SAME_TIME = 60;

/**
 * Weekly patterns: occurrences grouped by title (and series), split by time of
 * day, with the weekdays they keep coming back on. A pattern needs at least two
 * occurrences in different weeks, or a recurring series.
 */
export function detectPatterns(occ: Occurrence[], today: string): Pattern[] {
  // Group by normalised title; a recurring series also pulls in renamed instances.
  const byTitle = new Map<string, Occurrence[]>();
  const seriesTitle = new Map<string, string>();
  for (const o of occ) {
    const t = o.seriesId && seriesTitle.has(o.seriesId) ? seriesTitle.get(o.seriesId)! : o.norm;
    if (o.seriesId && !seriesTitle.has(o.seriesId)) seriesTitle.set(o.seriesId, t);
    if (!t) continue;
    byTitle.set(t, [...(byTitle.get(t) ?? []), o]);
  }
  const out: Pattern[] = [];
  for (const [norm, list] of byTitle) {
    // Split by time of day: "Gym" at 7 AM and "Gym" at 5 PM are two routines.
    const clusters: Occurrence[][] = [];
    for (const o of [...list].sort((a, b) => a.startMin - b.startMin)) {
      const c = clusters.find((cl) => Math.abs(median(cl.map((x) => x.startMin)) - o.startMin) <= SAME_TIME);
      if (c) c.push(o);
      else clusters.push([o]);
    }
    for (const cl of clusters) {
      const series = [...new Set(cl.map((o) => o.seriesId).filter((s): s is string => !!s))];
      const weeks = new Set(cl.map((o) => weekOf(o.date)));
      if (cl.length < 2 || (weeks.size < 2 && series.length === 0)) continue;
      // A weekday counts when it shows up in at least half of the weeks the pattern was seen (and at least twice, or in a series).
      const dayCount = new Map<number, number>();
      for (const o of cl) dayCount.set(o.weekday, (dayCount.get(o.weekday) ?? 0) + 1);
      const days = [...dayCount.entries()]
        .filter(([, n]) => n >= Math.max(series.length ? 1 : 2, Math.ceil(weeks.size / 2)))
        .map(([d]) => d)
        .sort((a, b) => a - b);
      if (days.length === 0) continue;
      const onDays = cl.filter((o) => days.includes(o.weekday));
      const start = median(onDays.map((o) => o.startMin));
      const end = median(onDays.map((o) => o.endMin));
      const dates = onDays.map((o) => o.date).sort();
      // Consistency: of the slots (weeks × days) between the first and last time it was seen, how many had it.
      const spanWeeks = Math.max(1, Math.round(daysBetween(weekOf(dates[0]!), weekOf(dates.at(-1)!)) / 7) + 1);
      const consistency = Math.min(1, onDays.length / (spanWeeks * days.length));
      let confidence = 0.35 + 0.35 * consistency + Math.min(0.2, 0.04 * onDays.length);
      if (series.length) confidence += 0.15;
      if (weeks.size < 2) confidence -= 0.15;
      confidence = Math.max(0.1, Math.min(0.98, confidence));
      const recentFrom = addDaysTo(today, -14);
      const recent = onDays.filter((o) => o.date >= recentFrom && o.date <= today);
      const recentAll = cl.filter((o) => o.date >= recentFrom && o.date <= today);
      const titleCounts = cl.map((o) => o.title);
      out.push({
        key: series.length ? `s:${series.sort()[0]}` : `t:${norm}@${hhmm(Math.round(start / 30) * 30)}`,
        name: mode(titleCounts)!,
        norm,
        titles: [...new Set(cl.map((o) => o.norm))],
        seriesIds: series,
        days,
        start: hhmm(start),
        end: hhmm(end),
        minutes: end - start,
        location: mode(cl.map((o) => o.location).filter((l): l is string => !!l)),
        occurrences: onDays.length,
        weeks: weeks.size,
        firstSeen: dates[0]!,
        lastSeen: dates.filter((d) => d <= today).at(-1) ?? dates[0]!,
        upcoming: onDays.filter((o) => o.date > today).length,
        confidence,
        recent: {
          days: [...new Set(recentAll.map((o) => o.weekday))].sort((a, b) => a - b),
          start: recent.length ? hhmm(median(recent.map((o) => o.startMin))) : hhmm(start),
          end: recent.length ? hhmm(median(recent.map((o) => o.endMin))) : hhmm(end),
          count: recentAll.length,
        },
      });
    }
  }
  return out.sort((a, b) => a.days[0]! - b.days[0]! || minutesOf(a.start) - minutesOf(b.start));
}

// ---------------------------------------------------------------- 3. classification

/** Words that point to a kind of activity, with how strongly. Titles first, then the location. */
const LEXICON: { cat: RoutineCategory; words: RegExp; weight: number }[] = [
  { cat: 'class', words: /\b(class|lecture|lec|lab|laboratory|seminar|tutorial|recitation|course|subject|section|module|programming|mathematics|math|calculus|calc|algebra|physics|phys|chemistry|chem|biology|bio|history|english|filipino|science|economics|accounting|statistics|networking|database|thesis|pe|nstp)\b/, weight: 0.75 },
  { cat: 'class', words: /\b[a-z]{2,5} ?\d{2,4}[a-z]?\b/, weight: 0.45 }, // course codes like "CS 101", "IT113"
  { cat: 'fitness', words: /\b(gym|workout|work out|training|run|running|jog|yoga|pilates|swim|swimming|cardio|lift|lifting|weights|crossfit|spin|zumba|boxing|muay thai|basketball|badminton|volleyball|football|futsal|hike|leg day|upper body|lower body|push day|pull day|stretch|exercise|fitness)\b/, weight: 0.8 },
  { cat: 'work', words: /\b(work|shift|meeting|standup|stand up|sync|1 ?on ?1|one on one|retro|sprint|client|office|duty|interview|staff|ops|onboarding)\b/, weight: 0.65 },
  // weaker hints: a call or a review can be work or personal
  { cat: 'work', words: /\b(call|review|team|planning)\b/, weight: 0.4 },
  { cat: 'study', words: /\b(study|studying|review for|reviewer|homework|assignment|reading|revision|revise|practice|prep|finals|midterms|exam prep|research)\b/, weight: 0.75 },
  { cat: 'appointment', words: /\b(dentist|doctor|dr|clinic|checkup|check up|appointment|appt|therapy|therapist|counseling|consultation|hospital|vet|haircut|salon|barber)\b/, weight: 0.85 },
];
const LOCATION_HINTS: { cat: RoutineCategory; words: RegExp; weight: number }[] = [
  { cat: 'class', words: /\b(university|college|campus|school|room|rm|hall|building|bldg|lab|pup|up diliman|ust|dlsu|ateneo)\b/, weight: 0.35 },
  { cat: 'fitness', words: /\b(gym|fitness|anytime|gold s|snap|court|pool|track|studio)\b/, weight: 0.4 },
  { cat: 'work', words: /\b(office|hq|zoom|meet google|teams|cowork)\b/, weight: 0.25 },
  { cat: 'appointment', words: /\b(clinic|hospital|medical|dental)\b/, weight: 0.4 },
];
/** Fitness that's booked at a set time (a class, a coach) is fixed; a workout of your own is flexible. */
const BOOKED = /\b(class|booking|booked|coach|pt|personal training|lesson|league|game|match)\b/;
/** Study with a deadline or exam at a set time is fixed. */
const TIMED_STUDY = /\b(exam|quiz|test|defense|defence|presentation|consultation)\b/;

export function classify(title: string, location?: string): { category: RoutineCategory; kind: RoutineKind; confidence: number } {
  const t = normTitle(title);
  const loc = normTitle(location ?? '');
  const score = new Map<RoutineCategory, number>();
  const add = (c: RoutineCategory, w: number) => score.set(c, Math.min(1, (score.get(c) ?? 0) + w));
  for (const l of LEXICON) if (l.words.test(t)) add(l.cat, l.weight);
  for (const l of LOCATION_HINTS) if (loc && l.words.test(loc)) add(l.cat, l.weight);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (!best) return { category: 'personal', kind: 'fixed', confidence: 0.3 };
  // Two categories close together: not sure.
  const confidence = Math.max(0.3, Math.min(0.95, best[1] - (second ? second[1] * 0.5 : 0)));
  const category = best[0];
  let kind: RoutineKind = category === 'fitness' || category === 'study' ? 'flexible' : 'fixed';
  if (category === 'fitness' && BOOKED.test(t)) kind = 'fixed';
  if (category === 'study' && TIMED_STUDY.test(t)) kind = 'fixed';
  return { category, kind, confidence };
}

// ---------------------------------------------------------------- 5. profile: matching events to routines

/** Is this calendar event an occurrence of the routine? Its series, or one of its titles at about its time. */
export function eventMatches(r: LearnedRoutine, e: Pick<CalendarEvent, 'title' | 'seriesId' | 'start'>, zone?: string): boolean {
  if (e.seriesId && r.learned.seriesIds.includes(e.seriesId)) return true;
  if (!r.learned.titles.includes(normTitle(e.title))) return false;
  return Math.abs(localParts(e.start, zone).minutes - minutesOf(r.learned.usualStart)) <= 90;
}

const isLearned = (b: StoredBlock): b is LearnedRoutine => !!(b as LearnedRoutine).learned;
export const learnedOf = (b: StoredBlock): LearnedLink | undefined => (b as LearnedRoutine).learned;

/** Around a flexible routine's usual time, how much room it has to move. */
export const FLEX_BEFORE = 60;
export const FLEX_AFTER = 90;

/** A confirmed suggestion as one of the person's routines. */
export function routineFrom(s: Suggestion, now: string): LearnedRoutine {
  const minutes = Math.max(5, minutesOf(s.end) - minutesOf(s.start));
  const base: StoredBlock = {
    id: newId(),
    title: s.name,
    minMinutes: s.kind === 'flexible' ? Math.max(15, Math.round(minutes * 0.75)) : minutes,
    maxMinutes: minutes,
    priority: s.kind === 'fixed' ? 'must' : 'should',
    // Their own place (their gym, their campus) comes from the calendar; Segue doesn't swap it for another one nearby.
    category: 'none',
    requirements: [],
    active: true,
    days: s.days,
  };
  if (s.kind === 'fixed') {
    base.fixedStart = s.start;
    base.fixedEnd = s.end;
    base.fixedPlace = s.location;
  } else {
    base.earliest = hhmm(Math.max(0, minutesOf(s.start) - FLEX_BEFORE));
    base.latest = hhmm(Math.min(23 * 60 + 59, minutesOf(s.end) + FLEX_AFTER));
  }
  return { ...base, learned: { source: 'google', category: s.category, kind: s.kind, seriesIds: s.seriesIds, titles: s.titles, usualStart: s.start, confirmedAt: now } };
}

/** The person changed kind or time in the routine form: keep the link in step. */
export function relinked(b: LearnedRoutine): LearnedRoutine {
  const start = b.fixedStart ?? (b.earliest ? hhmm(minutesOf(b.earliest) + FLEX_BEFORE) : b.learned.usualStart);
  return { ...b, learned: { ...b.learned, kind: b.fixedStart ? 'fixed' : 'flexible', usualStart: start } };
}

// ---------------------------------------------------------------- 7. change detection (and new suggestions)

const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every((d, i) => d === b[i]);
const dayWords = (days: number[]) => {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const s = [...days].sort();
  if (s.join() === '1,2,3,4,5') return 'weekdays';
  if (s.join() === '0,6') return 'weekends';
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => s.includes(d)).map((d) => names[d]).join(', ');
};
export const timeWords = (hm: string) => {
  const m = minutesOf(hm);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

function patternFor(r: LearnedRoutine, patterns: Pattern[]): Pattern | undefined {
  return (
    patterns.find((p) => p.seriesIds.some((s) => r.learned.seriesIds.includes(s))) ??
    patterns
      .filter((p) => p.titles.some((t) => r.learned.titles.includes(t)))
      .sort((a, b) => Math.abs(minutesOf(a.start) - minutesOf(r.learned.usualStart)) - Math.abs(minutesOf(b.start) - minutesOf(r.learned.usualStart)))[0]
  );
}

/**
 * Compare what the calendar shows now with what's known:
 * - confirmed routines that moved (time or days), judged on the last two weeks and only when that's consistent;
 * - confirmed routines that stopped appearing for three weeks and aren't coming up (one missed week isn't enough);
 * - patterns that aren't routines yet (and weren't turned down): new suggestions.
 * Pending suggestions are refreshed in place by key, so a sync never adds duplicates.
 */
export function reconcile(state: LearningState, routines: StoredBlock[], patterns: Pattern[], today: string, windowStart: string): LearningState {
  const learned = routines.filter(isLearned).filter((r) => r.learned.source === 'google');
  const claimed = new Set<string>();
  const changes: RoutineChange[] = [];
  for (const r of learned) {
    const p = patternFor(r, patterns);
    if (p) claimed.add(p.key);
    if (!p) {
      // Not seen at all in the window: it stopped, if the window is long enough to tell.
      if (daysBetween(windowStart, today) >= 21) {
        changes.push({ id: `gone:${r.id}`, routineId: r.id, kind: 'gone', reason: `“${r.title}” hasn’t been on your calendar for three weeks, and nothing is coming up.` });
      }
      continue;
    }
    const usual = r.fixedStart ?? r.learned.usualStart;
    const recentShift = Math.abs(minutesOf(p.recent.start) - minutesOf(usual));
    if (p.recent.count >= 2 && recentShift >= 30) {
      changes.push({
        id: `time:${r.id}:${p.recent.start}`,
        routineId: r.id,
        kind: 'time',
        start: p.recent.start,
        end: p.recent.end,
        reason: `“${r.title}” has been at ${timeWords(p.recent.start)} lately, not ${timeWords(usual)}.`,
      });
    }
    const routineDays = [...(r.days ?? [])].sort((a, b) => a - b);
    if (p.recent.count >= 3 && p.weeks >= 2 && !sameDays(p.recent.days, routineDays) && p.recent.days.length > 0 && sameDays(p.days, p.recent.days)) {
      changes.push({
        id: `days:${r.id}:${p.recent.days.join('')}`,
        routineId: r.id,
        kind: 'days',
        days: p.recent.days,
        reason: `“${r.title}” is on ${dayWords(p.recent.days)} now, not ${dayWords(routineDays)}.`,
      });
    }
    // Last seen more than three weeks ago and nothing ahead: stopped. A single gap is just a missed session.
    if (daysBetween(p.lastSeen, today) >= 21 && p.upcoming === 0) {
      changes.push({ id: `gone:${r.id}`, routineId: r.id, kind: 'gone', reason: `“${r.title}” hasn’t been on your calendar since ${p.lastSeen}, and nothing is coming up.` });
    }
  }

  const ex = state.excluded;
  const fresh: Suggestion[] = [];
  for (const p of patterns) {
    if (claimed.has(p.key) || ex.keys.includes(p.key) || p.seriesIds.some((s) => ex.seriesIds.includes(s)) || ex.titles.includes(p.norm)) continue;
    const prev = state.suggestions.find((s) => s.key === p.key);
    const c = classify(p.name, p.location);
    const confidence = Math.min(p.confidence, 0.5 + c.confidence / 2);
    fresh.push({
      id: prev?.id ?? `sg:${p.key}`,
      key: p.key,
      // What the person already corrected on a pending suggestion stays.
      name: prev?.name ?? p.name,
      category: prev?.category ?? c.category,
      kind: prev?.kind ?? c.kind,
      days: prev?.days ?? p.days,
      start: prev?.start ?? p.start,
      end: prev?.end ?? p.end,
      location: p.location,
      seriesIds: [...new Set([...(prev?.seriesIds ?? []), ...p.seriesIds])],
      titles: [...new Set([...(prev?.titles ?? []), ...p.titles])],
      occurrences: p.occurrences,
      confidence,
      needsReview: confidence < 0.7 || c.confidence < 0.6,
      reason:
        (p.seriesIds.length ? 'A repeating event in your calendar' : `Seen ${p.occurrences} times over ${p.weeks} weeks`) +
        `, ${dayWords(p.days)} around ${timeWords(p.start)}.`,
    });
  }
  // Similar names, same kind, about the same time: offer to merge (the person decides).
  for (const s of fresh) {
    const other = fresh.find(
      (o) =>
        o !== s &&
        o.category === s.category &&
        Math.abs(minutesOf(o.start) - minutesOf(s.start)) <= SAME_TIME &&
        jaccard(tokens(normTitle(o.name)), tokens(normTitle(s.name))) >= 0.34,
    );
    s.similarTo = other?.id;
  }
  const dismissed = new Set(state.dismissed);
  return {
    ...state,
    suggestions: fresh.filter((s) => !dismissed.has(s.id)),
    changes: changes.filter((c) => !dismissed.has(c.id)),
  };
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

/** Two suggestions the person says are the same thing: one, with both names and days. */
export function mergeSuggestions(a: Suggestion, b: Suggestion): Suggestion {
  return {
    ...a,
    days: [...new Set([...a.days, ...b.days])].sort((x, y) => x - y),
    seriesIds: [...new Set([...a.seriesIds, ...b.seriesIds])],
    titles: [...new Set([...a.titles, ...b.titles])],
    occurrences: a.occurrences + b.occurrences,
    similarTo: undefined,
    reason: `${a.reason.replace(/\.$/, '')}, together with “${b.name}”.`,
  };
}

// ---------------------------------------------------------------- 6. scheduling: today's plan

export interface AppliedRoutines {
  /** routines (and other blocks) to plan today, adjusted */
  blocks: StoredBlock[];
  /** calendar blocks a flexible routine now stands in for: leave them out so nothing is planned twice */
  replacesCalendar: Set<string>;
  /** why each routine is in today's plan, for the Today screen */
  why: Record<string, string>;
}

/**
 * Today's blocks with confirmed calendar routines applied:
 * - fixed routine, today's event is in the calendar: the calendar's event is planned (it has today's real time); the routine steps aside;
 * - fixed routine, calendar loaded but no event today: that occurrence was cancelled or moved, so it isn't planned;
 * - fixed routine, calendar not loaded today: planned at its usual time, protected (better than forgetting class);
 * - flexible routine with today's event: planned as a flexible block around the event's actual time, in place of the fixed event;
 * - flexible routine, calendar loaded, no event: not planned today (the calendar says it isn't on);
 * - flexible routine, calendar not loaded: planned in its usual window.
 * Routines the person made themselves are untouched.
 */
export function applyRoutines(blocks: StoredBlock[], todayEvents: CalendarEvent[] | null, zone?: string): AppliedRoutines {
  const out: StoredBlock[] = [];
  const replacesCalendar = new Set<string>();
  const why: Record<string, string> = {};
  const used = new Set<string>();
  for (const b of blocks) {
    const l = learnedOf(b);
    if (!l || l.source !== 'google' || b.date) {
      out.push(b);
      continue;
    }
    const r = b as LearnedRoutine;
    const match = todayEvents?.find((e) => !used.has(e.id) && eventMatches(r, e, zone));
    if (match) used.add(match.id);
    const kind = r.fixedStart ? 'fixed' : 'flexible';
    if (kind === 'fixed') {
      if (todayEvents === null) {
        out.push(b);
        why[b.id] = 'Your usual time (calendar not synced today)';
      } else if (match) why[calendarBlockId(match.id)] = `Your ${CATEGORY_WORDS[l.category].toLowerCase()} routine: fixed, never moved`;
      continue; // the calendar event covers it, or it's not on today
    }
    if (todayEvents === null) {
      out.push(b);
      why[b.id] = 'Your routine, in its usual window';
      continue;
    }
    if (!match) continue;
    const s = localParts(match.start, zone).minutes;
    const e = localParts(match.end, zone).minutes;
    const minutes = Math.max(5, e - s);
    out.push({
      ...b,
      minMinutes: Math.min(b.minMinutes, minutes),
      maxMinutes: Math.max(b.minMinutes, minutes),
      earliest: hhmm(Math.max(0, s - FLEX_BEFORE)),
      latest: hhmm(Math.min(23 * 60 + 59, e + FLEX_AFTER)),
    });
    replacesCalendar.add(calendarBlockId(match.id));
    why[b.id] = `Your routine: around ${timeWords(hhmm(s))}, can move if the day needs it`;
  }
  return { blocks: out, replacesCalendar, why };
}
