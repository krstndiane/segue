/**
 * Accounts, notes, hearts, invitations and notifications on the wire.
 * Requests are zod schemas (the API validates every one); responses are
 * plain types the web app reads.
 */
import { z } from 'zod';

const isoTimestamp = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'Expected an ISO 8601 timestamp' });
const localDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const uuid = z.string().uuid();
const clientId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
/** Plain text: trimmed, no control characters except newlines and tabs. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim());
const line = (min: number, max: number) => text(max).pipe(z.string().min(min, 'Required').max(max).refine((s) => !/[\r\n]/.test(s), 'One line only'));
const timezone = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);

/**
 * The name as typed (trimmed). The rules in username.ts are applied by the API when a name
 * is created or changed, not here, so an older name that predates them can still be saved
 * unchanged along with other edits, and the person gets a specific message for what's wrong.
 */
export const username = z.string().max(64).transform((s) => s.trim());

export const NotifyPrefsSchema = z.object({
  hearts: z.boolean(),
  invitations: z.boolean(),
  shares: z.boolean(),
  connections: z.boolean(),
});
export type NotifyPrefs = z.infer<typeof NotifyPrefsSchema>;

export const PROFILE_VISIBILITIES = ['everyone', 'mutuals', 'only_me'] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];
export const WHO_CAN_INVITE = ['everyone', 'mutuals', 'nobody'] as const;
export type WhoCanInvite = (typeof WHO_CAN_INVITE)[number];

export const ProfileCreateSchema = z.object({
  username,
  displayName: line(1, 60),
  bio: text(280).optional(),
  /** Photos are uploaded to POST /v1/me/avatar; here a profile can only clear its photo. */
  avatar: z.null().optional(),
  pronouns: line(0, 40).optional(),
  interests: z.array(line(1, 30)).max(10).optional(),
  discoverable: z.boolean().optional(),
  profileVisibility: z.enum(PROFILE_VISIBILITIES).optional(),
  showMutualCount: z.boolean().optional(),
  whoCanInvite: z.enum(WHO_CAN_INVITE).optional(),
  notify: NotifyPrefsSchema.partial().optional(),
  timezone: timezone.optional(),
});
export const ProfileUpdateSchema = ProfileCreateSchema.partial();

/** `today`: what's done and skipped today (not the plan itself, which each device builds). */
export const SYNC_KEYS = ['blocks', 'settings', 'favorites', 'placeHistory', 'dayArchive', 'today'] as const;
export type SyncKey = (typeof SYNC_KEYS)[number];
export const SyncKeySchema = z.enum(SYNC_KEYS);
/** The `today` sync value: which items are done or skipped on one day, and when that last changed. */
export const TodayProgressSchema = z.object({
  date: localDay,
  done: z.array(z.string().max(80)).max(200),
  skipped: z.array(z.string().max(80)).max(200),
  updatedAt: isoTimestamp,
});
export type TodayProgress = z.infer<typeof TodayProgressSchema>;
export const StatePutSchema = z.object({
  value: z.union([z.array(z.unknown()), z.record(z.unknown())]),
  /** The version this device last saw; 0 when it has never been saved. */
  baseVersion: z.number().int().min(0),
});

export const VisibilitySchema = z.enum(['private', 'selected', 'discoverable']);
export type Visibility = z.infer<typeof VisibilitySchema>;

const noteFields = {
  title: line(1, 120),
  body: text(4000),
  visibility: VisibilitySchema,
  onDate: localDay.nullable(),
  placeName: line(1, 120).nullable(),
  blockId: z.string().max(80).nullable(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** People who can see it may ask "Can I join?" (on unless the author turns it off). */
  openToJoin: z.boolean(),
  /** People a "selected" note is shared with. */
  shareWith: z.array(uuid).max(50),
};
export const NoteCreateSchema = z.object(noteFields).partial().required({ title: true }).extend({ clientId: clientId.optional() });
export const NoteUpdateSchema = z.object(noteFields).partial();

export const NOTE_SCOPES = ['mine', 'shared', 'discover', 'hearted'] as const;
export type NoteScope = (typeof NOTE_SCOPES)[number];

const activityFields = {
  title: line(1, 120),
  description: text(2000),
  startsAt: isoTimestamp.nullable(),
  endsAt: isoTimestamp.nullable(),
  timezone,
  placeName: line(1, 120).nullable(),
  meetingNotes: text(500),
};
export const InvitationCreateSchema = z
  .object({
    recipientIds: z.array(uuid).min(1).max(20),
    sourceNoteId: uuid.optional(),
    expiresAt: isoTimestamp.optional(),
    clientId: clientId.optional(),
    ...activityFields,
  })
  .partial({ description: true, startsAt: true, endsAt: true, placeName: true, meetingNotes: true });
export const InvitationUpdateSchema = z.object(activityFields).partial();
export const CounterSchema = z.object({ startsAt: isoTimestamp, endsAt: isoTimestamp.nullable().optional(), note: text(300).optional() });
export const CancelSchema = z.object({ everyone: z.boolean().optional() });
/** Saying yes to "Can I join?": the time and place for the plan you'll do together (optional; the note's place by default). */
export const JoinAcceptSchema = z
  .object({ startsAt: isoTimestamp.nullable(), endsAt: isoTimestamp.nullable(), timezone, placeName: line(1, 120).nullable(), meetingNotes: text(500) })
  .partial()
  .required({ timezone: true });

// ---- Responses ----

export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  bio: string;
}

