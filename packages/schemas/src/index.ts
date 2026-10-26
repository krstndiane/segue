/**
 * Wire schemas. The API validates every request with these, and the web app
 * validates what it reads back from local storage.
 */
import { z } from 'zod';
import type { Block, Context, LatLng, OpeningHours, Place, Plan } from '@segue/engine';
import type { CurrentWeather, SkyCondition } from '@segue/providers';

const isoTimestamp = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Expected an ISO 8601 timestamp' });
const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'Expected HH:MM');

export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}) satisfies z.ZodType<LatLng>;

export const PrioritySchema = z.enum(['must', 'should', 'nice']);
export const EnergySchema = z.enum(['low', 'medium', 'high']);
export const TravelModeSchema = z.enum(['walk', 'transit', 'drive', 'local']);
export const TimePrefSchema = z.enum(['morning', 'afternoon', 'evening']);
export const RequirementSchema = z.enum(['wifi', 'quiet', 'outdoor', 'power', 'food', 'indoor']);
export const PlaceCategorySchema = z.enum(['none', 'cafe', 'cowork', 'library', 'restaurant', 'gym', 'park', 'grocery', 'mall']);
export const SearchableCategorySchema = PlaceCategorySchema.exclude(['none']);

export const OpeningHoursSchema = z.object({
  always: z.boolean().optional(),
  periods: z.array(z.object({ day: z.number().int().min(0).max(6), open: hhmm, close: hhmm })),
}) satisfies z.ZodType<OpeningHours>;

export const PlaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  location: LatLngSchema,
  category: PlaceCategorySchema,
  attributes: z.record(RequirementSchema, z.boolean()),
  hours: OpeningHoursSchema.nullable().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  address: z.string().optional(),
  source: z.string(),
  fetchedAt: isoTimestamp.optional(),
  temporarilyClosed: z.boolean().optional(),
}) satisfies z.ZodType<Place>;

export const BlockSchema = z
  .object({
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(80),
    minMinutes: z.number().int().min(5).max(720),
    maxMinutes: z.number().int().min(5).max(720),
    priority: PrioritySchema,
    category: PlaceCategorySchema,
    requirements: z.array(RequirementSchema).max(6),
    fixed: z
      .object({ start: isoTimestamp, end: isoTimestamp, location: LatLngSchema.optional(), placeName: z.string().max(80).optional() })
      .refine((f) => Date.parse(f.end) > Date.parse(f.start), { message: 'Fixed end must be after start' })
      .optional(),
    earliest: isoTimestamp.optional(),
    latest: isoTimestamp.optional(),
    timePref: TimePrefSchema.optional(),
    energy: EnergySchema.optional(),
    fallback: z.string().max(120).optional(),
  })
  .refine((b) => b.maxMinutes >= b.minMinutes, { message: 'maxMinutes must be ≥ minMinutes', path: ['maxMinutes'] }) satisfies z.ZodType<Block>;

export const WeatherHourSchema = z.object({
  time: isoTimestamp,
  precipitationProbability: z.number().min(0).max(100),
  temperatureC: z.number().optional(),
});

export const ContextSchema = z
  .object({
    now: isoTimestamp,
    endOfDay: isoTimestamp,
    location: LatLngSchema,
    energy: EnergySchema,
    mode: TravelModeSchema,
    utcOffsetMinutes: z.number().int().min(-720).max(840),
    weather: z.array(WeatherHourSchema).max(96).optional(),
  })
  .refine((c) => Date.parse(c.endOfDay) > Date.parse(c.now), { message: 'endOfDay must be after now', path: ['endOfDay'] }) satisfies z.ZodType<Context>;

const PlaceRefSchema = z.object({ id: z.string(), name: z.string(), location: LatLngSchema, address: z.string().optional() });

export const PlanItemSchema = z.object({
  blockId: z.string(),
  title: z.string(),
  start: isoTimestamp,
  end: isoTimestamp,
  place: PlaceRefSchema.optional(),
  travelMinutesBefore: z.number(),
  confidence: z.enum(['verified', 'unconfirmed', 'no-place']),
  fixed: z.boolean(),
  fallbacks: z.array(z.object({ kind: z.enum(['place', 'no-place']), place: PlaceRefSchema.optional(), label: z.string() })),
  explanation: z.string().optional(),
  conflict: z.string().optional(),
});

