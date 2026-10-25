/**
 * Mutual connections and blocking.
 *
 * A connection needs a request and a yes. Until then nothing is shared.
 * Blocking wins over everything: it removes the connection, any notes shared
 * between the two, open invitations and hearts, and hides each person from
 * the other from then on (see `blockedBetween` in views.ts).
 */
import { UserBlockSchema, ConnectionRequestSchema, type ConnectionsResponse } from '@segue/schemas';
import type { Db } from '../db';
import { HttpError } from '../http';
import { notify, parse, path, type Route } from './core';
import { connected } from './profiles';
import { blockedBetween, isoReq, profileCols, publicProfile } from './views';

/** After a "no", the same person can ask again once this long has passed. */
export const REREQUEST_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const now = (ctx: { deps: { now?: () => number } }) => ctx.deps.now?.() ?? Date.now();

export async function listConnections(q: Db['query'], me: string): Promise<ConnectionsResponse> {
  const rows = await q(
    `select c.id, c.requester_id, c.recipient_id, c.status, c.created_at, c.responded_at, ${profileCols('p')}
     from segue.connections c
     join segue.profiles p on p.id = case when c.requester_id = $1 then c.recipient_id else c.requester_id end
     where (c.requester_id = $1 or c.recipient_id = $1) and c.status in ('pending', 'accepted')
       and not ${blockedBetween('p.id', '$1')}
     order by lower(p.display_name), p.id`,
    [me],
  );
  const out: ConnectionsResponse = { mutuals: [], incoming: [], outgoing: [], blocked: [] };
  for (const r of rows) {
    const person = publicProfile(r, 'p');
    if (r.status === 'accepted') out.mutuals.push({ id: String(r.id), person, since: isoReq(r.responded_at ?? r.created_at) });
    else if (r.requester_id === me) out.outgoing.push({ id: String(r.id), person, createdAt: isoReq(r.created_at) });
    else out.incoming.push({ id: String(r.id), person, createdAt: isoReq(r.created_at) });
  }
  const blocked = await q(
    `select b.created_at, ${profileCols('p')} from segue.user_blocks b join segue.profiles p on p.id = b.blocked_id
     where b.blocker_id = $1 order by b.created_at desc`,
    [me],
  );
  out.blocked = blocked.map((r) => ({ person: publicProfile(r, 'p'), since: isoReq(r.created_at) }));
  return out;
}

