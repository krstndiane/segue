/** Shared pieces for the social routes (kept apart from the router to avoid an import loop). */
import type { IncomingMessage } from 'node:http';
import type { AuthUser, Verifier } from '../auth';
import type { Db } from '../db';
import { HttpError } from '../http';
import type { AvatarStorage } from './avatars';
import type { Row } from './views';

export interface SocialDeps {
  db: Db;
  verifier: Verifier;
  /** Removes the sign-in when someone deletes their account; false if it couldn't. */
  deleteAuthUser?: (userId: string) => Promise<boolean>;
  /** Where profile pictures are kept; without it, photo upload answers 503 "avatars_off". */
  avatars?: AvatarStorage;
  limits?: { writesPerHour?: number; searchesPerHour?: number; syncWritesPerHour?: number; usernameChecksPerHour?: number };
  /** Extra reserved usernames on top of the built-in list (RESERVED_USERNAMES). */
  reservedUsernames?: string[];
  log?: (line: string) => void;
  now?: () => number;
}

export interface Ctx {
  db: Db;
  user: AuthUser;
  req: IncomingMessage;
  url: URL;
  params: string[];
  deps: SocialDeps;
  body(opts?: { limit?: number; optional?: boolean }): Promise<unknown>;
  /** The caller's profile row; throws 403 "profile_required" when they haven't set one up. */
  profile(): Promise<Row>;
  /** Counts one action against the caller's hourly allowance. */
  limit(kind: 'write' | 'search' | 'sync' | 'username'): void;
}

export type Handler = (ctx: Ctx) => Promise<{ status: number; body: unknown }>;
export interface Route {
  method: string;
  path: RegExp;
  handler: Handler;
}

export interface SocialRoutes {
  route(req: IncomingMessage, url: URL): Promise<{ status: number; body: unknown } | undefined>;
}

const ID = '([0-9a-fA-F-]{36})';
export const path = (p: string) => new RegExp(`^${p.replace(/:id/g, ID)}$`);

/**
 * Saves a notification unless the person turned that kind off. The dedupe key
 * makes retries and repeated taps harmless: the same key is stored once.
 */
export async function notify(
  q: Db['query'],
  n: {
    recipient: string;
    actor: string;
    type: string;
    entityType: 'note' | 'invitation' | 'connection';
    entityId: string;
    dedupe: string;
    pref: 'hearts' | 'invitations' | 'shares' | 'connections';
  },
): Promise<void> {
  if (n.recipient === n.actor) return;
  await q(
    `insert into segue.notifications (recipient_id, actor_id, type, entity_type, entity_id, dedupe_key)
     select $1, $2, $3, $4, $5, $6
     from segue.profiles p where p.id = $1 and coalesce((p.notify ->> $7)::boolean, true)
       and not exists (select 1 from segue.user_blocks bb where (bb.blocker_id = $1 and bb.blocked_id = $2) or (bb.blocker_id = $2 and bb.blocked_id = $1))
     on conflict (recipient_id, dedupe_key) do nothing`,
    [n.recipient, n.actor, n.type, n.entityType, n.entityId, n.dedupe, n.pref],
  );
}

/** zod result or a 400 with the issues. */
export function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, 'Some of those details are not valid', r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  return r.data;
}
