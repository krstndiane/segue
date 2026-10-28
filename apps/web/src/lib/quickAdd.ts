/**
 * Plain words → a block. "Gym 1h after 5pm", "Lunch with Ana 12:30 at
 * Greenbelt", "Groceries before 8", "Standup 9:30-10", "Deep work 2h wifi".
 * Runs on the phone, instantly and offline. Anything it doesn't understand
 * stays in the title, so nothing the user typed is lost.
 */
import type { PlaceCategory, Priority, Requirement, TimePref } from '@segue/engine';
import { CATEGORY_LABEL, PRIORITY_LABEL, REQUIREMENT_LABEL, localDate, newId, type StoredBlock } from './model';

export interface QuickAddResult {
  block: StoredBlock;
  /** What was understood, in words, for the preview chips. */
  chips: string[];
  /** false when most of the text wasn't understood: worth asking the smarter parser. */
  confident: boolean;
}

interface Kind {
  words: RegExp;
  category: PlaceCategory;
  minutes: number;
  requirements?: Requirement[];
  fallback?: string;
  window?: [string, string];
  timePref?: TimePref;
  /** work or study: anywhere unless the note asks for something only a place has */
  work?: boolean;
}

// First match wins, so the more specific kinds come first.
const KINDS: Kind[] = [
  { words: /\b(breakfast)\b/, category: 'restaurant', minutes: 30, window: ['07:00', '10:30'], fallback: 'Grab something to go' },
  { words: /\b(lunch|brunch)\b/, category: 'restaurant', minutes: 45, window: ['11:00', '14:30'], fallback: 'Grab something to go' },
  { words: /\b(dinner|supper)\b/, category: 'restaurant', minutes: 60, window: ['18:00', '21:30'], fallback: 'Order in' },
  { words: /\b(eat|food|meal|merienda)\b/, category: 'restaurant', minutes: 45, fallback: 'Grab something to go' },
  { words: /\b(cowork(ing)?)\b/, category: 'cowork', minutes: 120, requirements: ['wifi', 'power'], fallback: 'Work wherever you are' },
  { words: /\b(library)\b/, category: 'library', minutes: 90, requirements: ['quiet'], fallback: 'Read wherever you are' },
  // Working or studying at a café only when the note says so.
  { words: /^(?=.*\b(deep work|work|study|emails?|laptop|focus|review|write|writing|code|coding)\b)(?=.*\b(cafe|café|coffee shop)(?![a-z]))/, category: 'cafe', minutes: 90, requirements: ['wifi', 'power'], fallback: 'Work wherever you are' },
  // Otherwise it can happen anywhere (home is fine). Asking for Wi-Fi, outlets or quiet turns it into a place to find.
  { words: /\b(deep work|work|study|emails?|laptop|focus|review|write|writing|code|coding)\b/, category: 'none', minutes: 90, work: true },
  { words: /\b(coffee|cafe|café)\b/, category: 'cafe', minutes: 45, fallback: 'Coffee wherever you are' },
  { words: /\b(gym|workout|work out|lift|lifting|weights|yoga|pilates|crossfit)\b/, category: 'gym', minutes: 60, fallback: 'Bodyweight workout where you are' },
  { words: /\b(run|jog|walk|picnic|park|bike ride|cycling)\b/, category: 'park', minutes: 45, requirements: ['outdoor'], fallback: 'Walk around the block' },
  { words: /\b(groceries|grocery|supermarket|market|palengke)\b/, category: 'grocery', minutes: 30, fallback: 'Order delivery', timePref: 'evening' },
  { words: /\b(mall|shopping|shop|buy)\b/, category: 'mall', minutes: 60, fallback: 'Order online' },
  { words: /\b(call|meditate|read|nap|journal|stretch)\b/, category: 'none', minutes: 20 },
];

const REQUIREMENT_WORDS: [RegExp, Requirement][] = [
  [/\bwi-?fi\b/, 'wifi'],
  [/\b(quiet|silent)\b/, 'quiet'],
  [/\b(outlets?|power|charging)\b/, 'power'],
  [/\b(outside|outdoors?)\b/, 'outdoor'],
  [/\b(inside|indoors?)\b/, 'indoor'],
];

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** "5pm" → 17:00. Without am/pm, guess the hour people usually mean during a day. */
function toMinutes(h: number, m: number, ampm: string | undefined, nowMin: number): number | null {
  if (h > 23 || m > 59) return null;
  if (ampm) {
    const pm = ampm.startsWith('p');
    if (h > 12) return null;
    return ((h % 12) + (pm ? 12 : 0)) * 60 + m;
  }
  if (h >= 13 || h === 0) return h * 60 + m;
  if (h === 12) return 12 * 60 + m;
  if (h <= 6) return (h + 12) * 60 + m; // nobody plans "gym at 5" for 5 AM by accident
  // 7–11: morning if it's still ahead today, otherwise evening.
  return h * 60 + m > nowMin ? h * 60 + m : (h + 12) * 60 + m;
}

