/**
 * The demo: a sample day that runs on Segue's real planner, alternatives
 * engine and Today screen. Everything here is sample data, kept in memory
 * only: nothing is saved, nothing reaches an account or a calendar, and
 * reloading starts it over. Places are real (an OpenStreetMap snapshot near
 * Ayala Avenue, Makati, 29 Oct 2026) and are labelled as a snapshot.
 */
import { alternatives, type AlternativesResult, type Block, type Context, type LatLng, type Place, type PlaceCategory, type Plan, type PlanItem, type WeatherHour } from '@segue/engine';
import type { CalendarEvent } from './calendar';
import { emptyDay, localDate, type DayState } from './model';
import snapshot from './demoPlaces.json';

export const DEMO_SOURCE = 'Sample places: a snapshot of OpenStreetMap near Ayala Avenue, Makati (29 Oct 2026). Opening hours as listed there.';
/** Where the sample day starts: Ayala Avenue, Makati. */
export const DEMO_HOME: LatLng = { lat: 14.5547, lng: 121.0244 };
/** The sample class's campus (a point in Makati; not a real school). */
const CAMPUS: LatLng = { lat: 14.5609, lng: 121.0195 };

export const DEMO_PLACES: Partial<Record<PlaceCategory, Place[]>> = {
  park: snapshot.park as Place[],
  gym: snapshot.gym as Place[],
  mall: snapshot.mall as Place[],
};

/** A clock time on the demo's day (today, in this device's time zone). */
export function demoTime(base: Date, h: number, m = 0): string {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).toISOString();
}

export const DEMO_IDS = { study: 'demo-study', project: 'demo-project', workout: 'demo-workout', class: 'gcal_demo-class', personal: 'demo-personal' } as const;

const park = DEMO_PLACES.park!.find((p) => p.name === 'Ayala Triangle Gardens')!;

export interface DemoState {
  /** the simulated "now" (1:30 PM today) */
  now: Date;
  day: DayState;
  blocks: Block[];
  /** the sample calendar event, shown as calendar events are */
  calendarEvents: CalendarEvent[];
  raining: boolean;
}

/** The sample day, as it stands at 1:30 PM: two things done, a run outdoors at 2, class at 3:30. */
export function demoStart(today = new Date()): DemoState {
  const t = (h: number, m = 0) => demoTime(today, h, m);
  const item = (blockId: string, title: string, s: string, e: string, extra: Partial<PlanItem> = {}): PlanItem => ({ blockId, title, start: s, end: e, travelMinutesBefore: 0, confidence: 'no-place', fixed: false, fallbacks: [], ...extra });
  const plan: Plan = {
    label: 'Balanced',
    items: [
      item(DEMO_IDS.study, 'Study programming', t(9), t(10, 30)),
      item(DEMO_IDS.project, 'Work on a project', t(11), t(12, 30)),
      item(DEMO_IDS.workout, 'Outdoor workout', t(14), t(14, 45), {
        place: { id: park.id, name: park.name, location: park.location },
        travelMinutesBefore: 8,
        confidence: 'verified',
        explanation: 'Open all day by its listed hours',
      }),
      item(DEMO_IDS.class, 'Class', t(15, 30), t(17), { fixed: true }),
      item(DEMO_IDS.personal, 'Personal time', t(18), t(19)),
    ],
    unscheduled: [],
    score: 0,
    totalTravelMinutes: 8,
  };
  const blocks: Block[] = [
    { id: DEMO_IDS.study, title: 'Study programming', minMinutes: 90, maxMinutes: 90, priority: 'should', category: 'none', requirements: [] },
    { id: DEMO_IDS.project, title: 'Work on a project', minMinutes: 90, maxMinutes: 90, priority: 'should', category: 'none', requirements: [] },
    { id: DEMO_IDS.workout, title: 'Outdoor workout', minMinutes: 30, maxMinutes: 45, priority: 'should', category: 'park', requirements: ['outdoor'] },
    { id: DEMO_IDS.class, title: 'Class', minMinutes: 90, maxMinutes: 90, priority: 'must', category: 'none', requirements: [], fixed: { start: t(15, 30), end: t(17), location: CAMPUS, placeName: 'Campus (sample)' } },
    { id: DEMO_IDS.personal, title: 'Personal time', minMinutes: 60, maxMinutes: 60, priority: 'nice', category: 'none', requirements: [] },
  ];
  const day: DayState = { ...emptyDay(localDate(today)), plan, doneIds: [DEMO_IDS.study, DEMO_IDS.project], generatedAt: t(8) };
  return {
    now: new Date(t(13, 30)),
    day,
    blocks,
    calendarEvents: [{ id: 'demo-class', title: 'Class', start: t(15, 30), end: t(17), location: 'Campus (sample calendar event)' }],
    raining: false,
  };
}

/** The sample weather: rain from 1 to 5 PM, clearing after. Labelled as a sample wherever it shows. */
export function demoRain(today: Date): WeatherHour[] {
  return Array.from({ length: 12 }, (_, i) => {
    const h = 12 + i;
    return { time: demoTime(today, h), precipitationProbability: h >= 13 && h < 17 ? 90 : 15 };
  });
}

export function demoContext(s: DemoState): Context {
  return {
    now: s.now.toISOString(),
    endOfDay: demoTime(s.now, 22),
    location: DEMO_HOME,
    energy: 'medium',
    mode: 'local',
    utcOffsetMinutes: -s.now.getTimezoneOffset(),
    weather: s.raining ? demoRain(s.now) : undefined,
  };
}

/** What Segue suggests for the workout once it rains: the real alternatives engine on the sample day. */
export function demoOptions(s: DemoState, places: Partial<Record<PlaceCategory, Place[]>> = DEMO_PLACES, avoid: string[] = []): AlternativesResult {
  return alternatives({
    blocks: s.blocks,
    plan: s.day.plan!,
    blockId: DEMO_IDS.workout,
    context: demoContext(s),
    places,
    trigger: 'rain',
    avoidPlaceIds: avoid,
    doneBlockIds: [...s.day.doneIds, ...s.day.skippedIds],
  });
}