export const connectionRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/connections'),
    async handler(ctx) {
      await ctx.profile();
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
  {
    // Ask to connect. If they already asked you, this is a yes.
    method: 'POST',
    path: path('/v1/connections/requests'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const { userId } = parse(ConnectionRequestSchema, await ctx.body());
      const them = userId.toLowerCase();
      if (them === ctx.user.id) throw new HttpError(400, "You can't connect with yourself");
      const at = now(ctx);
      const result = await ctx.db.tx(async (q) => {
        // Not found covers: no such person, blocked either way, or not someone you could have found.
        const target = (
          await q(
            `select p.id from segue.profiles p where p.id = $2 and not ${blockedBetween('p.id', '$1')} and (p.discoverable or ${connected('$1', 'p.id')})`,
            [ctx.user.id, them],
          )
        )[0];
        if (!target) throw new HttpError(404, "Couldn't find that person");
        const existing = (
          await q(
            `select * from segue.connections where least(requester_id, recipient_id) = least($1::uuid, $2::uuid) and greatest(requester_id, recipient_id) = greatest($1::uuid, $2::uuid) for update`,
            [ctx.user.id, them],
          )
        )[0];
        if (existing) {
          const mine = existing.requester_id === ctx.user.id;
          if (existing.status === 'accepted') throw new HttpError(409, 'You are already mutuals', undefined, {}, 'already_connected');
          if (existing.status === 'pending' && mine) return { id: String(existing.id), state: 'request_sent' as const };
          if (existing.status === 'pending') {
            await q(`update segue.connections set status = 'accepted', responded_at = now(), updated_at = now() where id = $1`, [existing.id]);
            await notify(q, { recipient: them, actor: ctx.user.id, type: 'connection_accepted', entityType: 'connection', entityId: String(existing.id), dedupe: `conn_acc:${existing.id}:${at}`, pref: 'connections' });
            return { id: String(existing.id), state: 'mutual' as const };
          }
          // declined: whoever said no isn't pestered; the one who was declined waits a week
          const answered = Date.parse(isoReq(existing.responded_at));
          if (mine && at - answered < REREQUEST_AFTER_MS) {
            throw new HttpError(429, 'You can ask again in a few days', undefined, {}, 'request_cooldown');
          }
          await q(
            `update segue.connections set requester_id = $1, recipient_id = $2, status = 'pending', responded_at = null, created_at = now(), updated_at = now() where id = $3`,
            [ctx.user.id, them, existing.id],
          );
          await notify(q, { recipient: them, actor: ctx.user.id, type: 'connection_request', entityType: 'connection', entityId: String(existing.id), dedupe: `conn_req:${existing.id}:${at}`, pref: 'connections' });
          return { id: String(existing.id), state: 'request_sent' as const };
        }
        const created = (await q<{ id: string }>(`insert into segue.connections (requester_id, recipient_id) values ($1, $2) returning id`, [ctx.user.id, them]))[0]!;
        await notify(q, { recipient: them, actor: ctx.user.id, type: 'connection_request', entityType: 'connection', entityId: created.id, dedupe: `conn_req:${created.id}:${at}`, pref: 'connections' });
        return { id: created.id, state: 'request_sent' as const };
      });
      return { status: 201, body: { connection: result } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/connections/:id/accept'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      await ctx.db.tx(async (q) => {
        const c = (
          await q(
            `select c.* from segue.connections c where c.id = $1 and c.recipient_id = $2 and not ${blockedBetween('c.requester_id', '$2')} for update`,
            [id, ctx.user.id],
          )
        )[0];
        if (!c) throw new HttpError(404, "Couldn't find that request");
        if (c.status === 'accepted') return;
        if (c.status !== 'pending') throw new HttpError(409, 'That request was already answered');
        await q(`update segue.connections set status = 'accepted', responded_at = now(), updated_at = now() where id = $1`, [id]);
        await notify(q, { recipient: String(c.requester_id), actor: ctx.user.id, type: 'connection_accepted', entityType: 'connection', entityId: id, dedupe: `conn_acc:${id}:${now(ctx)}`, pref: 'connections' });
      });
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
  {
    method: 'POST',
    path: path('/v1/connections/:id/decline'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const rows = await ctx.db.query(
        `update segue.connections set status = 'declined', responded_at = now(), updated_at = now() where id = $1 and recipient_id = $2 and status = 'pending' returning id`,
        [id, ctx.user.id],
      );
      if (!rows.length) throw new HttpError(404, "Couldn't find that request");
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
  {
    // Cancel a request you sent, or remove a mutual. Either person can remove.
    method: 'DELETE',
    path: path('/v1/connections/:id'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const rows = await ctx.db.query(
        `delete from segue.connections where id = $1 and ((status = 'accepted' and (requester_id = $2 or recipient_id = $2)) or (status = 'pending' and requester_id = $2)) returning id`,
        [id, ctx.user.id],
      );
      if (!rows.length) throw new HttpError(404, "Couldn't find that connection");
      await ctx.db.query(`delete from segue.notifications where entity_type = 'connection' and entity_id = $1`, [id]);
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
  {
    method: 'POST',
    path: path('/v1/blocks'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const { userId } = parse(UserBlockSchema, await ctx.body());
      const them = userId.toLowerCase();
      if (them === ctx.user.id) throw new HttpError(400, "You can't block yourself");
      await ctx.db.tx(async (q) => {
        const exists = (await q('select 1 from segue.profiles where id = $1', [them]))[0];
        if (!exists) throw new HttpError(404, "Couldn't find that person");
        await q('insert into segue.user_blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing', [ctx.user.id, them]);
        const pair = [ctx.user.id, them];
        const dead = await q<{ id: string }>(
          `delete from segue.connections where least(requester_id, recipient_id) = least($1::uuid, $2::uuid) and greatest(requester_id, recipient_id) = greatest($1::uuid, $2::uuid) returning id`,
          pair,
        );
        if (dead.length) await q(`delete from segue.notifications where entity_type = 'connection' and entity_id = any($1::uuid[])`, [dead.map((d) => d.id)]);
        // Notes shared between the two, either way round.
        await q(
          `delete from segue.note_shares s using segue.notes n where n.id = s.note_id and ((n.author_id = $1 and s.user_id = $2) or (n.author_id = $2 and s.user_id = $1))`,
          pair,
        );
        // Hearts either way round, and invitations still waiting for an answer.
        await q(
          `update segue.note_interests i set withdrawn_at = now(), updated_at = now() from segue.notes n
           where n.id = i.note_id and i.withdrawn_at is null and ((n.author_id = $1 and i.user_id = $2) or (n.author_id = $2 and i.user_id = $1))`,
          pair,
        );
        await q(
          `update segue.invitations set status = 'cancelled', responded_at = now(), updated_at = now()
           where status = 'pending' and ((sender_id = $1 and recipient_id = $2) or (sender_id = $2 and recipient_id = $1))`,
          pair,
        );
        await q(
          `delete from segue.notifications where (recipient_id = $1 and actor_id = $2) or (recipient_id = $2 and actor_id = $1)`,
          pair,
        );
      });
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
  {
    method: 'DELETE',
    path: path('/v1/blocks/:id'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      await ctx.db.query('delete from segue.user_blocks where blocker_id = $1 and blocked_id = $2', [ctx.user.id, id]);
      return { status: 200, body: await listConnections(ctx.db.query, ctx.user.id) };
    },
  },
];