const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`;
const T = (re: string) => new RegExp(re, 'i');

function clock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${pad(m)}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

function durationLabel(min: number): string {
  if (min < 60) return `${min} min`;
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
}

const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', fifteen: '15', twenty: '20', thirty: '30', forty: '40', 'forty-five': '45', fortyfive: '45', ninety: '90' };

/** "two hours" → "2 hours", "an hour and a half" → "90 min", so durations in words are read too. */
export function durationWords(text: string): string {
  return text
    .replace(/\b(an?|one) hour and a half\b/gi, '90 min')
    .replace(/\b(one|two|three|four|five|six) and a half hours?\b/gi, (_m, n: string) => `${Number(NUMBER_WORDS[n.toLowerCase()]) + 0.5} hours`)
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|fortyfive|forty|ninety)\s+(hours?|hrs?|minutes?|mins?)\b/gi, (_m, n: string, unit: string) => `${NUMBER_WORDS[n.toLowerCase()]} ${unit}`);
}

export function parseQuickAdd(input: string, now = new Date()): QuickAddResult {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  let text = ` ${durationWords(input.trim().replace(/\s+/g, ' '))} `;
  const lower = () => text.toLowerCase();
  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], ' ');
    return m;
  };
  let understood = 0;

  // Repeats every day, or just today
  const repeat = !!take(/\b(every ?day|daily|each day|routine)\b/i);
  if (repeat) understood++;
  take(/\btoday\b/i);

  // Priority
  let priority: Priority = 'should';
  if (take(/(\bmust\b|\bimportant\b|\burgent\b|!+)/i)) {
    priority = 'must';
    understood++;
  } else if (take(/\b(maybe|if (i have )?time|optional|if possible)\b/i)) {
    priority = 'nice';
    understood++;
  }

  // Time range: "3-4pm", "9:30 to 10", "from 3pm until 5"
  let fixedStart: number | undefined;
  let fixedEnd: number | undefined;
  const range = take(T(String.raw`\b(?:from\s+)?${TIME}\s*(?:-|–|—|to|until|till)\s*${TIME}\b`));
  if (range) {
    const endAmPm = range[6]?.toLowerCase();
    const startAmPm = range[3]?.toLowerCase() ?? (endAmPm && Number(range[1]) <= Number(range[4]) ? endAmPm : undefined);
    const s = toMinutes(Number(range[1]), Number(range[2] ?? 0), startAmPm, nowMin);
    const e = toMinutes(Number(range[4]), Number(range[5] ?? 0), endAmPm, nowMin);
    if (s !== null && e !== null && e > s) {
      fixedStart = s;
      fixedEnd = e;
      understood += 2;
    }
  }

  // Windows: "after 5pm", "before 8", "by 6:30"
  let earliest: number | undefined;
  let latest: number | undefined;
  const after = take(T(String.raw`\b(?:after|from|not before)\s+${TIME}\b`));
  if (after) earliest = toMinutes(Number(after[1]), Number(after[2] ?? 0), after[3]?.toLowerCase(), nowMin) ?? undefined;
  const before = take(T(String.raw`\b(?:before|by|until|till|no later than)\s+${TIME}\b`));
  if (before) latest = toMinutes(Number(before[1]), Number(before[2] ?? 0), before[3]?.toLowerCase(), nowMin) ?? undefined;
  if (earliest !== undefined) understood++;
  if (latest !== undefined) understood++;

  // Duration: "1h", "90 min", "1.5 hours", "1h30", "half an hour"
  let minutes: number | undefined;
  const dur = take(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(m|min|mins|minutes)?\b|\b(\d+)\s*(m|min|mins|minutes)\b|\bhalf an? hour\b|\ban hour\b/i);
  if (dur) {
    if (/half/i.test(dur[0])) minutes = 30;
    else if (/^an hour$/i.test(dur[0].trim())) minutes = 60;
    else if (dur[1]) minutes = Math.round(Number(dur[1]) * 60 + Number(dur[3] ?? 0));
    else if (dur[5]) minutes = Number(dur[5]);
    if (minutes !== undefined) {
      minutes = Math.min(720, Math.max(5, Math.round(minutes / 5) * 5));
      understood++;
    }
  }

  // A single time: "at 12:30", "@5pm", "12:30"
  if (fixedStart === undefined) {
    const at = take(T(String.raw`(?:\bat\s+|@\s*|\b)(\d{1,2})(?:[:.](\d{2}))\s*(am|pm)?\b|(?:\bat\s+|@\s*)(\d{1,2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b`));
    if (at) {
      const h = Number(at[1] ?? at[4] ?? at[6]);
      const m = Number(at[2] ?? 0);
      const ampm = (at[3] ?? at[5] ?? at[7])?.toLowerCase();
      const s = toMinutes(h, m, ampm, nowMin);
      if (s !== null) {
        fixedStart = s;
        understood++;
      }
    }
  }

  // Part of the day
  let timePref: TimePref | undefined;
  const part = take(/\b(this )?(morning|afternoon|evening|tonight)\b/i);
  if (part) {
    timePref = part[2]!.toLowerCase() === 'tonight' ? 'evening' : (part[2]!.toLowerCase() as TimePref);
    understood++;
  }

  // Needs
  const requirements = new Set<Requirement>();
  for (const [re, r] of REQUIREMENT_WORDS) {
    if (re.test(lower())) {
      requirements.add(r);
      text = text.replace(new RegExp(re.source, 'i'), ' ');
      understood++;
    }
  }

  // A named place: "at Greenbelt", "at the office". Only kept apart for set-time events.
  let placeName: string | undefined;
  if (fixedStart !== undefined) {
    const at = take(/\b(?:at|in|@)\s+([^,;]+?)\s*$/i);
    if (at) placeName = at[1]!.trim();
  }

  // Kind of thing, from what's left (the title)
  const kind = KINDS.find((k) => k.words.test(lower()));
  if (kind) understood++;

  let title = text
    .replace(/\s+/g, ' ')
    // "I need to study for …" → "Study"
    .replace(/^\s*(i\s+(need|have|want|got|gotta|should|must)\s+to|i'?ll|i\s+will|need\s+to|have\s+to|gotta|remember\s+to)\s+/i, '')
    .replace(/\s+(for|this|the)\s*[.,!?]?\s*$/i, '')
    .replace(/[\s.!?]+$/g, '')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')
    .trim();
  title = title ? title.charAt(0).toUpperCase() + title.slice(1) : '';
  if (!title && kind) title = CATEGORY_LABEL[kind.category];

  const length = minutes ?? kind?.minutes ?? 60;
  const block: StoredBlock = {
    id: newId(),
    title: title.slice(0, 80) || 'Something to do',
    minMinutes: Math.max(5, Math.round((length * 0.75) / 5) * 5),
    maxMinutes: length,
    priority,
    category: kind?.category ?? 'none',
    requirements: [...new Set([...(kind?.requirements ?? []), ...requirements])],
    fallback: kind?.fallback,
    active: true,
  };
  if (kind?.work) {
    // "Study 2h" happens wherever you are; "study 2h with wifi" needs a place that has it.
    const needsNet = requirements.has('wifi') || requirements.has('power');
    if (needsNet || requirements.has('quiet')) {
      block.category = needsNet ? 'cafe' : 'library';
      block.fallback = 'Work wherever you are';
    } else block.requirements = block.requirements.filter((r) => r !== 'indoor' && r !== 'outdoor');
  }
  if (!repeat) block.date = localDate(now);

  const chips: string[] = [];
  if (fixedStart !== undefined) {
    const end = fixedEnd ?? Math.min(fixedStart + length, 24 * 60 - 1);
    block.fixedStart = hm(fixedStart);
    block.fixedEnd = hm(end);
    block.minMinutes = block.maxMinutes = end - fixedStart;
    if (placeName) block.fixedPlace = placeName.slice(0, 80);
    chips.push(`${clock(fixedStart)}–${clock(end)}`);
    if (placeName) chips.push(placeName);
  } else {
    chips.push(durationLabel(length));
    if (earliest !== undefined) block.earliest = hm(earliest);
    if (latest !== undefined) block.latest = hm(latest);
    if (earliest === undefined && latest === undefined && kind?.window) {
      [block.earliest, block.latest] = kind.window;
    }
    if (block.earliest && earliest !== undefined) chips.push(`After ${clock(earliest)}`);
    if (block.latest && latest !== undefined) chips.push(`Before ${clock(latest)}`);
    const pref = timePref ?? kind?.timePref;
    if (pref) {
      block.timePref = pref;
      if (timePref) chips.push(pref.charAt(0).toUpperCase() + pref.slice(1));
    }
    if (block.category !== 'none') chips.push(CATEGORY_LABEL[block.category]);
    for (const r of block.requirements) if (r !== 'outdoor' || requirements.has(r)) chips.push(REQUIREMENT_LABEL[r]);
  }
  if (priority !== 'should') chips.push(PRIORITY_LABEL[priority]);
  chips.push(repeat ? 'Every day' : 'Today only');

  const words = input.trim().split(/\s+/).length;
  return { block, chips, confident: understood > 0 || words <= 3 };
}
