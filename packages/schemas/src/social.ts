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

export const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
export const username = z
  .string()
  .transform((s) => s.trim().toLowerCase().replace(/^@/, ''))
  .pipe(z.string().regex(USERNAME_PATTERN, '3 to 24 letters, numbers or underscores'));

/** A small square photo, resized on the phone and stored as a data URL. */
const avatar = z
  .string()
  .max(60_000, 'Photo is too large')
  .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported photo');

export const NotifyPrefsSchema = z.object({
  hearts: z.boolean(),
  invitations: z.boolean(),
  shares: z.boolean(),
});
export type NotifyPrefs = z.infer<typeof NotifyPrefsSchema>;

export const ProfileCreateSchema = z.object({
  username,
  displayName: line(1, 60),
  bio: text(280).optional(),
  avatar: avatar.nullable().optional(),
  discoverable: z.boolean().optional(),
  notify: NotifyPrefsSchema.optional(),
  timezone: timezone.optional(),
});
export const ProfileUpdateSchema = ProfileCreateSchema.partial();

export const SYNC_KEYS = ['blocks', 'settings', 'favorites', 'placeHistory', 'dayArchive'] as const;
export type SyncKey = (typeof SYNC_KEYS)[number];
export const SyncKeySchema = z.enum(SYNC_KEYS);
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

// ---- Responses ----

export interface PublicProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  bio: string;
}

export interface MyProfile extends PublicProfile {
  discoverable: boolean;
  notify: NotifyPrefs;
  timezone: string;
  createdAt: string;
}

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

export type InterestStatus = 'interested' | 'invited' | 'accepted' | 'declined' | 'withdrawn';

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
  | 'invitation_counter';

export interface NotificationView {
  id: string;
  type: NotificationType;
  actor: PublicProfile | null;
  entityType: 'note' | 'invitation';
  entityId: string;
  /** Plain words, only naming things the reader may still see */
  text: string;
  /** false when the note or invitation is gone or no longer shared */
  available: boolean;
  readAt: string | null;
  createdAt: string;
}
