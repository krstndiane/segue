/**
 * Core domain types for the Segue re-routing engine.
 *
 * The engine is pure: no I/O, no clocks, no randomness. Everything it needs
 * arrives through `RerouteInput`, so the same code runs on the server and,
 * offline, on the phone.
 */

export type Priority = 'must' | 'should' | 'nice';
export type Energy = 'low' | 'medium' | 'high';
export type TravelMode = 'walk' | 'transit' | 'drive' | 'local';
export type TimePref = 'morning' | 'afternoon' | 'evening';

/** Things a place can offer. A block lists the ones it needs. */
export type Requirement = 'wifi' | 'quiet' | 'outdoor' | 'power' | 'food' | 'indoor';

/** What kind of place a block happens at. `none` = can be done anywhere. */
export type PlaceCategory =
  | 'none'
  | 'cafe'
  | 'cowork'
  | 'library'
  | 'restaurant'
  | 'gym'
  | 'park'
  | 'grocery'
  | 'mall';

export interface LatLng {
  lat: number;
  lng: number;
}

/** Weekly opening hours in the place's local time. day: 0 = Sunday. */
export interface OpeningPeriod {
  day: number;
  /** "HH:MM", local time */
  open: string;
  /** "HH:MM", local time. A close earlier than open runs past midnight. "24:00" allowed. */
  close: string;
}

export interface OpeningHours {
  /** Always open (24/7). */
  always?: boolean;
  periods: OpeningPeriod[];
}

export interface Place {
  id: string;
  name: string;
  location: LatLng;
  category: PlaceCategory;
  /** true = has it, false = known not to have it, missing = unknown */
  attributes: Partial<Record<Requirement, boolean>>;
  /** null/undefined = hours unknown */
  hours?: OpeningHours | null;
  rating?: number;
  reviewCount?: number;
  address?: string;
  source: string;
  /** ISO time the provider was asked (cached results keep the original time). */
  fetchedAt?: string;
  /** The provider says it's temporarily closed. */
  temporarilyClosed?: boolean;
}

export interface FixedTime {
  /** ISO timestamp */
  start: string;
  /** ISO timestamp */
  end: string;
  location?: LatLng;
  placeName?: string;
}

/** Something the user wants out of the day. Not a place, not a time slot. */
export interface Block {
  id: string;
  title: string;
  minMinutes: number;
  maxMinutes: number;
  priority: Priority;
  category: PlaceCategory;
  requirements: Requirement[];
  /** A meeting or class: it happens at this time no matter what. */
  fixed?: FixedTime;
  /** ISO timestamps bounding when the block may happen. */
  earliest?: string;
  latest?: string;
  timePref?: TimePref;
  /** How much energy the block takes. */
  energy?: Energy;
  /** What to do if no place fits, e.g. "Bodyweight workout at home". */
  fallback?: string;
}

export interface WeatherHour {
  /** ISO timestamp, start of the hour */
  time: string;
  /** 0–100 */
  precipitationProbability: number;
  temperatureC?: number;
}

export interface Context {
  /** ISO timestamp: when the re-route starts. */
  now: string;
  /** ISO timestamp: when the day should end. */
  endOfDay: string;
  location: LatLng;
  energy: Energy;
  mode: TravelMode;
  /** The user's offset from UTC in minutes (Manila = 480). Used for opening hours. */
  utcOffsetMinutes: number;
  weather?: WeatherHour[];
}

export type Confidence = 'verified' | 'unconfirmed' | 'no-place';

export interface PlaceRef {
  id: string;
  name: string;
  location: LatLng;
  address?: string;
}

export interface FallbackOption {
  kind: 'place' | 'no-place';
  place?: PlaceRef;
  label: string;
}

export interface PlanItem {
  blockId: string;
  title: string;
  /** ISO timestamps */
  start: string;
  end: string;
  place?: PlaceRef;
  travelMinutesBefore: number;
  confidence: Confidence;
  fixed: boolean;
  fallbacks: FallbackOption[];
  /** Human-readable reason this item looks the way it does after a re-route. */
  explanation?: string;
  /**
   * A commitment that can't be kept as planned: you can't get there in time,
   * or it overlaps another commitment. It stays in the plan; the user decides.
   */
  conflict?: string;
}

export interface Unscheduled {
  blockId: string;
  title: string;
  reason: string;
}

export interface Plan {
  label: string;
  items: PlanItem[];
  unscheduled: Unscheduled[];
  score: number;
  totalTravelMinutes: number;
}

export type ChangeKind = 'added' | 'removed' | 'moved' | 'place-changed' | 'unchanged';

export interface Change {
  blockId: string;
  title: string;
  kind: ChangeKind;
  message: string;
}

export interface Weights {
  priority: Record<Priority, number>;
  /** score lost per travel minute */
  travelPerMinute: number;
  /** bonus per point of fit (0–1) relative to the priority weight */
  fitShare: number;
  quality: number;
  affinity: number;
  unconfirmedHours: number;
  rain: number;
  energyMismatch: number;
  timePref: number;
  /** extra penalty when a must block cannot be scheduled */
  missingMust: number;
}

/** Door-to-door minutes. `departMs`, when given, lets estimates account for rush hour. */
export type TravelFn = (from: LatLng, to: LatLng, mode: TravelMode, departMs?: number) => number;

export interface RerouteInput {
  blocks: Block[];
  /** Candidate places per block id. Blocks with category `none` need none. */
  candidates: Record<string, Place[]>;
  context: Context;
  /** The plan being replaced, used for the diff and explanations. */
  previous?: Plan;
  /** Block ids the user pinned: keep their time and place from `previous`. */
  lockedBlockIds?: string[];
  /** Block ids already done or skipped today: ignored. */
  doneBlockIds?: string[];
  /** placeId → 0–1, how much the user likes a place (City Kits). */
  affinity?: Record<string, number>;
  weights?: Partial<Weights>;
  /** Override travel-time estimation, e.g. with a real routing matrix. */
  travel?: TravelFn;
  /** Max local-search iterations (keeps runtime bounded). */
  maxIterations?: number;
}

export interface RerouteResult {
  plan: Plan;
  alternatives: Plan[];
  changes: Change[];
}