export interface MyProfile extends PublicProfile {
  /** an older username that doesn't meet today's rules: it still works, but they're asked to pick a new one */
  usernameNeedsChange: boolean;
  pronouns: string;
  interests: string[];
  profileVisibility: ProfileVisibility;
  showMutualCount: boolean;
  whoCanInvite: WhoCanInvite;
  discoverable: boolean;
  notify: NotifyPrefs;
  timezone: string;
  createdAt: string;
}

/** How the signed-in person relates to someone else. */
export type ConnectionState = 'none' | 'mutual' | 'request_sent' | 'request_received' | 'blocked';

/** What a profile page shows: the full card, or only the name and photo when the person keeps it private. */
export interface ProfileCard extends PublicProfile {
  pronouns: string;
  interests: string[];
  /** false when the profile is limited to name and photo for this viewer */
  full: boolean;
  connection: ConnectionState;
  connectionId?: string;
  mutualCount?: number;
}

export interface ConnectionView {
  id: string;
  person: PublicProfile;
  since: string;
}
export interface ConnectionRequestView {
  id: string;
  person: PublicProfile;
  createdAt: string;
}
export interface ConnectionsResponse {
  mutuals: ConnectionView[];
  incoming: ConnectionRequestView[];
  outgoing: ConnectionRequestView[];
  blocked: { person: PublicProfile; since: string }[];
}

export const ConnectionRequestSchema = z.object({ userId: uuid });
export const UserBlockSchema = z.object({ userId: uuid });

export interface MeResponse {
  /** null until the profile is set up */
  profile: MyProfile | null;
  email?: string;
}

export interface StateItem {
  value: unknown;
  version: number;
  updatedAt: string;
}

/** `not_now`: the author said not this time. */
export type InterestStatus = 'interested' | 'invited' | 'accepted' | 'declined' | 'withdrawn' | 'not_now';

export interface NoteView {
  id: string;
  author: PublicProfile;
  title: string;
  body: string;
  visibility: Visibility;
  onDate: string | null;
  placeName: string | null;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  mine: boolean;
  /** whether people who can see it may ask to join */
  openToJoin: boolean;
  /** Only for the author */
  pinned?: boolean;
  blockId?: string | null;
  heartCount?: number;
  sharedWith?: PublicProfile[];
  /** The viewer's own heart, for other people's notes */
  hearted?: boolean;
  interest?: InterestStatus;
}

export interface InterestView {
  id: string;
  user: PublicProfile;
  status: InterestStatus;
  invitationId: string | null;
  createdAt: string;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

export interface ActivityView {
  id: string;
  title: string;
  description: string;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  placeName: string | null;
  meetingNotes: string;
  status: 'active' | 'cancelled';
  /** Only when the viewer can open that note */
  sourceNoteId: string | null;
  updatedAt: string;
}

export interface InvitationView {
  id: string;
  activity: ActivityView;
  sender: PublicProfile;
  recipient: PublicProfile;
  direction: 'sent' | 'received';
  status: InvitationStatus;
  expiresAt: string | null;
  respondedAt: string | null;
  changedFields: string[];
  counter: { startsAt: string; endsAt: string | null; note: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export type NotificationType =
  | 'note_hearted'
  | 'note_shared'
  | 'invitation_received'
  | 'invitation_accepted'
  | 'invitation_declined'
  | 'invitation_cancelled'
  | 'invitation_changed'
  | 'invitation_counter'
  | 'connection_request'
  | 'connection_accepted'
  | 'join_accepted'
  | 'join_declined';

export interface NotificationView {
  id: string;
  type: NotificationType;
  actor: PublicProfile | null;
  entityType: 'note' | 'invitation' | 'connection';
  entityId: string;
  /** Plain words, only naming things the reader may still see */
  text: string;
  /** false when the note or invitation is gone or no longer shared */
  available: boolean;
  readAt: string | null;
  createdAt: string;
}
