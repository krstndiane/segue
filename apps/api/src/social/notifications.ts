/**
 * In-app notifications. The words are written when they're read, so a note
 * that was deleted or is no longer shared shows up as "no longer
 * available", never with its title.
 */
import type { NotificationType, NotificationView } from '@segue/schemas';
import { z } from 'zod';
import { HttpError } from '../http';
import { parse, path, type Route } from './core';
import { canSeeNote, isoReq, iso, profileCols, publicProfile } from './views';

const ListSchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(30) });

const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 57)}…` : s}”`;

function words(type: NotificationType, who: string, title: string | null): string {
  if (type === 'connection_request') return `${who} wants to connect with you.`;
  if (type === 'connection_accepted') return `${who} accepted your request. You're mutuals now.`;
  if (title === null) {
    return type.startsWith('invitation') ? `${who} updated an invitation that's no longer available.` : `${who} shared something that's no longer available.`;
  }
  const t = quote(title);
  switch (type) {
    case 'note_hearted':
      return `${who} would like to join ${t}. Invite them when you're ready.`;
    case 'note_shared':
      return `${who} shared a note with you: ${t}.`;
    case 'invitation_received':
      return `${who} invited you to ${t}.`;
    case 'invitation_accepted':
      return `${who} is in for ${t}.`;
    case 'invitation_declined':
      return `${who} can't make ${t}.`;
    case 'invitation_cancelled':
      return `${who} cancelled ${t}.`;
    case 'invitation_changed':
      return `${who} changed ${t}. Take a look.`;
    case 'invitation_counter':
      return `${who} suggested another time for ${t}.`;
    case 'join_accepted':
      return `${who} said yes: you're joining ${t}.`;
    case 'join_declined':
      return `${who} can't fit anyone else into ${t} this time.`;
    default:
      return `${who} sent you an update.`;
  }
}

export const notificationRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/notifications'),
    async handler(ctx) {
      await ctx.profile();
      const { limit } = parse(ListSchema, Object.fromEntries(ctx.url.searchParams));
      const rows = await ctx.db.query(
        `select x.*, ${profileCols('p')},
           case when x.entity_type = 'note' then (select n.title from segue.notes n where n.id = x.entity_id and ${canSeeNote('n', '$1')})
                when x.entity_type = 'connection' then (select 'connection' from segue.connections c where c.id = x.entity_id and (c.requester_id = $1 or c.recipient_id = $1))
                else (select a.title from segue.invitations v join segue.activities a on a.id = v.activity_id
                      where v.id = x.entity_id and (v.sender_id = $1 or v.recipient_id = $1)) end as title
         from segue.notifications x left join segue.profiles p on p.id = x.actor_id
         where x.recipient_id = $1 order by x.created_at desc, x.id limit $2`,
        [ctx.user.id, limit],
      );
      const unread = Number((await ctx.db.query<{ n: string }>('select count(*) as n from segue.notifications where recipient_id = $1 and read_at is null', [ctx.user.id]))[0]?.n ?? 0);
      const items: NotificationView[] = rows.map((r) => {
        const actor = r.p_id ? publicProfile(r, 'p') : null;
        const title = (r.title as string | null) ?? null;
        return {
          id: String(r.id),
          type: r.type as NotificationType,
          actor,
          entityType: r.entity_type as 'note' | 'invitation' | 'connection',
          entityId: String(r.entity_id),
          text: words(r.type as NotificationType, actor?.displayName ?? 'Someone', title),
          available: title !== null,
          readAt: iso(r.read_at),
          createdAt: isoReq(r.created_at),
        };
      });
      return { status: 200, body: { notifications: items, unread } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/notifications/:id/read'),
    async handler(ctx) {
      await ctx.profile();
      const rows = await ctx.db.query('update segue.notifications set read_at = coalesce(read_at, now()) where id = $1 and recipient_id = $2 returning id', [ctx.params[0], ctx.user.id]);
      if (!rows.length) throw new HttpError(404, "Couldn't find that notification");
      return { status: 200, body: { ok: true } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/notifications/read-all'),
    async handler(ctx) {
      await ctx.profile();
      await ctx.db.query('update segue.notifications set read_at = now() where recipient_id = $1 and read_at is null', [ctx.user.id]);
      return { status: 200, body: { ok: true } };
    },
  },
];