export const PlanSchema = z.object({
  label: z.string(),
  items: z.array(PlanItemSchema),
  unscheduled: z.array(z.object({ blockId: z.string(), title: z.string(), reason: z.string() })),
  score: z.number(),
  totalTravelMinutes: z.number(),
}) satisfies z.ZodType<Plan>;

export const RerouteRequestSchema = z.object({
  blocks: z.array(BlockSchema).min(1).max(30),
  context: ContextSchema,
  previous: PlanSchema.optional(),
  lockedBlockIds: z.array(z.string()).max(30).optional(),
  doneBlockIds: z.array(z.string()).max(30).optional(),
  affinity: z.record(z.string(), z.number().min(0).max(1)).optional(),
  /** Skip the server's place search and use these (e.g. from the phone's cache). */
  candidates: z.record(z.string(), z.array(PlaceSchema).max(40)).optional(),
  /** The user's saved places ("My spots"): always considered for blocks of their category. */
  favorites: z.array(PlaceSchema).max(30).optional(),
});

export const AlternativesRequestSchema = z.object({
  blocks: z.array(BlockSchema).min(1).max(30),
  plan: PlanSchema,
  blockId: z.string().min(1).max(80),
  context: ContextSchema,
  trigger: z.enum(['rain', 'closed', 'late', 'missed', 'manual']).optional(),
  /** the user said it's raining (until about then) */
  rainingUntil: isoTimestamp.optional(),
  avoidPlaceIds: z.array(z.string().max(200)).max(30).optional(),
  /** "I only have 30 minutes" */
  maxMinutes: z.number().int().min(5).max(720).optional(),
  doneBlockIds: z.array(z.string()).max(30).optional(),
  favorites: z.array(PlaceSchema).max(30).optional(),
});
export type AlternativesRequest = z.infer<typeof AlternativesRequestSchema>;

export const UnderstandRequestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  /** the user's local wall-clock time, e.g. "Monday 14:05" */
  localTime: z.string().max(40),
});

export const NearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  category: SearchableCategorySchema,
  radius: z.coerce.number().int().min(100).max(20000).default(1500),
  limit: z.coerce.number().int().min(1).max(40).default(20),
});

export type RerouteRequest = z.infer<typeof RerouteRequestSchema>;
export type NearbyQuery = z.infer<typeof NearbyQuerySchema>;
export type SearchableCategory = z.infer<typeof SearchableCategorySchema>;

/** The skies the app can draw; keep in step with SkyCondition in packages/providers and SKY_CONDITIONS in apps/web. */
export const SKY_CONDITION_VALUES = ['clear', 'partly-cloudy', 'cloudy', 'fog', 'rain', 'heavy-rain', 'storm'] as const;
export const SkyConditionSchema = z.enum(SKY_CONDITION_VALUES) satisfies z.ZodType<SkyCondition>;

/** The body of GET /v1/weather/now. */
export const CurrentWeatherSchema = z.object({
  condition: SkyConditionSchema,
  isDay: z.boolean(),
  temperatureC: z.number().optional(),
  feelsLikeC: z.number().optional(),
  uvIndex: z.number().min(0).optional(),
  gustKmh: z.number().min(0).optional(),
  precipitationMm: z.number().min(0).optional(),
  observedAt: isoTimestamp,
  utcOffsetMinutes: z.number().int().min(-720).max(840).optional(),
  timezone: z.string().max(64).optional(),
  upcoming: z
    .array(
      z.object({
        time: isoTimestamp,
        rainChance: z.number().min(0).max(100),
        uvIndex: z.number().min(0).optional(),
        feelsLikeC: z.number().optional(),
      }),
    )
    .max(48)
    .optional(),
}) satisfies z.ZodType<CurrentWeather>;

/** Flatten a ZodError into `path: message` lines for API error responses. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

export * from './social';
export { z };
export * from './username';
