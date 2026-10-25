/**
 * Invitations. Inviting people creates one shared activity and one
 * invitation per person, so everyone answers for themselves. Only the
 * sender can change or cancel; only the person invited can accept,
 * decline or suggest another time. Nothing here touches anyone's personal
 * plan: adding an accepted activity to your day happens on your device,
 * when you choose to.
 */
import { CancelSchema, CounterSchema, InvitationCreateSchema, InvitationUpdateSchema, type InvitationView } from '@segue/schemas';
import { z } from 'zod';
import type { Db } from '../db';
import { HttpError } from '../http';
import { notify, parse, path, type Route } from './core';
import { blockedBetween, canSeeNote, invitationStatus, iso, isoReq, mutualWith, profileCols, publicProfile, type Row } from './views';

const ListSchema = z.object({
  box: z.enum(['received', 'sent', 'all']).default('all'),
  state: z.enum(['open', 'past', 'all']).default('all'),
});

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Start and end make sense together, and aren't long gone. */
function checkTimes(startsAt: string | null | undefined, endsAt: string | null | undefined, now: number) {
  if (endsAt && !startsAt) throw new HttpError(400, 'Add a start time before an end time');
  if (startsAt) {
    const s = Date.parse(startsAt);
    if (s < now - HOUR) throw new HttpError(400, 'That time has already passed');
    if (s > now + 400 * DAY) throw new HttpError(400, 'Pick a time within the next year');
    if (endsAt) {
      const e = Date.parse(endsAt);
      if (e <= s) throw new HttpError(400, 'The end has to be after the start');
      if (e - s > DAY) throw new HttpError(400, 'Keep it to one day or less');
    }
  }
}

const INVITATION_SELECT = `
  v.*, act.id as act_id, act.title as act_title, act.description as act_description, act.starts_at as act_starts_at,
  act.ends_at as act_ends_at, act.timezone as act_timezone, act.place_name as act_place_name, act.meeting_notes as act_meeting_notes,
  act.status as act_status, act.updated_at as act_updated_at,
  case when n.id is not null and ${canSeeNote('n', '$1')} then n.id end as visible_note_id,
  ${profileCols('s')}, ${profileCols('r')}
  from segue.invitations v
  join segue.activities act on act.id = v.activity_id
  join segue.profiles s on s.id = v.sender_id
  join segue.profiles r on r.id = v.recipient_id
  left join segue.notes n on n.id = act.source_note_id`;

