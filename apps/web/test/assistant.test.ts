import { describe, expect, it } from 'vitest';
import type { AlternativeOption, Place, PlanItem } from '@segue/engine';
import { answer, describeOptions, describePlaces, planStamp, type AssistantContext } from '../src/lib/assistant';
import type { AlternativesOutcome } from '../src/lib/alternatives';
import { emptyDay, type StoredBlock } from '../src/lib/model';

// Local times, whatever the machine's time zone.
const t = (h: number, m = 0) => new Date(2026, 9, 27, h, m).toISOString();
const item = (blockId: string, title: string, s: string, e: string, extra: Partial<PlanItem> = {}): PlanItem => ({ blockId, title, start: s, end: e, travelMinutesBefore: 0, confidence: 'no-place', fixed: false, fallbacks: [], ...extra });
const block = (id: string, title: string, category: StoredBlock['category'], extra: Partial<StoredBlock> = {}): StoredBlock => ({ id, title, minMinutes: 45, maxMinutes: 60, priority: 'should', category, requirements: category === 'park' ? ['outdoor'] : [], active: true, ...extra });

const blocks = [block('run', 'Run', 'park'), block('report', 'Write report', 'none'), block('dinner', 'Dinner with Ana', 'none', { fixedStart: '18:30', fixedEnd: '19:30' }), block('read', 'Read', 'none')];
const day = {
  ...emptyDay('2026-10-27'),
  generatedAt: t(14),
  plan: {
    label: 'Balanced',
    items: [
      item('report', 'Write report', t(15), t(16, 30), { explanation: 'Moved from 2:00 PM to 3:00 PM' }),
      item('run', 'Run', t(17), t(17, 45), { place: { id: 'park', name: 'Riverside Park', location: { lat: 14.6, lng: 121 } }, travelMinutesBefore: 10, confidence: 'verified' }),
      item('dinner', 'Dinner with Ana', t(18, 30), t(19, 30), { fixed: true }),
    ],
    unscheduled: [{ blockId: 'read', title: 'Read', reason: 'Not enough time left before 10:00 PM' }],
    score: 0,
    totalTravelMinutes: 10,
  },
  changes: [{ blockId: 'report', title: 'Write report', kind: 'moved' as const, message: 'Moved from 2:00 PM to 3:00 PM' }],
};
const ctx = (extra: Partial<AssistantContext> = {}): AssistantContext => ({
  now: new Date(2026, 9, 27, 14, 30),
  day,
  blocks,
  calendarEvents: [],
  calendarConnected: false,
  endOfDay: t(22),
  ...extra,
});

describe("questions about today's plan", () => {
  it('says what is next, and the next set-time commitment', () => {
    expect(answer("What's next?", ctx()).text).toBe('Next: 3:00 PM–4:30 PM Write report.');
    expect(answer('What is my next commitment?', ctx()).text).toBe('Next: 6:30 PM–7:30 PM Dinner with Ana (set time).');
  });

  it('summarises what is left, including what did not fit and why', () => {
    const r = answer('Summarize my day', ctx());
    expect(r.text).toBe('3 things left today:');
    expect(r.bullets).toContain("Didn't fit: Read (not enough time left before 10:00 PM)");
  });

  it('lists free time, counting the trip before each stop', () => {
    const r = answer('Do I have any free time this afternoon?', ctx());
    expect(r.bullets).toEqual(['2:30 PM–3:00 PM (30 min)', '4:30 PM–4:50 PM (20 min)', '5:45 PM–6:00 PM (15 min)']);
  });

  it('explains a move from the last re-route, and why something does not fit', () => {
    expect(answer('Why did you move my report?', ctx()).text).toBe('Write report is planned 3:00 PM–4:30 PM. In the last re-route: moved from 2:00 PM to 3:00 PM.');
    expect(answer("Why doesn't reading fit?", ctx()).text).toBe("Read isn't in today's plan: not enough time left before 10:00 PM.");
  });

  it('answers "can I finish … before …" from the plan', () => {
    expect(answer('Can I still finish my report before 7 PM?', ctx()).text).toBe('Yes: Write report is planned 3:00 PM–4:30 PM, 2 h 30 min before 7 PM.');
    expect(answer('Can I finish the report before dinner?', ctx()).text).toBe('Yes: Write report is planned 3:00 PM–4:30 PM, 2 h before Dinner with Ana (6:30 PM).');
  });
});

