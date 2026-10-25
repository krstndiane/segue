/**
 * Username rules on the server: the check used by both the availability
 * endpoint and profile saves, and the endpoint itself.
 *
 * The availability answer is advisory. The unique index on `profiles.username`
 * (and the format trigger) are what actually guarantee uniqueness and
 * validity, so a name that was free a moment ago can still be refused at save.
 */
import {
  checkUsername,
  normalizeUsername,
  usernameCandidates,
  type UsernameAvailability,
} from '@segue/schemas';
import { z } from 'zod';
import { HttpError } from '../http';
import { parse, path, type Ctx, type Route } from './core';

const QuerySchema = z.object({ username: z.string().max(64).default('') });

/**
 * The canonical form of a username being set, or a 400 saying what's wrong.
 * A name the person already has is accepted as is, so older names that predate the rules still save.
 */
export function acceptedUsername(ctx: Ctx, raw: string, current?: string): string {
  if (current && normalizeUsername(raw) === current) return current;
  const r = checkUsername(raw, ctx.deps.reservedUsernames);
  if (!r.ok) throw new HttpError(400, r.message, { reason: r.reason }, {}, 'username_invalid');
  return r.username;
}

export const usernameRoutes: Route[] = [
  {
    // Needs a sign-in (people check while setting up their profile, which comes after sign-up), but not a profile.
    method: 'GET',
    path: path('/v1/usernames/availability'),
    async handler(ctx) {
      ctx.limit('username');
      const { username: raw } = parse(QuerySchema, Object.fromEntries(ctx.url.searchParams));
      const name = normalizeUsername(raw);
      const check = checkUsername(raw, ctx.deps.reservedUsernames);
      if (!check.ok) {
        const body: UsernameAvailability = { username: name, available: false, reason: check.reason };
        return { status: 200, body };
      }
      const owner = (await ctx.db.query<{ id: string }>('select id from segue.profiles where username = $1', [check.username]))[0];
      if (!owner) return { status: 200, body: { username: check.username, available: true, reason: null } satisfies UsernameAvailability };
      if (owner.id === ctx.user.id) return { status: 200, body: { username: check.username, available: true, reason: null, yours: true } satisfies UsernameAvailability };

      const candidates = usernameCandidates(check.username, new Date(ctx.deps.now?.() ?? Date.now()).getUTCFullYear()).filter(
        (c) => checkUsername(c, ctx.deps.reservedUsernames).ok,
      );
      const taken = new Set(
        (await ctx.db.query<{ username: string }>('select username from segue.profiles where username = any($1::text[])', [candidates])).map((r) => r.username),
      );
      const suggestions = candidates.filter((c) => !taken.has(c)).slice(0, 3);
      return { status: 200, body: { username: check.username, available: false, reason: 'taken', suggestions } satisfies UsernameAvailability };
    },
  },
];
