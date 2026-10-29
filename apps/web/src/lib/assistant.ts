/**
 * The planning assistant's brain, without any AI: it answers from Segue's own
 * plan, reasons, warnings and the alternatives engine, so every sentence can
 * be traced to something the planner worked out. It never changes anything by
 * itself: actions come back as buttons, and the consequential ones ask first.
 *
 * Pure and synchronous. Anything that needs the network (other options, a
 * place search) is returned as `run`, carried out by the panel, and described
 * with `describeOptions` / `describePlaces`.
 */
import { openStatusAt, type AlternativeOption, type AlternativeTrigger, type LatLng, type Place, type PlaceCategory, type PlanItem } from '@segue/engine';
import type { AlternativesOutcome } from './alternatives';
import { calendarBlockId, isCalendarBlock, type CalendarEvent } from './calendar';
import { clock, duration } from './format';
import type { DayState, StoredBlock } from './model';
import type { ReplanReason } from './replan';

export type AssistantAction =
  | { type: 'options'; blockId: string; trigger?: AlternativeTrigger; maxMinutes?: number; /** "I don't want to travel far": closest first */ prefer?: 'near' }
  | { type: 'use-option'; optionId: string }
  /** opens the re-route proposal; `busyUntil` keeps until then blocked ("my meeting is running over until 4:30") */
  | { type: 'replan'; reason?: ReplanReason; busyUntil?: string; busyTitle?: string }
  | { type: 'open-item'; blockId: string }
  | { type: 'move'; blockId: string; hhmm: string }
  | { type: 'find-places'; category: Exclude<PlaceCategory, 'none'>; openNow: boolean; radiusM?: number; needs?: ('wifi' | 'quiet' | 'power')[] };

export interface AssistantButton {
  label: string;
  action: AssistantAction;
  /** asked before anything changes */
  confirm?: string;
}

export interface AssistantReply {
  text: string;
  bullets?: string[];
  buttons?: AssistantButton[];
  /** something to look up first; the panel runs it and then describes the result */
  run?: AssistantAction;
  /** what the conversation is about now, for "it", "that one", "the second option" */
  topic?: Topic;
}

export interface Topic {
  blockId?: string;
  /** the options last shown, in order */
  optionIds?: string[];
  /** the plan this was about; a new plan makes it stale */
  planStamp?: string;
  /** a question we asked and are waiting on: "about when will it end?" */
  awaiting?: 'busy-until';
}

export interface AssistantContext {
  now: Date;
  day: DayState;
  blocks: StoredBlock[];
  /** today's events from a calendar the user connected */
  calendarEvents: CalendarEvent[];
  calendarConnected: boolean;
  /** end of the user's day, ISO */
  endOfDay: string;
  weather?: { condition: string; known: boolean; fetchedAt?: string; upcoming?: { time: string; rainChance: number }[] };
  syncStatus?: 'off' | 'paused' | 'syncing' | 'synced' | 'offline' | 'error';
  /** the options shown last in this conversation */
  options?: AlternativesOutcome | null;
}

const STALE_WEATHER_MS = 3 * 60 * 60_000;
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, one: 0, a: 0, second: 1, '2nd': 1, two: 1, b: 1, third: 2, '3rd': 2, three: 2, c: 2, fourth: 3, '4th': 3, four: 3, d: 3, last: -1 };
const CATEGORY_WORDS: [RegExp, Exclude<PlaceCategory, 'none'>][] = [
  [/\b(gyms?|work ?out|fitness)\b/, 'gym'],
  [/\b(caf(e|é)s?|coffee( shops?)?)/, 'cafe'],
  [/\b(librar(y|ies))\b/, 'library'],
  [/\b(cowork\w*)/, 'cowork'],
  [/\b(parks?)\b/, 'park'],
  [/\b(restaurants?|places? to eat|food)\b/, 'restaurant'],
  [/\b(malls?)\b/, 'mall'],
  [/\b(grocer(y|ies)|supermarkets?)\b/, 'grocery'],
];

export const planStamp = (day: DayState) => `${day.date}:${day.generatedAt ?? ''}:${day.plan?.items.map((i) => i.blockId + i.start + (i.place?.id ?? '')).join(',') ?? ''}`;

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2);

function remaining(ctx: AssistantContext): PlanItem[] {
  const finished = new Set([...ctx.day.doneIds, ...ctx.day.skippedIds]);
  const t = ctx.now.getTime();
  return (ctx.day.plan?.items ?? []).filter((i) => !finished.has(i.blockId) && Date.parse(i.end) > t);
}

function where(i: PlanItem, ctx: AssistantContext): string {
  if (i.place) return ` at ${i.place.name}`;
  if (isCalendarBlock(i.blockId)) {
    const ev = ctx.calendarEvents.find((e) => calendarBlockId(e.id) === i.blockId);
    return ev?.location ? ` at ${ev.location}` : '';
  }
  return '';
}

const line = (i: PlanItem, ctx: AssistantContext) => `${clock(i.start)}–${clock(i.end)} ${i.title}${where(i, ctx)}${i.fixed || isCalendarBlock(i.blockId) ? ' (set time)' : ''}${i.conflict ? `. Heads up: ${i.conflict}` : ''}`;