describe('asking it to change things', () => {
  it('refuses to move a set-time commitment, and offers to plan around it', () => {
    const r = answer('Move dinner to 8pm', ctx());
    expect(r.text).toMatch(/^Dinner with Ana is a set-time commitment, so Segue doesn't move it/);
    expect(r.buttons?.[0]?.action).toEqual({ type: 'replan' });
  });

  it('asks before moving something flexible', () => {
    const r = answer('Move the run to 4:30pm', ctx());
    expect(r.buttons?.[0]).toMatchObject({ action: { type: 'move', blockId: 'run', hhmm: '16:30' }, confirm: 'Move Run to 4:30 PM?' });
  });

  it('only proposes a re-route, never applies one', () => {
    expect(answer("Reorganize my remaining day but keep my meetings fixed", ctx()).buttons).toEqual([{ label: 'Show me the proposal', action: { type: 'replan' } }]);
  });

  it('looks up alternatives for the outdoor item when it rains', () => {
    expect(answer("It's raining. What can I do instead of running?", ctx()).run).toEqual({ type: 'options', blockId: 'run', trigger: 'rain', maxMinutes: undefined });
    expect(answer('Move my workout because my meeting is running late', ctx({ blocks: [...blocks, block('gym', 'Gym', 'gym')], day: { ...day, plan: { ...day.plan, items: [...day.plan.items, item('gym', 'Gym', t(20), t(21))] } } })).run).toMatchObject({ type: 'options', blockId: 'gym', trigger: 'late' });
  });

  it('searches for places when asked', () => {
    expect(answer("Find a gym near me that's open now", ctx()).run).toEqual({ type: 'find-places', category: 'gym', openNow: true });
  });
});

describe('follow-ups about options', () => {
  const opt = (id: string, label: string, travel: number): AlternativeOption => ({ id, kind: 'substitute', label, blockId: 'run', title: 'Run', category: 'gym', start: t(17), end: t(17, 45), minutes: 45, travelMinutes: travel, why: 'Open until 10:00 PM by its listed hours', facts: [{ kind: 'hard', text: 'Open until 10:00 PM by its listed hours' }], tradeoffs: ['A gym instead of a park'] });
  const outcome: AlternativesOutcome = {
    result: { blockId: 'run', title: 'Run', trigger: 'rain', options: [opt('a', 'Work out at Pulse instead', 20), opt('b', 'Indoor workout where you are', 0)], excluded: [], notes: [{ kind: 'unknown', text: "Opening times are the places' listed hours, not live availability" }], nextCommitment: { blockId: 'dinner', title: 'Dinner with Ana', start: t(18, 30) } },
    places: {},
    source: 'server',
    warnings: [],
    request: { blocks: [], plan: day.plan, blockId: 'run', context: { now: t(14, 30), endOfDay: t(22), location: { lat: 0, lng: 0 }, energy: 'medium', mode: 'walk', utcOffsetMinutes: 0 } },
  };

  it('describes the options with letters and asks before using one', () => {
    const r = describeOptions(outcome, ctx());
    expect(r.text).toBe("Everything here leaves room for Dinner with Ana at 6:30 PM. Here's what realistically works for Run:");
    expect(r.bullets![0]).toBe('A. Work out at Pulse instead, 5:00 PM–5:45 PM: open until 10:00 PM by its listed hours (trade-off: a gym instead of a park)');
    expect(r.bullets).toContain("Not confirmed: opening times are the places' listed hours, not live availability");
    expect(r.buttons![1]).toMatchObject({ label: 'Use B', action: { type: 'use-option', optionId: 'b' } });
    expect(r.buttons![1]!.confirm).toBeTruthy();
  });

  it('understands "the second option", "closer", "use that one", and "only 30 minutes"', () => {
    const topic = describeOptions(outcome, ctx()).topic!;
    const c = ctx({ options: outcome });
    expect(answer('What about the second option?', c, topic).text).toMatch(/^“Indoor workout where you are”, 5:00 PM–5:45 PM\./);
    expect(answer('Can it be closer?', c, topic).text).toBe('The closest is “Indoor workout where you are”: no trip at all.');
    const use = answer('Okay, use the first one', c, topic);
    expect(use.buttons![0]).toMatchObject({ action: { type: 'use-option', optionId: 'a' } });
    expect(use.text).toMatch(/Nothing changes until you confirm/);
    expect(answer('What if I only have 30 minutes?', c, topic).run).toEqual({ type: 'options', blockId: 'run', trigger: 'rain', maxMinutes: 30 });
  });

  it('notices when the plan changed since, instead of answering from stale options', () => {
    const topic = describeOptions(outcome, ctx()).topic!;
    const changed = { ...day, generatedAt: t(15) };
    const r = answer('Use the first one', ctx({ day: changed, options: outcome }), topic);
    expect(r.text).toMatch(/^Your plan changed since then/);
    expect(r.buttons?.some((b) => b.action.type === 'use-option')).toBeFalsy();
    expect(planStamp(changed)).not.toBe(topic.planStamp);
  });
});

describe('honest limits', () => {
  it('says plainly when it does not know', () => {
    const r = answer('What is the meaning of life?', ctx());
    expect(r.text).toMatch(/^I can only answer from your plan/);
    expect(r.bullets!.length).toBeGreaterThan(3);
  });

  it('does not report stale or missing weather as current', () => {
    expect(answer("What's the weather?", ctx()).text).toBe("I don't have current weather for where you are, so I can't say.");
    expect(answer('Will it rain?', ctx({ weather: { condition: 'rain', known: true, fetchedAt: t(9) } })).text).toBe('The last weather I have is from 9:00 AM, too old to rely on.');
    expect(answer('Will it rain?', ctx({ weather: { condition: 'cloudy', known: true, fetchedAt: t(14), upcoming: [{ time: t(17), rainChance: 70 }] } })).text).toBe("As of 2:00 PM it's cloudy. Rain is likely around 5:00 PM (70%), by the forecast.");
  });

  it('works before there is a plan', () => {
    expect(answer('Why did you move my workout?', ctx({ day: emptyDay('2026-10-27') })).text).toMatch(/^There's no plan for today yet/);
  });

  it('reports sync and calendar status as they are', () => {
    expect(answer('Is my calendar synced?', ctx({ calendarConnected: true, syncStatus: 'offline' })).text).toBe("Google Calendar is connected, read-only: today's timed events are in your plan as set times. You're offline; changes sync when you reconnect.");
  });
});

describe('places', () => {
  const p = (name: string, hours: Place['hours'], extra: Partial<Place> = {}): Place => ({ id: name, name, location: { lat: 0, lng: 0 }, category: 'gym', attributes: {}, hours, source: 'osm', ...extra });
  const daily = (open: string, close: string) => ({ periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open, close })) });
  it('claims "open" only from listed hours and leaves out closed ones when asked for open now', () => {
    const r = describePlaces([p('Shut', daily('06:00', '12:00')), p('Pulse', daily('06:00', '22:00')), p('Mystery', null), p('Paused', daily('06:00', '22:00'), { temporarilyClosed: true })], 'gym', ctx(), { openNow: true, source: 'server' });
    expect(r.bullets).toEqual(['Pulse: open until 10:00 PM (listed hours)', 'Mystery: hours not listed, so it may or may not be open']);
  });
  it('says so when it is working from saved places offline', () => {
    expect(describePlaces([p('Pulse', daily('06:00', '22:00'))], 'gym', ctx(), { openNow: false, source: 'device' }).text).toMatch(/^You're offline, so these are places saved earlier/);
  });
});
