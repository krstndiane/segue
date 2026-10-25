/** Your own profile, account deletion, and finding other people. */
import { ProfileCreateSchema, ProfileUpdateSchema, type ConnectionState, type MeResponse, type ProfileCard } from '@segue/schemas';
import { z } from 'zod';
import { HttpError } from '../http';
import { parse, path, type Route } from './core';
import { removeAvatarObject } from './avatars';
import { blockedBetween, DEFAULT_NOTIFY, likeEscape, mutualWith, myProfile, profileCols, publicProfile } from './views';

const SearchSchema = z.object({ q: z.string().trim().min(2, 'Type at least 2 letters').max(40) });
const DeleteSchema = z.object({ confirm: z.literal('DELETE') });

/** Columns a profile write may set, from the request's names. */
function profileValues(p: z.infer<typeof ProfileUpdateSchema>, existingNotify?: Record<string, boolean>): [string, unknown][] {
  const out: [string, unknown][] = [];
  if (p.username !== undefined) out.push(['username', p.username]);
  if (p.displayName !== undefined) out.push(['display_name', p.displayName]);
  if (p.bio !== undefined) out.push(['bio', p.bio]);
  if (p.avatar === null) out.push(['avatar', null], ['avatar_key', null]);
  if (p.pronouns !== undefined) out.push(['pronouns', p.pronouns]);
  if (p.interests !== undefined) out.push(['interests', [...new Set(p.interests)]]);
  if (p.discoverable !== undefined) out.push(['discoverable', p.discoverable]);
  if (p.profileVisibility !== undefined) out.push(['profile_visibility', p.profileVisibility]);
  if (p.showMutualCount !== undefined) out.push(['show_mutual_count', p.showMutualCount]);
  if (p.whoCanInvite !== undefined) out.push(['who_can_invite', p.whoCanInvite]);
  if (p.notify !== undefined) out.push(['notify', JSON.stringify({ ...DEFAULT_NOTIFY, ...(existingNotify ?? {}), ...p.notify })]);
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
      const before = await ctx.profile();
      const values = profileValues(parse(ProfileUpdateSchema, await ctx.body()), before.notify as Record<string, boolean>);
      if (!values.length) throw new HttpError(400, 'Nothing to change');
      const row = (
        await ctx.db.query(
          `update segue.profiles set ${values.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`,
          [ctx.user.id, ...values.map(([, v]) => v)],
        )
      )[0]!;
      if (before.avatar_key && !row.avatar_key) await removeAvatarObject(ctx, before.avatar_key);
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
      const gone = (await ctx.db.query('delete from segue.profiles where id = $1 returning avatar_key', [ctx.user.id]))[0];
      await removeAvatarObject(ctx, gone?.avatar_key);
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
        `select ${profileCols('p')}, ${connectionStateSql('$1', 'p.id')} as state from segue.profiles p
         where p.discoverable and p.id <> $1 and not ${blockedBetween('p.id', '$1')}
           and (p.username like $2 || '%' or lower(p.display_name) like '%' || $2 || '%')
         order by (p.username = $2) desc, (p.username like $2 || '%') desc, p.username
         limit 20`,
        [ctx.user.id, needle],
      );
      return { status: 200, body: { users: rows.map((r) => ({ ...publicProfile(r, 'p'), connection: String(r.state) as ConnectionState })) } };
    },
  },
  {
    // Someone's profile card: if they're findable, or you already share something with them.
    // What it shows depends on their privacy choice; blocked people are simply not found.
    method: 'GET',
    path: path('/v1/users/:id'),
    async handler(ctx) {
      await ctx.profile();
      const [id] = ctx.params as [string];
      const row = (
        await ctx.db.query(
          `select ${profileCols('p')}, p.bio as card_bio, p.pronouns, p.interests, p.profile_visibility, p.show_mutual_count,
                  ${mutualWith('$1', 'p.id')} as is_mutual, ${connectionStateSql('$1', 'p.id')} as state,
                  (select c.id from segue.connections c where c.status in ('pending', 'accepted')
                     and least(c.requester_id, c.recipient_id) = least($1::uuid, p.id) and greatest(c.requester_id, c.recipient_id) = greatest($1::uuid, p.id)) as connection_id,
                  (select count(*)::int from segue.connections m where m.status = 'accepted' and (m.requester_id = p.id or m.recipient_id = p.id)) as mutual_count
           from segue.profiles p
           where p.id = $2 and not ${blockedBetween('p.id', '$1')} and (p.id = $1 or p.discoverable or ${connected('$1', 'p.id')} or ${mutualWith('$1', 'p.id')}
             or exists (select 1 from segue.connections pc where pc.status = 'pending' and pc.requester_id = p.id and pc.recipient_id = $1))`,
          [ctx.user.id, id],
        )
      )[0];
      if (!row) throw new HttpError(404, "Couldn't find that person");
      const self = row.p_id === ctx.user.id;
      const full = self || row.profile_visibility === 'everyone' || (row.profile_visibility === 'mutuals' && !!row.is_mutual);
      const user: ProfileCard = {
        ...publicProfile(row, 'p'),
        bio: full ? String(row.card_bio ?? '') : '',
        pronouns: full ? String(row.pronouns ?? '') : '',
        interests: full ? ((row.interests as string[] | null) ?? []) : [],
        full,
        connection: String(row.state) as ConnectionState,
        ...(row.connection_id ? { connectionId: String(row.connection_id) } : {}),
        ...(full && row.show_mutual_count ? { mutualCount: Number(row.mutual_count) } : {}),
      };
      return { status: 200, body: { user } };
    },
  },
];

/** SQL: how viewer a relates to person b. */
const connectionStateSql = (a: string, b: string) => `(case
  when ${blockedBetween(b, a)} then 'blocked'
  when ${mutualWith(a, b)} then 'mutual'
  when exists (select 1 from segue.connections sc where sc.status = 'pending' and sc.requester_id = ${a} and sc.recipient_id = ${b}) then 'request_sent'
  when exists (select 1 from segue.connections sc where sc.status = 'pending' and sc.requester_id = ${b} and sc.recipient_id = ${a}) then 'request_received'
  else 'none' end)`;

/** SQL: users a and b already share a note or an invitation (either way round). */
export const connected = (a: string, b: string) => `(
  exists (select 1 from segue.invitations ci where (ci.sender_id = ${a} and ci.recipient_id = ${b}) or (ci.sender_id = ${b} and ci.recipient_id = ${a}))
  or exists (select 1 from segue.note_shares cs join segue.notes cn on cn.id = cs.note_id where (cn.author_id = ${a} and cs.user_id = ${b}) or (cn.author_id = ${b} and cs.user_id = ${a}))
  or exists (select 1 from segue.note_interests cx join segue.notes cn2 on cn2.id = cx.note_id where cx.withdrawn_at is null and ((cn2.author_id = ${a} and cx.user_id = ${b}) or (cn2.author_id = ${b} and cx.user_id = ${a})))
)`;