/** Which item a question is about: a title it mentions, a kind of activity, or the one we were talking about. */
export function itemFor(question: string, ctx: AssistantContext, topic?: Topic): { item?: PlanItem; unscheduled?: { blockId: string; title: string; reason: string }; block?: StoredBlock } {
  const q = norm(question);
  const qw = new Set(words(q));
  const plan = ctx.day.plan;
  const all: { blockId: string; title: string }[] = [...(plan?.items ?? []), ...(plan?.unscheduled ?? [])];
  let best: { id: string; score: number } | undefined;
  const consider = (id: string, score: number) => {
    if (score > 0 && (!best || score > best.score)) best = { id, score };
  };
  for (const x of all) {
    const tw = words(x.title);
    // Whole words count fully; "reading" for "Read" counts half, so a clearer match wins.
    const exact = tw.filter((w) => qw.has(w) || qw.has(`${w}s`) || qw.has(w.replace(/s$/, ''))).length;
    const stem = tw.filter((w) => w.length >= 3 && [...qw].some((v) => v !== w && v.startsWith(w))).length;
    const whole = new RegExp(`(^|[^a-z0-9])${norm(x.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q);
    consider(x.blockId, whole ? 100 : tw.length ? (exact + stem * 0.5) / tw.length : 0);
  }
  // "my workout", "the run": the kind of activity.
  const kind = CATEGORY_WORDS.find(([re]) => re.test(q))?.[1] ?? (/\b(run|jog|walk)\b/.test(q) ? 'park' : undefined);
  const byKind = kind ? ctx.blocks.find((x) => x.category === kind && all.some((a) => a.blockId === x.id)) : undefined;
  if (byKind) consider(byKind.id, 0.75);
  const id = best?.id ?? (/\b(it|that|this|the same)\b/.test(q) ? topic?.blockId : undefined);
  if (!id) return {};
  return {
    item: plan?.items.find((i) => i.blockId === id),
    unscheduled: plan?.unscheduled.find((u) => u.blockId === id),
    block: ctx.blocks.find((b) => b.id === id),
  };
}

function timeIn(question: string, now: Date): string | undefined {
  const m = /\b(?:to|at|for|until|before|by)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i.exec(question);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (h > 23 || min > 59) return undefined;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (!ap && h < 12 && h * 60 + min <= now.getHours() * 60 + now.getMinutes()) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** A bare time in a follow-up: "4:30", "about 5 pm", "in 30 minutes", "half an hour". */
function bareTime(question: string, now: Date): number | undefined {
  const rel = /\bin\s+(\d{1,3})\s*(?:min|mins|minutes)\b/.exec(question)?.[1] ?? (/\b(in )?half an hour\b/.test(question) ? '30' : /\bin (an|one) hour\b/.test(question) ? '60' : undefined);
  if (rel) return now.getTime() + Number(rel) * 60_000;
  const hm = timeIn(question, now) ?? (() => {
    const m = /(?:^|\s|about\s|around\s)(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/.exec(question.trim()) ?? /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/.exec(question.trim());
    return m ? timeIn(`at ${m[1]}${m[2] ? `:${m[2]}` : ''}${m[3] ? ` ${m[3]}` : ''}`, now) : undefined;
  })();
  if (!hm) return undefined;
  const d = new Date(now);
  const [h, m] = hm.split(':').map(Number) as [number, number];
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** "within 1 km", "500 m away", "not far", "walking distance": how far to search, in metres. */
function radiusIn(q: string): number | undefined {
  const m = /\b(?:within|under|less than|no more than|max(?:imum)?)?\s*(\d+(?:\.\d+)?)\s*(km|kilometers?|kilometres?|m|meters?|metres?)\b(?!\w)/.exec(q);
  if (m && !/\b\d+\s*m\b\s*(?:min|minutes)/.test(q)) {
    const n = Number(m[1]) * (/^k/.test(m[2]!) ? 1000 : 1);
    if (n >= 100 && n <= 20000) return n;
  }
  if (/\b(not (too )?far|don'?t want to (travel|go|walk) far|walking distance|close by|nearby|nearest|closest|close to me)\b/.test(q)) return 1000;
  return undefined;
}

const FIXED_WORDS = /\b(meeting|class|lecture|appointment|call|exam|interview|event|shift|session)\b/;
const isSet = (i: PlanItem) => i.fixed || isCalendarBlock(i.blockId);

function freeWindows(ctx: AssistantContext, from: number, to: number): [number, number][] {
  const busy = remaining(ctx)
    .map((i) => [Date.parse(i.start) - i.travelMinutesBefore * 60_000, Date.parse(i.end)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let t = from;
  for (const [s, e] of busy) {
    if (s - t >= 15 * 60_000) out.push([t, Math.min(s, to)]);
    t = Math.max(t, e);
    if (t >= to) break;
  }
  if (to - t >= 15 * 60_000) out.push([t, to]);
  return out.filter(([s, e]) => e - s >= 15 * 60_000 && s < to);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Answer one message. */
export function answer(question: string, ctx: AssistantContext, topic: Topic = {}): AssistantReply {
  const q = norm(question);
  const stamp = planStamp(ctx.day);
  const fresh: Topic = topic.planStamp === stamp ? topic : { planStamp: stamp };
  const followUp = /\b(it|that|this|those|option|options|first|second|third|last|closer|nearer|use|take|instead)\b/.test(q);
  const staleNote = followUp && topic.planStamp && topic.planStamp !== stamp && (topic.optionIds?.length || topic.blockId) ? 'Your plan changed since then, so this is about the latest one. ' : '';
  const reply = (r: AssistantReply): AssistantReply => ({ ...r, text: staleNote + r.text, topic: { ...fresh, ...r.topic, planStamp: stamp } });
  const plan = ctx.day.plan;
  const rest = remaining(ctx);
  const target = itemFor(q, ctx, fresh);

  // Follow-ups about options already shown: "the second one", "use that one", "what would change if I accept option B".
  const opts = fresh.optionIds?.length && ctx.options ? ctx.options.result.options.filter((o) => fresh.optionIds!.includes(o.id)) : [];
  if (opts.length) {
    if (/\b(closer|nearer|less travel|not so far)\b/.test(q)) {
      const sorted = [...opts].sort((a, b) => a.travelMinutes - b.travelMinutes);
      const best = sorted[0]!;
      return reply({ text: best.travelMinutes === 0 ? `The closest is “${best.label}”: no trip at all.` : `The closest option is “${best.label}”, about ${best.travelMinutes} min away.`, buttons: [{ label: 'Use this', action: { type: 'use-option', optionId: best.id }, confirm: `Change ${best.title} to ${best.label}?` }], topic: { optionIds: sorted.map((o) => o.id) } });
    }
    const ord = /\b(?:option\s+)?(first|second|third|fourth|last|1st|2nd|3rd|4th|one|two|three|four|[abcd])\b(?:\s+(?:one|option))?/.exec(q);
    const pick = ord && (/(option|one|first|second|third|fourth|last|1st|2nd|3rd|4th)/.test(q) || /^[abcd]$/.test(ord[1]!)) ? opts.at(ORDINALS[ord[1]!] ?? -99) : /\b(that one|that|this one|it)\b/.test(q) ? opts[0] : undefined;
    if (pick && /\b(use|take|go with|pick|choose|accept|okay|ok|yes|do it)\b/.test(q) && !/\bwhat (would|will) change\b/.test(q)) {
      return reply({ text: `Use “${pick.label}”, ${clock(pick.start)}–${clock(pick.end)}? Nothing changes until you confirm.`, buttons: [{ label: 'Yes, change it', action: { type: 'use-option', optionId: pick.id }, confirm: `Change ${pick.title} to ${pick.label}?` }] });
    }
    if (pick) return reply({ text: describeOne(pick, ctx), bullets: [...pick.facts.map((f) => (f.kind === 'unknown' ? `Not confirmed: ${f.text}` : f.text)), ...pick.tradeoffs.map((t) => `Trade-off: ${t}`)], buttons: [{ label: 'Use this', action: { type: 'use-option', optionId: pick.id }, confirm: `Change ${pick.title} to ${pick.label}?` }] });
    const mins = /\b(\d{1,3})\s*(?:min|minutes|mins)\b/.exec(q)?.[1] ?? (/\bhalf an hour\b/.test(q) ? '30' : /\b(an|one) hour\b/.test(q) ? '60' : undefined);
    if (mins && /\b(only|have|got|just|what if|less time|shorter)\b/.test(q)) {
      return reply({ text: `Checking what fits in ${duration(Number(mins))}…`, run: { type: 'options', blockId: opts[0]!.blockId, trigger: ctx.options!.result.trigger, maxMinutes: Number(mins) } });
    }
    if (/\bwhy\b.*\b(better|best|first|recommend)/.test(q)) {
      const top = opts[0]!;
      return reply({ text: `“${top.label}” came first: ${top.why.charAt(0).toLowerCase() + top.why.slice(1)}.${top.tradeoffs.length ? ` The trade-off: ${top.tradeoffs.join('; ').toLowerCase()}.` : ''}` });
    }
  }

  if (/^(hi|hello|hey|help|what can you do)\b|\bhow do i use you\b/.test(q)) return reply(help());

  // The answer to "about when will it end?".
  if (topic.awaiting === 'busy-until' && plan) {
    const until = bareTime(q, ctx.now);
    const it = plan.items.find((i) => i.blockId === topic.blockId);
    if (until !== undefined) return reply(runningOver(it, until, ctx));
  }

  // "My meeting is running late. Fix my schedule." A set time is never moved: keep the overrun blocked and rebuild the rest.
  const overrun = /\b(running|run|ran|going|went) (late|over|long|overtime)\b|\b(overran|overrunning|took longer|taking longer|delayed)\b/.test(q);
  if (overrun && plan && !/\b(move|reschedule|push|shift)\b/.test(q)) {
    const t = ctx.now.getTime();
    const named = target.item && isSet(target.item) ? target.item : undefined;
    const word = FIXED_WORDS.exec(q)?.[1];
    const byWord = word ? rest.find((i) => isSet(i) && norm(i.title).includes(word)) : undefined;
    // What's running over is usually the set-time thing happening now or that just ended.
    const current = (ctx.day.plan?.items ?? []).filter((i) => isSet(i) && Date.parse(i.start) <= t && Date.parse(i.end) >= t - 30 * 60_000).at(-1);
    const it = named ?? byWord ?? current;
    const isMe = /^i'?m\b|\bi am\b/.test(q) && !word;
    if (isMe) {
      return reply({ text: "I can start the rest of today 15 minutes from now. Set-time commitments stay where they are, and you'll see the proposal before anything changes.", buttons: [{ label: 'Rebuild from 15 min from now', action: { type: 'replan', reason: 'late' } }] });
    }
    const until = bareTime(q.replace(/^.*?\b(until|till|to|ends? at|finish(es)? at|done (at|by))\b/, 'until'), ctx.now);
    if (until !== undefined && /\b(until|till|ends? at|finish(es)? at|done (at|by)|another|more|in)\b/.test(q)) return reply(runningOver(it, until, ctx));
    const thing = it ? it.title : word ? `your ${word}` : 'it';
    return reply({
      text: `About when will ${thing} end? For example “4:30” or “in 30 minutes”. I'll keep that time free and fit the rest around it.${word && !it ? ` (I don't see a ${word} in today's plan, so I'll just keep the time free.)` : ''}`,
      topic: { blockId: it?.blockId, awaiting: 'busy-until' },
    });
  }

  // Sync and calendar.
  if (/\b(sync|synced|syncing|connected|connection)\b/.test(q)) {
    const cal = ctx.calendarConnected ? `Google Calendar is connected, read-only: today's timed events are in your plan as set times.` : `Google Calendar isn't connected, so no calendar events are in your plan.`;
    const acct = { off: "You're not signed in to a Segue account, so plans stay on this device.", paused: 'Account sync is paused on this device.', syncing: 'Your account is syncing now.', synced: 'Your plans are synced with your Segue account.', offline: "You're offline; changes sync when you reconnect.", error: "Account sync hit a problem; it'll try again." }[ctx.syncStatus ?? 'off'];
    return reply({ text: `${cal} ${acct}` });
  }

  // Weather.
  if (/\b(weather|forecast|umbrella|will it rain|is it raining|going to rain)\b/.test(q) && !/\binstead\b/.test(q)) return reply(weather(ctx));

  // Find a kind of place ("a gym near me that's open now", "somewhere quiet"): always a search, even if the plan has one.
  const wantsWifi = /\bwi-?fi|wifi|internet\b/.test(q);
  const wantsQuiet = /\bquiet|silent|focus\b/.test(q);
  const studyish = /\b(study|studying|read|reading|review|reviewing|work on|get work done)\b/.test(q);
  const kindAsked =
    CATEGORY_WORDS.find(([re]) => re.test(q))?.[1] ??
    (wantsQuiet || (studyish && /\b(place|somewhere|spot)\b/.test(q)) ? ('library' as const) : wantsWifi ? ('cafe' as const) : undefined);
  const radiusM = radiusIn(q);
  const searchVerb = /\b(find|search|look for|looking for|show me|any|which|where|somewhere|i need a|need a place|a place)\b/.test(q);
  if (kindAsked && searchVerb && (/\b(open|near|nearby|around|closest|quiet|somewhere|place|spot|indoors?)\b/.test(q) || radiusM !== undefined)) {
    const word = kindAsked === 'cafe' ? 'cafés' : kindAsked === 'library' ? 'libraries' : `${kindAsked}s`;
    const needs = [...(wantsWifi ? (['wifi'] as const) : []), ...(wantsQuiet ? (['quiet'] as const) : [])];
    // Raining with something outdoors still planned: offer to swap that too.
    const outdoor = /\brain/.test(q) ? rest.find((i) => { const b = ctx.blocks.find((x) => x.id === i.blockId); return !!b && !isSet(i) && (b.category === 'park' || b.requirements.includes('outdoor')); }) : undefined;
    return reply({
      text: `Looking for ${word}${radiusM ? ` within ${radiusM >= 1000 ? `${radiusM / 1000} km` : `${radiusM} m`}` : ' near you'}…`,
      run: { type: 'find-places', category: kindAsked, openNow: /\bopen\b/.test(q), radiusM, needs: needs.length ? needs : undefined },
      buttons: outdoor ? [{ label: `Rain options for ${outdoor.title}`, action: { type: 'options', blockId: outdoor.blockId, trigger: 'rain' } }] : undefined,
    });
  }

  if (!plan) {
    return reply({ text: "There's no plan for today yet. Add what's on in plain words (\"Gym 1h after 5pm\"), then tap Plan my day. I can explain it once it's there." });
  }

  // Re-organize the rest of the day.
  if (/\b(reorgani[sz]e|re-?plan|re-?route|rearrange|reshuffle|redo)\b/.test(q)) {
    return reply({ text: 'I can rebuild the rest of today. Set-time commitments and your calendar stay exactly where they are, and you see the proposal before anything changes.', buttons: [{ label: 'Show me the proposal', action: { type: 'replan' } }] });
  }

  // Moving something.
  if (/\b(move|reschedule|push|shift)\b/.test(q) && !/\bwhy\b/.test(q) && target.item) {
    const it = target.item;
    if (it.fixed || isCalendarBlock(it.blockId)) {
      return reply({ text: `${it.title} is a set-time commitment${isCalendarBlock(it.blockId) ? ' from your Google Calendar' : ''}, so Segue doesn't move it${isCalendarBlock(it.blockId) ? ' (it only reads your calendar)' : ''}. If it changed, update it there; I can rebuild everything else around it.`, buttons: [{ label: 'Rebuild around it', action: { type: 'replan' } }], topic: { blockId: it.blockId } });
    }
    const to = timeIn(q, ctx.now);
    if (to) return reply({ text: `Move ${it.title} to ${clockHm(to)} and pin it there? Other things won't move until you re-route.`, buttons: [{ label: `Yes, move to ${clockHm(to)}`, action: { type: 'move', blockId: it.blockId, hhmm: to }, confirm: `Move ${it.title} to ${clockHm(to)}?` }], topic: { blockId: it.blockId } });
    const late = /\b(late|running over|ran over|delayed)\b/.test(q);
    return reply({ text: `Let me check realistic times${late ? ' after the delay' : ''} for ${it.title}…`, run: { type: 'options', blockId: it.blockId, trigger: late ? 'late' : 'manual' }, topic: { blockId: it.blockId } });
  }

  // "That place is closed. Find another one." / "I don't want to travel far.": about the place we were talking about, or the next one.
  const placeItem = () => (target.item?.place ? target.item : undefined) ?? (fresh.blockId ? rest.find((i) => i.blockId === fresh.blockId && i.place) : undefined) ?? rest.find((i) => i.place && !isSet(i));
  if (/\b(closed|shut|not open|isn'?t open|another (one|place|spot)|somewhere else|different place)\b/.test(q) && !target.unscheduled) {
    const it = target.item && !target.item.place && !isSet(target.item) ? target.item : placeItem();
    if (it && !isSet(it)) {
      const closed = /\b(closed|shut|not open|isn'?t open)\b/.test(q);
      return reply({ text: `${closed && it.place ? `Leaving out ${it.place.name}. ` : ''}Checking other realistic options for ${it.title}…`, run: { type: 'options', blockId: it.blockId, trigger: closed ? 'closed' : 'manual' }, topic: { blockId: it.blockId } });
    }
  }
  if (/\b(don'?t|do not|rather not) want to (travel|go|walk|drive) far\b|\btoo far\b|\bstay (close|nearby|near)\b|\bless travel\b/.test(q) && !opts.length) {
    const it = placeItem();
    if (!it) return reply({ text: 'Nothing left today needs a trip, so there is nothing to bring closer.' });
    return reply({ text: `Checking options for ${it.title} with the least travel…`, run: { type: 'options', blockId: it.blockId, prefer: 'near' }, topic: { blockId: it.blockId } });
  }

  // "Why did you recommend this place?"
  if (/\bwhy\b/.test(q) && /\b(place|spot|venue|location|there|recommend\w*|pick\w*|chose|choose|suggest\w*)\b/.test(q) && !/\b(move|moved|fit)\b/.test(q)) {
    const it = placeItem();
    if (it?.place) return reply({ text: whyPlace(it, ctx), buttons: [{ label: 'See other options', action: { type: 'options', blockId: it.blockId } }], topic: { blockId: it.blockId } });
    if (!opts.length) return reply({ text: "Nothing left in today's plan has a place picked, so there's no recommendation to explain." });
  }

  // Instead / other options / rain / closed.
  const wantsOptions = /\b(instead|alternatives?|other options?|what else|another (option|place|gym|cafe)|options? for|other places?)\b/.test(q) || (/\b(rain|raining|closed|shut)\b/.test(q) && !!target.item);
  if (wantsOptions) {
    const it = target.item ?? (/\brain/.test(q) ? rest.find((i) => { const b = ctx.blocks.find((x) => x.id === i.blockId); return !!b && (b.category === 'park' || b.requirements.includes('outdoor')); }) : undefined);
    if (!it) return reply({ text: `Which item do you mean? ${rest.length ? `Today has: ${rest.map((i) => i.title).join(', ')}.` : ''}` });
    if (it.fixed || isCalendarBlock(it.blockId)) return reply({ text: `${it.title} is a set-time commitment, so I won't suggest replacing it.`, topic: { blockId: it.blockId } });
    const trigger: AlternativeTrigger = /\brain/.test(q) ? 'rain' : /\b(closed|shut)\b/.test(q) ? 'closed' : 'manual';
    const mins = /\b(\d{1,3})\s*(?:min|minutes|mins)\b/.exec(q)?.[1];
    return reply({ text: `Checking realistic options for ${it.title}…`, run: { type: 'options', blockId: it.blockId, trigger, maxMinutes: mins ? Number(mins) : undefined }, topic: { blockId: it.blockId } });
  }


  // Why something moved, or doesn't fit.
  if (/\bwhy\b/.test(q) || /\b(doesn'?t|does not|won'?t|can'?t|cannot) (fit|make)\b/.test(q)) {
    if (target.unscheduled) return reply({ text: `${target.unscheduled.title} isn't in today's plan: ${lower(target.unscheduled.reason)}.`, buttons: [{ label: 'Look for a way to fit it', action: { type: 'options', blockId: target.unscheduled.blockId, trigger: 'manual' } }], topic: { blockId: target.unscheduled.blockId } });
    if (target.item) {
      const it = target.item;
      const change = ctx.day.changes.find((c) => c.blockId === it.blockId && c.kind !== 'unchanged');
      const parts = [change ? `In the last re-route: ${lower(change.message)}.` : '', it.conflict ? `Heads up: ${it.conflict}.` : '', it.explanation && !change?.message.includes(it.explanation) ? `${it.explanation}.` : ''].filter(Boolean);
      const base = it.fixed || isCalendarBlock(it.blockId) ? `${it.title} is at a set time (${clock(it.start)}), so it stays put.` : `${it.title} is planned ${clock(it.start)}–${clock(it.end)}${where(it, ctx)}.`;
      return reply({ text: [base, ...parts].join(' '), buttons: it.fixed || isCalendarBlock(it.blockId) ? undefined : [{ label: 'See other options', action: { type: 'options', blockId: it.blockId } }], topic: { blockId: it.blockId } });
    }
    const unfit = plan.unscheduled.filter((u) => !ctx.day.doneIds.includes(u.blockId));
    if (unfit.length) return reply({ text: "Here's what didn't fit today, and why:", bullets: unfit.map((u) => `${u.title}: ${lower(u.reason)}`) });
  }

  // Can I still make it / finish before …?
  if (/\bcan i (still )?(make|finish|get|do|fit|go)\b|\bwill i (make|finish)\b|\benough time\b|\b(need|have|got|want) to (finish|do|get|complete)\b.*\b(before|by)\b|^(please )?(finish|complete|get)\b.*\b(before|by)\b/.test(q)) {
    if (target.unscheduled) return reply({ text: `Not as things stand: ${lower(target.unscheduled.reason)}.`, buttons: [{ label: 'Look for a way', action: { type: 'options', blockId: target.unscheduled.blockId, trigger: 'manual' } }], topic: { blockId: target.unscheduled.blockId } });
    if (target.item) {
      const it = target.item;
      const t = ctx.now.getTime();
      if (Date.parse(it.start) < t && !it.fixed) return reply({ text: `${it.title} was planned for ${clock(it.start)}. Want me to find the next realistic time?`, buttons: [{ label: 'Find a time', action: { type: 'options', blockId: it.blockId, trigger: 'missed' } }], topic: { blockId: it.blockId } });
      if (it.conflict) return reply({ text: `Probably not as planned: ${it.conflict}.`, topic: { blockId: it.blockId } });
      const by = timeIn(q, ctx.now);
      const before = by ? (() => { const d = new Date(ctx.now); const [h, m] = by.split(':').map(Number) as [number, number]; d.setHours(h, m, 0, 0); return d.getTime(); })() : undefined;
      const beforeItem = !by ? rest.find((r) => r.blockId !== it.blockId && Date.parse(r.start) >= Date.parse(it.end) && words(q).some((w) => words(r.title).includes(w))) : undefined;
      const limit = before !== undefined && !Number.isNaN(before) ? before : beforeItem ? Date.parse(beforeItem.start) : undefined;
      const ends = Date.parse(it.end);
      if (limit !== undefined) {
        const spare = Math.round((limit - ends) / 60_000);
        return reply({
          text: spare >= 0 ? `Yes: ${it.title} is planned ${clock(it.start)}–${clock(it.end)}, ${spare ? `${duration(spare)} before` : 'right at'} ${beforeItem ? `${beforeItem.title} (${clock(beforeItem.start)})` : clockHm(by!)}.` : `Not as planned: it ends at ${clock(it.end)}, ${duration(-spare)} after ${beforeItem ? beforeItem.title : clockHm(by!)}.`,
          buttons: spare >= 0 ? undefined : [{ label: 'Find an earlier option', action: { type: 'options', blockId: it.blockId } }],
          topic: { blockId: it.blockId },
        });
      }
      return reply({ text: `Yes: ${line(it, ctx)}${it.travelMinutesBefore ? `, about ${it.travelMinutesBefore} min to get there (estimate)` : ''}. ${it.confidence === 'unconfirmed' ? "Its opening hours aren't listed, so check before you go." : it.confidence === 'verified' && it.place ? `${it.place.name} is open then by its listed hours.` : ''}`.trim(), topic: { blockId: it.blockId } });
    }
  }

  // "I only have 30 minutes before class": what's next, and what fits before it.
  const onlyMins = /\b(?:only|just)\s+(?:have|got)\s+(\d{1,3})\s*(?:min|mins|minutes)\b/.exec(q) ?? /\b(\d{1,3})\s*(?:min|mins|minutes)\s+(?:before|until|till)\b/.exec(q);
  if (onlyMins) {
    const named = rest.find((i) => (i.fixed || isCalendarBlock(i.blockId)) && words(q).some((w) => words(i.title).includes(w)));
    const nextFixed = named ?? rest.find((i) => i.fixed || isCalendarBlock(i.blockId));
    const askedFor = FIXED_WORDS.exec(q)?.[1];
    const missing = askedFor && !named ? `I don't see a ${askedFor} in today's plan. ` : '';
    const mins = Number(onlyMins[1]);
    const t = ctx.now.getTime();
    const until = nextFixed ? Math.round((Date.parse(nextFixed.start) - t) / 60_000) : undefined;
    const before = rest.filter((i) => !i.fixed && !isCalendarBlock(i.blockId) && (!nextFixed || Date.parse(i.start) < Date.parse(nextFixed.start)));
    const fits = before.filter((i) => Math.round((Date.parse(i.end) - Date.parse(i.start)) / 60_000) <= mins);
    const head = nextFixed
      ? until !== undefined && until <= 0
        ? `${nextFixed.title} has started (${clock(nextFixed.start)}).`
        : `${nextFixed.title} is at ${clock(nextFixed.start)}, in ${duration(Math.max(0, until!))}${nextFixed.travelMinutesBefore ? `, and it's about ${nextFixed.travelMinutesBefore} min to get there` : ''}.`
      : 'Nothing else with a set time is on today.';
    const body = before.length
      ? fits.length
        ? `Planned before it and short enough: ${fits.map((i) => `${i.title} (${duration(Math.round((Date.parse(i.end) - Date.parse(i.start)) / 60_000))})`).join(', ')}.`
        : `${before.map((i) => i.title).join(', ')} ${before.length === 1 ? 'is' : 'are'} planned before it but take${before.length === 1 ? 's' : ''} longer than ${duration(mins)}.`
      : `Nothing else is planned before it, so the ${duration(mins)} is free.`;
    return reply({
      text: `${missing}${head} ${body}`,
      buttons: before.length && !fits.length ? [{ label: `Options for ${before[0]!.title} in ${duration(mins)}`, action: { type: 'options', blockId: before[0]!.blockId, maxMinutes: mins } }] : undefined,
      topic: nextFixed ? { blockId: nextFixed.blockId } : undefined,
    });
  }

  // Free time.
  if (/\b(free|gap|gaps|available|spare time|downtime|nothing on)\b/.test(q)) {
    const t = ctx.now.getTime();
    const end = Date.parse(ctx.endOfDay);
    const span = /\bmorning\b/.test(q) ? [6, 12] : /\bafternoon\b/.test(q) ? [12, 18] : /\b(evening|tonight)\b/.test(q) ? [18, 24] : undefined;
    const day0 = new Date(ctx.now);
    day0.setHours(0, 0, 0, 0);
    const from = Math.max(t, span ? day0.getTime() + span[0]! * 3_600_000 : t);
    const to = Math.min(end, span ? day0.getTime() + span[1]! * 3_600_000 : end);
    if (to <= from) return reply({ text: span ? `That part of the day is ${to <= t ? 'already over' : 'after your day ends'}.` : 'Your day is over.' });
    const w = freeWindows(ctx, from, to);
    return reply(w.length ? { text: `Free${span ? ` this ${q.match(/morning|afternoon|evening|tonight/)![0]}` : ' for the rest of today'}:`, bullets: w.map(([s, e]) => `${clock(iso(s))}–${clock(iso(e))} (${duration(Math.round((e - s) / 60_000))})`) } : { text: 'No free stretch of 15 minutes or more then.' });
  }

  // Next.
  if (/\bnext\b|\bcoming up\b|\bwhat now\b/.test(q)) {
    const wantFixed = /\b(commitment|meeting|appointment|class|event)\b/.test(q);
    const n = wantFixed ? rest.find((i) => i.fixed || isCalendarBlock(i.blockId)) : rest[0];
    if (!n) return reply({ text: wantFixed ? 'No more set-time commitments today.' : "Nothing else is planned today." });
    const live = Date.parse(n.start) <= ctx.now.getTime();
    return reply({ text: `${live ? 'Now' : 'Next'}: ${line(n, ctx)}.${n.travelMinutesBefore && !live ? ` About ${n.travelMinutesBefore} min to get there (estimate).` : ''}`, buttons: [{ label: 'Details', action: { type: 'open-item', blockId: n.blockId } }], topic: { blockId: n.blockId } });
  }

  // Today / summary.
  if (/\b(today|my (plan|day|schedule)|summar\w*|what('s| is) (on|left|planned)|rest of (the|my) day|agenda)\b/.test(q)) {
    const done = ctx.day.doneIds.length;
    const unfit = plan.unscheduled.filter((u) => !ctx.day.doneIds.includes(u.blockId));
    return reply({
      text: rest.length ? `${rest.length} thing${rest.length === 1 ? '' : 's'} left today${done ? `, ${done} done` : ''}:` : `Nothing left on today's plan${done ? ` (${done} done)` : ''}.`,
      bullets: [...rest.map((i) => line(i, ctx)), ...unfit.map((u) => `Didn't fit: ${u.title} (${lower(u.reason)})`)],
    });
  }

  if (target.item || target.unscheduled) {
    const it = target.item;
    if (it) return reply({ text: `${line(it, ctx)}.${it.explanation ? ` ${it.explanation}.` : ''}`, buttons: [{ label: 'Details', action: { type: 'open-item', blockId: it.blockId } }], topic: { blockId: it.blockId } });
    return reply({ text: `${target.unscheduled!.title} isn't in today's plan: ${lower(target.unscheduled!.reason)}.`, topic: { blockId: target.unscheduled!.blockId } });
  }

  // "I need to study for two hours": that's something to add, which happens in the Add bar.
  if (/^(i (need|have|want|got|gotta|should|must) to|i'?ll|add|plan|schedule|remind me to)\b/.test(q) && !/\?$/.test(q)) {
    return reply({ text: "I can't add things to your day from here yet. Type it into the Add bar on Today (for example \"Study 2h\") and Segue plans it in; then ask me about it." });
  }

  return reply({ ...help(), text: "I can only answer from your plan, and I didn't catch what you're asking. Try one of these:" });
}

function runningOver(it: PlanItem | undefined, until: number, ctx: AssistantContext): AssistantReply {
  const t = ctx.now.getTime();
  if (until <= t + 4 * 60_000) return { text: "That's already now, so there's nothing to keep free. Tap Re-route if the rest of the day needs rebuilding.", buttons: [{ label: 'Show me the proposal', action: { type: 'replan' } }] };
  const end = Date.parse(ctx.endOfDay);
  if (until >= end) return { text: `That runs past the end of your day (${clock(ctx.endOfDay)}), so nothing else would fit today.` };
  const title = it ? `${it.title} running over` : 'Running over';
  const hit = remaining(ctx).filter((i) => i.blockId !== it?.blockId && Date.parse(i.start) < until);
  const setHit = hit.filter(isSet).map((i) => i.title);
  return {
    text: `Keep ${clock(iso(t))}–${clock(iso(until))} free for ${it ? it.title : 'that'} and rebuild the rest? ${setHit.length ? `${setHit.join(', ')} ${setHit.length === 1 ? 'stays' : 'stay'} at ${setHit.length === 1 ? 'its' : 'their'} set time and will show as overlapping. ` : ''}${hit.length - setHit.length ? `${hit.filter((i) => !isSet(i)).map((i) => i.title).join(', ')} will move later or say why it can't. ` : ''}You'll see the proposal first.`,
    buttons: [{ label: `Keep until ${clock(iso(until))} free`, action: { type: 'replan', busyUntil: iso(until), busyTitle: title } }],
    topic: { blockId: it?.blockId },
  };
}

/** Why the plan picked this place, from what the planner knows (never more). */
function whyPlace(it: PlanItem, ctx: AssistantContext): string {
  const b = ctx.blocks.find((x) => x.id === it.blockId);
  const kind = b && b.category !== 'none' ? ({ cafe: 'a café', cowork: 'a coworking space', library: 'a library', restaurant: 'a place to eat', gym: 'a gym', park: 'a park', grocery: 'a grocery', mall: 'a mall' } as Record<string, string>)[b.category] : undefined;
  const needs = b?.requirements.filter((r) => r !== 'outdoor' && r !== 'indoor') ?? [];
  const parts = [
    kind ? `${it.title} needs ${kind}${needs.length ? ` with ${needs.join(' and ').replace('wifi', 'Wi-Fi')}` : ''}, and ${it.place!.name} is one` : `${it.place!.name} fits ${it.title}`,
    it.travelMinutesBefore ? `about ${it.travelMinutesBefore} min to get there (an estimate, not live traffic)` : 'no trip from where you are before it',
    it.confidence === 'verified' ? 'open then by its listed hours' : "its opening hours aren't listed, so check before you go",
  ];
  const others = it.fallbacks.filter((f) => f.kind === 'place' && f.place).map((f) => f.place!.name).slice(0, 2);
  return `${parts.join('; ')}.${it.explanation ? ` ${it.explanation}.` : ''}${others.length ? ` Backups if it doesn't work out: ${others.join(', ')}.` : ''}`;
}

function help(): AssistantReply {
  return {
    text: 'I answer from your plan, its reasons and live checks on places and weather. Things I can do:',
    bullets: ["What's next? / What's my next commitment?", 'Do I have free time this afternoon?', 'Why did you move my workout? / Why does this not fit?', "It's raining. What can I do instead of running?", 'Find a gym open now', 'Can I still finish my report before 7 PM?', 'Reorganize the rest of my day'],
  };
}

function weather(ctx: AssistantContext): AssistantReply {
  const w = ctx.weather;
  if (!w?.known || !w.fetchedAt) return { text: "I don't have current weather for where you are, so I can't say." };
  const age = ctx.now.getTime() - Date.parse(w.fetchedAt);
  if (age > STALE_WEATHER_MS) return { text: `The last weather I have is from ${clock(w.fetchedAt)}, too old to rely on.` };
  const nowWord = { clear: 'clear', 'partly-cloudy': 'partly cloudy', cloudy: 'cloudy', fog: 'foggy', rain: 'raining', 'heavy-rain': 'raining heavily', storm: 'stormy' }[w.condition] ?? w.condition;
  const wet = (w.upcoming ?? []).filter((h) => h.rainChance >= 50 && Date.parse(h.time) > ctx.now.getTime() - 3_600_000);
  const later = wet.length ? ` Rain is likely around ${wet.slice(0, 3).map((h) => `${clock(h.time)} (${h.rainChance}%)`).join(', ')}, by the forecast.` : (w.upcoming?.length ? ' No rain likely in the next hours, by the forecast.' : '');
  return { text: `As of ${clock(w.fetchedAt)} it's ${nowWord}.${later}` };
}

function metres(a: LatLng, b: LatLng): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
function clockHm(hm: string) {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

function describeOne(o: AlternativeOption, ctx: AssistantContext): string {
  const original = ctx.day.plan?.items.find((i) => i.blockId === o.blockId);
  const changes = [o.start !== original?.start ? `starts at ${clock(o.start)} instead of ${original ? clock(original.start) : 'not at all'}` : '', o.place?.id !== original?.place?.id ? (o.place ? `is at ${o.place.name}` : 'needs no trip') : ''].filter(Boolean);
  return `“${o.label}”, ${clock(o.start)}–${clock(o.end)}.${changes.length ? ` Compared with now, it ${changes.join(' and ')}.` : ''} Nothing else in your day moves.`;
}

/** Say what the alternatives engine found, in the chat. */
export function describeOptions(o: AlternativesOutcome, ctx: AssistantContext, how: { prefer?: 'near' } = {}): AssistantReply {
  const r = how.prefer === 'near' ? { ...o.result, options: [...o.result.options].sort((a, b) => a.travelMinutes - b.travelMinutes) } : o.result;
  const stamp = planStamp(ctx.day);
  const head = [o.warnings.join(' '), r.problem ? `${r.problem.text}.` : '', r.nextCommitment ? `Everything here leaves room for ${r.nextCommitment.title} at ${clock(r.nextCommitment.start)}.` : ''].filter(Boolean).join(' ');
  if (!r.options.length) {
    return {
      text: [head, r.notes.find((n) => n.kind === 'hard' || n.kind === 'tip')?.text ? `${r.notes.find((n) => n.kind === 'hard' || n.kind === 'tip')!.text}.` : "I couldn't find a realistic option."].filter(Boolean).join(' '),
      bullets: r.excluded.slice(0, 4).map((e) => `${e.label}: ${lower(e.reason)}`),
      topic: { blockId: r.blockId, optionIds: [], planStamp: stamp },
    };
  }
  const letters = ['A', 'B', 'C', 'D'];
  return {
    text: `${head ? `${head} ` : ''}Here's what realistically works for ${r.title}${how.prefer === 'near' ? ', least travel first' : ''}:`,
    bullets: [
      ...r.options.map((x, i) => `${letters[i]}. ${x.label}, ${clock(x.start)}–${clock(x.end)}${how.prefer === 'near' ? (x.travelMinutes ? ` (about ${x.travelMinutes} min away)` : ' (no trip)') : ''}: ${lower(x.why)}${x.tradeoffs.length ? ` (trade-off: ${x.tradeoffs.join('; ').toLowerCase()})` : ''}`),
      ...r.notes.filter((n) => n.kind === 'unknown').map((n) => `Not confirmed: ${lower(n.text)}`),
    ],
    buttons: r.options.map((x, i) => ({ label: `Use ${letters[i]}`, action: { type: 'use-option' as const, optionId: x.id }, confirm: `Change ${x.title} to ${x.label}, ${clock(x.start)}–${clock(x.end)}?` })),
    topic: { blockId: r.blockId, optionIds: r.options.map((x) => x.id), planStamp: stamp },
  };
}

/** Say what a place search found, only claiming "open" from listed hours. */
export function describePlaces(
  places: Place[],
  category: PlaceCategory,
  ctx: AssistantContext,
  opts: { openNow: boolean; source: 'server' | 'device'; origin?: LatLng; radiusM?: number; needs?: ('wifi' | 'quiet' | 'power')[] },
): AssistantReply {
  const t = ctx.now.getTime();
  const tz = -ctx.now.getTimezoneOffset();
  const word = category === 'cafe' ? 'cafés' : category === 'library' ? 'libraries' : `${category}s`;
  const away = (p: Place) => (opts.origin ? metres(opts.origin, p.location) : undefined);
  const needs = opts.needs ?? [];
  const listed = (p: Place) => needs.filter((n) => p.attributes?.[n]).length;
  const within = opts.radiusM ? ` within ${opts.radiusM >= 1000 ? `${opts.radiusM / 1000} km` : `${opts.radiusM} m`}` : ' near you';
  const rows = places
    .filter((p) => p.source !== 'mock' || opts.source === 'server')
    .map((p) => ({ p, st: openStatusAt(p, t, tz), d: away(p) }))
    .filter((x) => !opts.radiusM || x.d === undefined || x.d <= opts.radiusM)
    .filter((x) => !opts.openNow || x.st.status !== 'closed')
    .filter((x) => x.st.status !== 'temporarily-closed')
    // Listed as having what you asked for first, then open by listed hours, then nearest.
    .sort((a, b) => listed(b.p) - listed(a.p) || (a.st.status === 'open' ? 0 : 1) - (b.st.status === 'open' ? 0 : 1) || (a.d ?? 0) - (b.d ?? 0))
    .slice(0, 5);
  if (!rows.length) return { text: `I couldn't find ${opts.openNow ? 'any ' : ''}${word}${opts.openNow ? ' open now' : ''}${within}${opts.source === 'device' ? " among the places saved on this phone (you're offline)" : ''}.` };
  const needWords = needs.map((n) => (n === 'wifi' ? 'Wi-Fi' : n === 'power' ? 'outlets' : 'quiet'));
  const noneListed = needs.length && !rows.some((x) => listed(x.p));
  const age = places[0]?.fetchedAt ? Math.round((t - Date.parse(places[0].fetchedAt)) / 60_000) : undefined;
  return {
    text: `${opts.source === 'device' ? "You're offline, so these are places saved earlier. " : ''}${within.trim().replace(/^./, (c) => c.toUpperCase())}${opts.openNow ? ', by their listed hours' : ''}:`,
    bullets: [
      ...rows.map(({ p, st, d }) => `${p.name}${d !== undefined ? ` (${d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`})` : ''}${needs.length && listed(p) ? ` · ${needWords.filter((_, i) => p.attributes?.[needs[i]!]).join(', ')} listed` : ''}: ${st.status === 'open' ? (st.closesAt === null ? 'open 24 hours (listed)' : `open until ${clock(iso(st.closesAt!))} (listed hours)`) : st.status === 'closed' ? `closed now${st.opensAt ? `, opens ${clock(iso(st.opensAt))}` : ''} (listed hours)` : "hours not listed, so it may or may not be open"}`),
      ...(noneListed ? [`None of these list ${needWords.join(' or ')} on the map, so check before you go.`] : []),
      ...(age !== undefined && age > 60 ? [`Map data from about ${duration(Math.min(age, 24 * 60))} ago.`] : []),
    ],
  };
}

/** The least the AI mode needs to answer: today's items, reasons and options. No location, notes or other days. */
export function snapshotFor(ctx: AssistantContext) {
  const finished = (id: string) => (ctx.day.doneIds.includes(id) ? 'done' : ctx.day.skippedIds.includes(id) ? 'skipped' : 'planned') as 'done' | 'skipped' | 'planned';
  const cut = (s: string | undefined, n: number) => (s ? s.slice(0, n) : undefined);
  return {
    now: ctx.now.toISOString(),
    endOfDay: ctx.endOfDay,
    items: (ctx.day.plan?.items ?? []).slice(0, 40).map((i) => ({
      id: i.blockId.slice(0, 120),
      title: i.title.slice(0, 120),
      start: i.start,
      end: i.end,
      place: cut(i.place?.name, 160),
      fixed: i.fixed,
      calendar: isCalendarBlock(i.blockId),
      status: finished(i.blockId),
      conflict: cut(i.conflict, 240),
      explanation: cut(i.explanation, 300),
    })),
    unscheduled: (ctx.day.plan?.unscheduled ?? []).slice(0, 30).map((u) => ({ id: u.blockId.slice(0, 120), title: u.title.slice(0, 120), reason: u.reason.slice(0, 240) })),
    changes: ctx.day.changes.filter((c) => c.kind !== 'unchanged').slice(0, 30).map((c) => ({ title: c.title.slice(0, 120), message: c.message.slice(0, 240) })),
    options: (ctx.options?.result.options ?? []).slice(0, 4).map((o) => ({ id: o.id.slice(0, 300), label: o.label.slice(0, 200), start: o.start, end: o.end, why: o.why.slice(0, 400), facts: o.facts.slice(0, 10).map((f) => (f.kind === 'unknown' ? `Not confirmed: ${f.text}` : f.text).slice(0, 240)), tradeoffs: o.tradeoffs.slice(0, 5).map((t) => t.slice(0, 200)) })),
    weather: cut(weather(ctx).text, 300),
  };
}
