/**
 * Turning database rows into what the app sees, and the SQL that decides
 * who can see a note. Everything shown to other people goes through an
 * explicit field list here: never a whole row.
 */
import type { InterestStatus, InvitationStatus, MyProfile, NotifyPrefs, PublicProfile } from '@segue/schemas';

export type Row = Record<string, unknown>;

export const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
export const isoReq = (v: unknown): string => iso(v) ?? new Date(0).toISOString();

/** Public profile columns of table alias `a`, prefixed `a_`. */
export const profileCols = (a: string) =>
  `${a}.id as ${a}_id, ${a}.username as ${a}_username, ${a}.display_name as ${a}_display_name, ${a}.avatar as ${a}_avatar, '' as ${a}_bio`;

export function publicProfile(row: Row, a: string): PublicProfile {
  return {
    id: String(row[`${a}_id`]),
    username: String(row[`${a}_username`]),
    displayName: String(row[`${a}_display_name`]),
    avatar: (row[`${a}_avatar`] as string | null) ?? null,
    bio: String(row[`${a}_bio`] ?? ''),
  };
}

export const DEFAULT_NOTIFY: NotifyPrefs = { hearts: true, invitations: true, shares: true, connections: true };

export function myProfile(row: Row): MyProfile {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    avatar: (row.avatar as string | null) ?? null,
    bio: String(row.bio ?? ''),
    usernameNeedsChange: !!row.username_review,
    pronouns: String(row.pronouns ?? ''),
    interests: (row.interests as string[] | null) ?? [],
    profileVisibility: (row.profile_visibility as MyProfile['profileVisibility']) ?? 'everyone',
    showMutualCount: !!row.show_mutual_count,
    whoCanInvite: (row.who_can_invite as MyProfile['whoCanInvite']) ?? 'everyone',
    discoverable: !!row.discoverable,
    notify: { ...DEFAULT_NOTIFY, ...((row.notify as Partial<NotifyPrefs>) ?? {}) },
    timezone: String(row.timezone ?? 'UTC'),
    createdAt: isoReq(row.created_at),
  };
}

/** SQL: either of a and b has blocked the other. Blocking wins over everything else. */
export const blockedBetween = (a: string, b: string) =>
  `exists (select 1 from segue.user_blocks bb where (bb.blocker_id = ${a} and bb.blocked_id = ${b}) or (bb.blocker_id = ${b} and bb.blocked_id = ${a}))`;

/** SQL: a and b are mutual connections. */
export const mutualWith = (a: string, b: string) =>
  `exists (select 1 from segue.connections mc where mc.status = 'accepted' and ((mc.requester_id = ${a} and mc.recipient_id = ${b}) or (mc.requester_id = ${b} and mc.recipient_id = ${a})))`;

/**
 * True when viewer `v` (a SQL parameter like $1) may read note alias `n`:
 * the author always; others only while it isn't archived, and only if it's
 * discoverable or shared with them.
 */
export const canSeeNote = (n: string, v: string) =>
  `(${n}.author_id = ${v} or (${n}.archived_at is null and not ${blockedBetween(`${n}.author_id`, v)} and (${n}.visibility = 'discoverable' or (${n}.visibility = 'selected' and exists (select 1 from segue.note_shares vs where vs.note_id = ${n}.id and vs.user_id = ${v})))))`;

/** The person behind interest alias `i` can still see note alias `n` (so the author may see their heart). */
export const interestStillVisible = (n: string, i: string) =>
  `(not ${blockedBetween(`${n}.author_id`, `${i}.user_id`)} and (${n}.visibility = 'discoverable' or (${n}.visibility = 'selected' and exists (select 1 from segue.note_shares vs2 where vs2.note_id = ${n}.id and vs2.user_id = ${i}.user_id))))`;

export function invitationStatus(status: unknown, expiresAt: unknown, now = Date.now()): InvitationStatus {
  const s = String(status) as InvitationStatus;
  if (s === 'pending' && expiresAt != null && Date.parse(isoReq(expiresAt)) <= now) return 'expired';
  return s;
}

/** A heart's status follows the invitation it led to, if any. */
export function interestStatus(withdrawnAt: unknown, invStatus: unknown, invExpires: unknown): InterestStatus {
  if (withdrawnAt != null) return 'withdrawn';
  if (invStatus == null) return 'interested';
  switch (invitationStatus(invStatus, invExpires)) {
    case 'pending':
      return 'invited';
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    default:
      // cancelled or expired: back to just interested
      return 'interested';
  }
}

/** For LIKE patterns: the user's text, matched literally. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