function invitationView(r: Row, viewer: string, now = Date.now()): InvitationView {
  return {
    id: String(r.id),
    activity: {
      id: String(r.act_id),
      title: String(r.act_title),
      description: String(r.act_description ?? ''),
      startsAt: iso(r.act_starts_at),
      endsAt: iso(r.act_ends_at),
      timezone: String(r.act_timezone),
      placeName: (r.act_place_name as string | null) ?? null,
      meetingNotes: String(r.act_meeting_notes ?? ''),
      status: r.act_status as 'active' | 'cancelled',
      sourceNoteId: (r.visible_note_id as string | null) ?? null,
      updatedAt: isoReq(r.act_updated_at),
    },
    sender: publicProfile(r, 's'),
    recipient: publicProfile(r, 'r'),
    direction: r.sender_id === viewer ? 'sent' : 'received',
    status: invitationStatus(r.status, r.expires_at, now),
    expiresAt: iso(r.expires_at),
    respondedAt: iso(r.responded_at),
    changedFields: (r.changed_fields as string[] | null) ?? [],
    counter: r.counter_start ? { startsAt: isoReq(r.counter_start), endsAt: iso(r.counter_end), note: (r.counter_note as string | null) ?? null } : null,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

/** Invitations the viewer is part of, matching `where` (which may use $1 = viewer and later params). */
async function load(q: Db['query'], viewer: string, where: string, params: unknown[] = []): Promise<InvitationView[]> {
  const rows = await q(
    `select ${INVITATION_SELECT} where (v.sender_id = $1 or v.recipient_id = $1) and ${where} order by v.created_at desc, v.id limit 200`,
    [viewer, ...params],
  );
  return rows.map((r) => invitationView(r, viewer));
}

async function one(q: Db['query'], viewer: string, id: string): Promise<InvitationView> {
  const [v] = await load(q, viewer, 'v.id = $2', [id]);
  if (!v) throw new HttpError(404, "Couldn't find that invitation");
  return v;
}

/** Locks one invitation row the viewer is part of, for a state change. */
async function lockInvitation(q: Db['query'], viewer: string, id: string) {
  const r = (
    await q<Row>(
      `select v.*, act.status as act_status, act.created_by as act_created_by from segue.invitations v join segue.activities act on act.id = v.activity_id
       where v.id = $1 and (v.sender_id = $2 or v.recipient_id = $2) for update of v`,
      [id, viewer],
    )
  )[0];
  if (!r) throw new HttpError(404, "Couldn't find that invitation");
  return r;
}

const open = (v: InvitationView, now: number) => {
  if (v.activity.status !== 'active') return false;
  if (v.status === 'pending') return true;
  if (v.status !== 'accepted') return false;
  const end = v.activity.endsAt ?? v.activity.startsAt;
  return !end || Date.parse(end) >= now - HOUR;
};

export const invitationRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/invitations'),
    async handler(ctx) {
      await ctx.profile();
      const f = parse(ListSchema, Object.fromEntries(ctx.url.searchParams));
      const box = f.box === 'received' ? 'v.recipient_id = $1' : f.box === 'sent' ? 'v.sender_id = $1' : 'true';
      const now = ctx.deps.now?.() ?? Date.now();
      let list = await load(ctx.db.query, ctx.user.id, box);
      if (f.state !== 'all') list = list.filter((v) => open(v, now) === (f.state === 'open'));
      return { status: 200, body: { invitations: list } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/invitations'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const b = parse(InvitationCreateSchema, await ctx.body());
      const now = ctx.deps.now?.() ?? Date.now();
      checkTimes(b.startsAt, b.endsAt, now);
      if (b.expiresAt && (Date.parse(b.expiresAt) <= now || Date.parse(b.expiresAt) > now + 90 * DAY)) {
        throw new HttpError(400, 'Pick an expiry within the next 90 days');
      }
      const recipients = [...new Set(b.recipientIds.map((x) => x.toLowerCase()))];
      if (recipients.includes(ctx.user.id)) throw new HttpError(400, "You can't invite yourself");

      const activityId = await ctx.db.tx(async (q) => {
        if (b.sourceNoteId) {
          const note = (await q('select 1 from segue.notes where id = $1 and author_id = $2', [b.sourceNoteId, ctx.user.id]))[0];
          if (!note) throw new HttpError(404, "Couldn't find that note");
        }
        const found = await q<{ id: string; display_name: string; who_can_invite: string; mutual: boolean }>(
          `select p.id, p.display_name, p.who_can_invite, ${mutualWith('p.id', '$2')} as mutual from segue.profiles p
           where p.id = any($1::uuid[]) and not ${blockedBetween('p.id', '$2')}`,
          [recipients, ctx.user.id],
        );
        if (found.length !== recipients.length) throw new HttpError(400, "Some of those people couldn't be found");
        // People choose who may invite them. Someone who already heart-asked for this note may always be invited to it.
        const closed = found.filter((p) => p.who_can_invite === 'nobody' || (p.who_can_invite === 'mutuals' && !p.mutual));
        if (b.sourceNoteId && closed.length) {
          const asked = await q<{ user_id: string }>('select user_id from segue.note_interests where note_id = $1 and withdrawn_at is null and user_id = any($2::uuid[])', [b.sourceNoteId, closed.map((p) => p.id)]);
          const ok = new Set(asked.map((r) => r.user_id));
          closed.splice(0, closed.length, ...closed.filter((p) => !ok.has(p.id)));
        }
        if (closed.length) {
          throw new HttpError(403, `${closed.map((p) => p.display_name).join(', ')} ${closed.length > 1 ? "aren't" : "isn't"} taking invitations from you`, undefined, {}, 'invites_closed');
        }

        const inserted = await q<{ id: string }>(
          `insert into segue.activities (created_by, title, description, starts_at, ends_at, timezone, place_name, meeting_notes, source_note_id, client_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (created_by, client_id) do nothing returning id`,
          [ctx.user.id, b.title, b.description ?? '', b.startsAt ?? null, b.endsAt ?? null, b.timezone, b.placeName ?? null, b.meetingNotes ?? '', b.sourceNoteId ?? null, b.clientId ?? null],
        );
        // The same request again (a retry): return what it made the first time.
        if (!inserted[0]) return (await q<{ id: string }>('select id from segue.activities where created_by = $1 and client_id = $2', [ctx.user.id, b.clientId]))[0]!.id;
        const activity = inserted[0].id;

        if (b.sourceNoteId) {
          // One open invitation per person per note.
          const dupes = await q<{ display_name: string }>(
            `select p.display_name from segue.invitations v join segue.activities a on a.id = v.activity_id join segue.profiles p on p.id = v.recipient_id
             where a.source_note_id = $1 and a.created_by = $2 and a.status = 'active' and a.id <> $3
               and v.recipient_id = any($4::uuid[]) and v.status in ('pending', 'accepted') and (v.expires_at is null or v.expires_at > now())`,
            [b.sourceNoteId, ctx.user.id, activity, recipients],
          );
          if (dupes.length) throw new HttpError(409, `Already invited: ${dupes.map((d) => d.display_name).join(', ')}`, undefined, {}, 'already_invited');
        }

        const invs = await q<{ id: string; recipient_id: string }>(
          `insert into segue.invitations (activity_id, sender_id, recipient_id, expires_at)
           select $1, $2, unnest($3::uuid[]), $4 returning id, recipient_id`,
          [activity, ctx.user.id, recipients, b.expiresAt ?? null],
        );
        for (const inv of invs) {
          if (b.sourceNoteId) {
            // A heart that led to this invitation now follows it.
            await q('update segue.note_interests set invitation_id = $1, updated_at = now() where note_id = $2 and user_id = $3', [inv.id, b.sourceNoteId, inv.recipient_id]);
          }
          await notify(q, { recipient: inv.recipient_id, actor: ctx.user.id, type: 'invitation_received', entityType: 'invitation', entityId: inv.id, dedupe: `inv_received:${inv.id}`, pref: 'invitations' });
        }
        return activity;
      });
      return { status: 201, body: { invitations: await load(ctx.db.query, ctx.user.id, 'v.activity_id = $2', [activityId]) } };
    },
  },
  {
    method: 'GET',
    path: path('/v1/invitations/:id'),
    async handler(ctx) {
      await ctx.profile();
      return { status: 200, body: { invitation: await one(ctx.db.query, ctx.user.id, ctx.params[0]!) } };
    },
  },
  {
    // The sender changes the activity. Everyone invited sees what changed; a new time or place
    // needs a fresh yes from people who had already accepted.
    method: 'PATCH',
    path: path('/v1/invitations/:id'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const u = parse(InvitationUpdateSchema, await ctx.body());
      const now = ctx.deps.now?.() ?? Date.now();
      const activityId = await ctx.db.tx(async (q) => {
        const inv = await lockInvitation(q, ctx.user.id, id);
        if (inv.sender_id !== ctx.user.id) throw new HttpError(403, 'Only the person who sent this invitation can change it');
        if (inv.act_status !== 'active') throw new HttpError(409, 'This invitation was cancelled');
        const act = (await q<Row>('select * from segue.activities where id = $1 for update', [inv.activity_id]))[0]!;
        const next = {
          title: u.title ?? String(act.title),
          description: u.description ?? String(act.description),
          startsAt: u.startsAt !== undefined ? u.startsAt : iso(act.starts_at),
          endsAt: u.endsAt !== undefined ? u.endsAt : iso(act.ends_at),
          timezone: u.timezone ?? String(act.timezone),
          placeName: u.placeName !== undefined ? u.placeName : ((act.place_name as string | null) ?? null),
          meetingNotes: u.meetingNotes ?? String(act.meeting_notes),
        };
        const sameTime = (a: string | null, b: unknown) => (a ? Date.parse(a) : null) === (b ? Date.parse(isoReq(b)) : null);
        const changed: string[] = [];
        if (!sameTime(next.startsAt, act.starts_at) || !sameTime(next.endsAt, act.ends_at)) changed.push('time');
        if (next.placeName !== (act.place_name ?? null) || next.meetingNotes !== act.meeting_notes) changed.push('place');
        if (next.title !== act.title || next.description !== act.description) changed.push('details');
        if (!changed.length) return String(act.id);
        if (changed.includes('time')) checkTimes(next.startsAt, next.endsAt, now);

        const updated = (
          await q<{ updated_at: Date }>(
            `update segue.activities set title = $2, description = $3, starts_at = $4, ends_at = $5, timezone = $6, place_name = $7, meeting_notes = $8, updated_at = now()
             where id = $1 returning updated_at`,
            [act.id, next.title, next.description, next.startsAt, next.endsAt, next.timezone, next.placeName, next.meetingNotes],
          )
        )[0]!;
        const reconfirm = changed.includes('time') || changed.includes('place');
        const affected = await q<{ id: string; recipient_id: string }>(
          `update segue.invitations set
             changed_fields = array(select distinct unnest(changed_fields || $2::text[]) order by 1),
             status = case when $3 and status = 'accepted' then 'pending' else status end,
             responded_at = case when $3 and status = 'accepted' then null else responded_at end,
             counter_start = case when $4 then null else counter_start end,
             counter_end = case when $4 then null else counter_end end,
             counter_note = case when $4 then null else counter_note end,
             updated_at = now()
           where activity_id = $1 and status in ('pending', 'accepted')
           returning id, recipient_id`,
          [act.id, changed, reconfirm, changed.includes('time')],
        );
        for (const a of affected) {
          await notify(q, { recipient: a.recipient_id, actor: ctx.user.id, type: 'invitation_changed', entityType: 'invitation', entityId: a.id, dedupe: `inv_changed:${a.id}:${updated.updated_at.getTime()}`, pref: 'invitations' });
        }
        return String(act.id);
      });
      return { status: 200, body: { invitations: await load(ctx.db.query, ctx.user.id, 'v.activity_id = $2', [activityId]) } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/invitations/:id/accept'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      await ctx.db.tx(async (q) => {
        const inv = await lockInvitation(q, ctx.user.id, id);
        if (inv.recipient_id !== ctx.user.id) throw new HttpError(403, 'Only the person invited can accept');
        if (inv.status === 'accepted') return;
        if (inv.status === 'cancelled' || inv.act_status !== 'active') throw new HttpError(409, 'This invitation was cancelled');
        if (invitationStatus(inv.status, inv.expires_at, ctx.deps.now?.()) === 'expired') throw new HttpError(409, 'This invitation has expired');
        const done = (
          await q<{ responded_at: Date }>(
            `update segue.invitations set status = 'accepted', responded_at = now(), changed_fields = '{}', updated_at = now() where id = $1 returning responded_at`,
            [id],
          )
        )[0]!;
        await notify(q, { recipient: String(inv.sender_id), actor: ctx.user.id, type: 'invitation_accepted', entityType: 'invitation', entityId: id, dedupe: `inv_accepted:${id}:${done.responded_at.getTime()}`, pref: 'invitations' });
      });
      return { status: 200, body: { invitation: await one(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    // "No thanks", or "I can't make it any more" after accepting.
    method: 'POST',
    path: path('/v1/invitations/:id/decline'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      await ctx.db.tx(async (q) => {
        const inv = await lockInvitation(q, ctx.user.id, id);
        if (inv.recipient_id !== ctx.user.id) throw new HttpError(403, 'Only the person invited can decline');
        if (inv.status === 'declined') return;
        if (inv.status === 'cancelled') throw new HttpError(409, 'This invitation was cancelled');
        const done = (
          await q<{ responded_at: Date }>(
            `update segue.invitations set status = 'declined', responded_at = now(), updated_at = now() where id = $1 returning responded_at`,
            [id],
          )
        )[0]!;
        await notify(q, { recipient: String(inv.sender_id), actor: ctx.user.id, type: 'invitation_declined', entityType: 'invitation', entityId: id, dedupe: `inv_declined:${id}:${done.responded_at.getTime()}`, pref: 'invitations' });
      });
      return { status: 200, body: { invitation: await one(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    // The sender cancels this one invitation, or the whole activity for everyone.
    method: 'POST',
    path: path('/v1/invitations/:id/cancel'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const { everyone } = parse(CancelSchema, await ctx.body({ optional: true }));
      await ctx.db.tx(async (q) => {
        const inv = await lockInvitation(q, ctx.user.id, id);
        if (inv.sender_id !== ctx.user.id) throw new HttpError(403, 'Only the person who sent this invitation can cancel it');
        if (everyone) await q(`update segue.activities set status = 'cancelled', updated_at = now() where id = $1`, [inv.activity_id]);
        const cancelled = await q<{ id: string; recipient_id: string }>(
          `update segue.invitations set status = 'cancelled', updated_at = now()
           where ${everyone ? 'activity_id = $1' : 'id = $2 and activity_id = $1'} and status in ('pending', 'accepted')
           returning id, recipient_id`,
          everyone ? [inv.activity_id] : [inv.activity_id, id],
        );
        for (const c of cancelled) {
          await notify(q, { recipient: c.recipient_id, actor: ctx.user.id, type: 'invitation_cancelled', entityType: 'invitation', entityId: c.id, dedupe: `inv_cancelled:${c.id}`, pref: 'invitations' });
        }
      });
      return { status: 200, body: { invitation: await one(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    // "Could we do another time?" from the person invited. The sender decides whether to change it.
    method: 'POST',
    path: path('/v1/invitations/:id/counter'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const c = parse(CounterSchema, await ctx.body());
      checkTimes(c.startsAt, c.endsAt ?? null, ctx.deps.now?.() ?? Date.now());
      await ctx.db.tx(async (q) => {
        const inv = await lockInvitation(q, ctx.user.id, id);
        if (inv.recipient_id !== ctx.user.id) throw new HttpError(403, 'Only the person invited can suggest another time');
        if (inv.status === 'cancelled' || inv.act_status !== 'active') throw new HttpError(409, 'This invitation was cancelled');
        if (invitationStatus(inv.status, inv.expires_at, ctx.deps.now?.()) === 'expired') throw new HttpError(409, 'This invitation has expired');
        const done = (
          await q<{ updated_at: Date }>(
            `update segue.invitations set counter_start = $2, counter_end = $3, counter_note = $4, updated_at = now() where id = $1 returning updated_at`,
            [id, c.startsAt, c.endsAt ?? null, c.note || null],
          )
        )[0]!;
        await notify(q, { recipient: String(inv.sender_id), actor: ctx.user.id, type: 'invitation_counter', entityType: 'invitation', entityId: id, dedupe: `inv_counter:${id}:${done.updated_at.getTime()}`, pref: 'invitations' });
      });
      return { status: 200, body: { invitation: await one(ctx.db.query, ctx.user.id, id) } };
    },
  },
];
