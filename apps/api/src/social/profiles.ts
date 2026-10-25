/** Your own profile, account deletion, and finding other people. */
import { ProfileCreateSchema, ProfileUpdateSchema, type MeResponse, type PublicProfile } from '@segue/schemas';
import { z } from 'zod';
import { HttpError } from '../http';
import { parse, path, type Route } from './core';
import { likeEscape, myProfile, profileCols, publicProfile } from './views';

const SearchSchema = z.object({ q: z.string().trim().min(2, 'Type at least 2 letters').max(40) });
const DeleteSchema = z.object({ confirm: z.literal('DELETE') });

/** Columns a profile write may set, from the request's names. */
function profileValues(p: z.infer<typeof ProfileUpdateSchema>): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (p.username !== undefined) out.push(['username', p.username]);
  if (p.displayName !== undefined) out.push(['display_name', p.displayName]);
  if (p.bio !== undefined) out.push(['bio', p.bio]);
  if (p.avatar !== undefined) out.push(['avatar', p.avatar]);
  if (p.discoverable !== undefined) out.push(['discoverable', p.discoverable]);
  if (p.notify !== undefined) out.push(['notify', JSON.stringify(p.notify)]);
  if (p.timezone !== undefined) out.push(['timezone', p.timezone]);
  return out;
}

export const profileRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/me'),
    async handler(ctx) {
      const row = (await ctx.db.query('select * from segue.profiles where id = $1', [ctx.user.id]))[0];
      const body: MeResponse = { profile: row ? myProfile(row) : null, email: ctx.user.email };
      return { status: 200, body };
    },
  },
  {
    // First-time setup (or a full replace).
    method: 'PUT',
    path: path('/v1/me'),
    async handler(ctx) {
      ctx.limit('write');
      const p = parse(ProfileCreateSchema, await ctx.body());
      const values = profileValues(p);
      const cols = values.map(([c]) => c);
      const row = (
        await ctx.db.query(
          `insert into segue.profiles (id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
           on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = now()
           returning *`,
          [ctx.user.id, ...values.map(([, v]) => v)],
        )
      )[0]!;
      return { status: 200, body: { profile: myProfile(row), email: ctx.user.email } satisfies MeResponse };
    },
  },
  {
    method: 'PATCH',
    path: path('/v1/me'),
    async handler(ctx) {
      ctx.limit('write');
      await ctx.profile();
      const values = profileValues(parse(ProfileUpdateSchema, await ctx.body()));
      if (!values.length) throw new HttpError(400, 'Nothing to change');
      const row = (
        await ctx.db.query(
          `update segue.profiles set ${values.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
          [ctx.user.id, ...values.map(([, v]) => v)],
        )
      )[0]!;
      return { status: 200, body: { profile: myProfile(row), email: ctx.user.email } satisfies MeResponse };
    },
  },
  {
    // Deletes the profile and everything that hangs off it (notes, hearts, invitations, synced plans,
    // notifications), then the sign-in itself when the server is allowed to.
    method: 'DELETE',
    path: path('/v1/me'),
    async handler(ctx) {
      ctx.limit('write');
      parse(DeleteSchema, await ctx.body());
      await ctx.db.query('delete from segue.profiles where id = $1', [ctx.user.id]);
      let signInRemoved = false;
      if (ctx.deps.deleteAuthUser) {
        try {
          signInRemoved = await ctx.deps.deleteAuthUser(ctx.user.id);
        } catch (e) {
          ctx.deps.log?.(`delete sign-in failed: ${(e as Error).message}`);
        }
      }
      return { status: 200, body: { deleted: true, signInRemoved } };
    },
  },
  {
    // People who chose to be findable, by username or name. Never by email.
    method: 'GET',
    path: path('/v1/users'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('search');
      const { q } = parse(SearchSchema, Object.fromEntries(ctx.url.searchParams));
      const needle = likeEscape(q.toLowerCase().replace(/^@/, ''));
      const rows = await ctx.db.query(
        `select ${profileCols('p')} from segue.profiles p
         where p.discoverable and p.id <> $1 and (p.username like $2 || '%' or lower(p.display_name) like '%' || $2 || '%')
         order by (p.username = $2) desc, (p.username like $2 || '%') desc, p.username
         limit 20`,
        [ctx.user.id, needle],
      );
      return { status: 200, body: { users: rows.map((r) => publicProfile(r, 'p')) } };
    },
  },
  {
    // Someone's limited profile: if they're findable, or you already share something with them.
    method: 'GET',
    path: path('/v1/users/:id'),
    async handler(ctx) {
      await ctx.profile();
      const [id] = ctx.params as [string];
      const row = (
        await ctx.db.query(
          `select ${profileCols('p')} from segue.profiles p
           where p.id = $2 and (p.id = $1 or p.discoverable or ${connected('$1', 'p.id')})`,
          [ctx.user.id, id],
        )
      )[0];
      if (!row) throw new HttpError(404, "Couldn't find that person");
      const user: PublicProfile = publicProfile(row, 'p');
      return { status: 200, body: { user } };
    },
  },
];

/** SQL: users a and b already share a note or an invitation (either way round). */
export const connected = (a: string, b: string) => `(
  exists (select 1 from segue.invitations ci where (ci.sender_id = ${a} and ci.recipient_id = ${b}) or (ci.sender_id = ${b} and ci.recipient_id = ${a}))
  or exists (select 1 from segue.note_shares cs join segue.notes cn on cn.id = cs.note_id where (cn.author_id = ${a} and cs.user_id = ${b}) or (cn.author_id = ${b} and cs.user_id = ${a}))
  or exists (select 1 from segue.note_interests cx join segue.notes cn2 on cn2.id = cx.note_id where cx.withdrawn_at is null and ((cn2.author_id = ${a} and cx.user_id = ${b}) or (cn2.author_id = ${b} and cx.user_id = ${a})))
)`;
