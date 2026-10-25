/**
 * Accounts and the social layer: profiles, cross-device sync, notes,
 * hearts, invitations and notifications.
 *
 * Every route here needs a signed-in user. Identity comes only from the
 * verified access token; ids in URLs and bodies are checked against it.
 */
import { AuthError, bearer, type AuthUser } from '../auth';
import { HttpError, readJson } from '../http';
import { RateLimiter } from '../rateLimit';
import type { Ctx, Route, SocialDeps, SocialRoutes } from './core';
import { avatarRoutes } from './avatars';
import { connectionRoutes } from './connections';
import { invitationRoutes } from './invitations';
import { noteRoutes } from './notes';
import { notificationRoutes } from './notifications';
import { profileRoutes } from './profiles';
import { usernameRoutes } from './usernames';
import { stateRoutes } from './state';
import type { Row } from './views';

export type { SocialDeps, SocialRoutes } from './core';

export function createSocial(deps: SocialDeps): SocialRoutes {
  const writes = new RateLimiter(deps.limits?.writesPerHour ?? 300, 60 * 60 * 1000, deps.now);
  const searches = new RateLimiter(deps.limits?.searchesPerHour ?? 60, 60 * 60 * 1000, deps.now);
  const usernames = new RateLimiter(deps.limits?.usernameChecksPerHour ?? 240, 60 * 60 * 1000, deps.now);
  const syncs = new RateLimiter(deps.limits?.syncWritesPerHour ?? 900, 60 * 60 * 1000, deps.now);
  const routes: Route[] = [...profileRoutes, ...usernameRoutes, ...avatarRoutes, ...connectionRoutes, ...stateRoutes, ...noteRoutes, ...invitationRoutes, ...notificationRoutes];

  return {
    async route(req, url) {
      const method = req.method ?? 'GET';
      let match: RegExpExecArray | null = null;
      const route = routes.find((r) => r.method === method && (match = r.path.exec(url.pathname)));
      if (!route || !match) return undefined;

      const token = bearer(req.headers.authorization);
      if (!token) throw new HttpError(401, 'Sign in to use this', undefined, {}, 'signed_out');
      let user: AuthUser;
      try {
        user = await deps.verifier.verify(token);
      } catch (e) {
        if (!(e instanceof AuthError)) deps.log?.(`token check failed: ${(e as Error).message}`);
        throw new HttpError(401, 'Your sign-in has expired. Sign in again.', undefined, {}, 'signed_out');
      }

      let profileRow: Row | null | undefined;
      const ctx: Ctx = {
        db: deps.db,
        user,
        req,
        url,
        params: (match as RegExpExecArray).slice(1).map((p) => p.toLowerCase()),
        deps,
        body: (opts) => readJson(req, opts),
        async profile() {
          if (profileRow === undefined) profileRow = (await deps.db.query('select * from segue.profiles where id = $1', [user.id]))[0] ?? null;
          if (!profileRow) throw new HttpError(403, 'Set up your profile first', undefined, {}, 'profile_required');
          return profileRow;
        },
        limit(kind) {
          const limiter = kind === 'search' ? searches : kind === 'sync' ? syncs : kind === 'username' ? usernames : writes;
          const retryAfter = limiter.hit(`u:${user.id}`);
          if (retryAfter) throw new HttpError(429, 'Slow down a little and try again soon', undefined, { 'retry-after': String(retryAfter) }, 'rate_limited');
        },
      };
      try {
        return await route.handler(ctx);
      } catch (e) {
        throw translate(e);
      }
    },
  };
}

/** Database errors into plain answers; anything else passes through. */
function translate(e: unknown): unknown {
  const err = e as { code?: string; constraint?: string };
  if (e instanceof HttpError || typeof err?.code !== 'string') return e;
  if (err.code === '23505' && err.constraint === 'profiles_username_key') return new HttpError(409, 'That username was just taken. Pick another one.', undefined, {}, 'username_taken');
  if (err.code === '23514' && err.constraint === 'profiles_username_rules') return new HttpError(400, 'That username doesn’t meet the rules.', undefined, {}, 'username_invalid');
  if (err.code === '23505') return new HttpError(409, 'That already exists', undefined, {}, 'conflict');
  if (err.code === '23514' || err.code === '22P02' || err.code === '22007' || err.code === '22008') return new HttpError(400, 'Some of those details are not valid');
  if (err.code === '23503') return new HttpError(404, "Couldn't find that");
  return e;
}

