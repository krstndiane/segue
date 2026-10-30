/**
 * Notes and hearts.
 *
 * A note is private unless its author says otherwise: shared with selected
 * people, or discoverable. A heart on someone else's note means "I'd like to
 * be invited": it records interest and tells the author, nothing more. It
 * never adds anything to anyone's plan.
 */
import { JoinAcceptSchema, NOTE_SCOPES, NoteCreateSchema, NoteUpdateSchema, type InterestView, type NoteView, type PublicProfile } from '@segue/schemas';
import { z } from 'zod';
import type { Db } from '../db';
import { HttpError } from '../http';
import { notify, parse, path, type Ctx, type Route } from './core';
import { blockedBetween, canSeeNote, interestStatus, interestStillVisible, isoReq, likeEscape, profileCols, publicProfile, type Row } from './views';
import { loadInvitations } from './invitations';

const ListSchema = z.object({
  scope: z.enum(NOTE_SCOPES).default('mine'),
  q: z.string().trim().max(80).optional(),
  archived: z.enum(['0', '1']).default('0'),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  author: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

/** The columns every note view needs, for viewer $1. */
const NOTE_SELECT = `
  n.*, ${profileCols('a')},
  case when n.author_id = $1 then (
    select count(*) from segue.note_interests hi where hi.note_id = n.id and hi.withdrawn_at is null and ${interestStillVisible('n', 'hi')}
  ) end as heart_count,
  mi.withdrawn_at as mi_withdrawn, mi.declined_at as mi_declined, inv.status as inv_status, inv.expires_at as inv_expires, mi.id as mi_id
  from segue.notes n
  join segue.profiles a on a.id = n.author_id
  left join segue.note_interests mi on mi.note_id = n.id and mi.user_id = $1
  left join segue.invitations inv on inv.id = mi.invitation_id`;

function noteView(r: Row, viewer: string, shares?: PublicProfile[]): NoteView {
  const mine = r.author_id === viewer;
  const view: NoteView = {
    id: String(r.id),
    author: publicProfile(r, 'a'),
    title: String(r.title),
    body: String(r.body),
    visibility: r.visibility as NoteView['visibility'],
    onDate: (r.on_date as string | null) ?? null,
    placeName: (r.place_name as string | null) ?? null,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    archived: r.archived_at != null,
    mine,
    openToJoin: r.open_to_join !== false,
  };
  if (mine) {
    view.pinned = !!r.pinned;
    view.blockId = (r.block_id as string | null) ?? null;
    view.heartCount = Number(r.heart_count ?? 0);
    view.sharedWith = shares ?? [];
  } else {
    view.hearted = r.mi_id != null && r.mi_withdrawn == null;
    if (r.mi_id != null) view.interest = interestStatus(r.mi_withdrawn, r.inv_status, r.inv_expires, r.mi_declined);
  }
  return view;
}

async function sharesFor(q: Db['query'], noteIds: string[]): Promise<Map<string, PublicProfile[]>> {
  const out = new Map<string, PublicProfile[]>();
  if (!noteIds.length) return out;
  const rows = await q(
    `select s.note_id, ${profileCols('p')} from segue.note_shares s join segue.profiles p on p.id = s.user_id
     where s.note_id = any($1::uuid[]) order by p.display_name`,
    [noteIds],
  );
  for (const r of rows) {
    const list = out.get(String(r.note_id)) ?? [];
    list.push(publicProfile(r, 'p'));
    out.set(String(r.note_id), list);
  }
  return out;
}

/** One note as the viewer may see it, or 404 (also for notes they aren't allowed to see). */
export async function loadNote(q: Db['query'], viewer: string, id: string): Promise<NoteView> {
  const r = (await q(`select ${NOTE_SELECT} where n.id = $2 and ${canSeeNote('n', '$1')}`, [viewer, id]))[0];
  if (!r) throw new HttpError(404, "Couldn't find that note");
  const shares = r.author_id === viewer ? (await sharesFor(q, [id])).get(id) : undefined;
  return noteView(r, viewer, shares);
}

/** Replaces who a note is shared with; new people get a notification if the note is "selected". */
async function setShares(q: Db['query'], ctx: Ctx, noteId: string, ids: string[], visibility: string) {
  const wanted = [...new Set(ids.map((x) => x.toLowerCase()))].filter((x) => x !== ctx.user.id);
  // A blocked person (either way round) is reported like someone who can't be found.
  const found = wanted.length
    ? (await q<{ id: string }>(`select p.id from segue.profiles p where p.id = any($1::uuid[]) and not ${blockedBetween('p.id', '$2')}`, [wanted, ctx.user.id])).map((r) => r.id)
    : [];
  if (found.length !== wanted.length) throw new HttpError(400, "Some of those people couldn't be found");
  await q('delete from segue.note_shares where note_id = $1 and not (user_id = any($2::uuid[]))', [noteId, found]);
  const added = found.length
    ? await q<{ user_id: string }>(
        `insert into segue.note_shares (note_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing returning user_id`,
        [noteId, found],
      )
    : [];
  if (visibility === 'selected') await notifyShared(q, ctx.user.id, noteId, added.map((a) => a.user_id));
}

async function notifyShared(q: Db['query'], actor: string, noteId: string, people: string[]) {
  for (const p of people) {
    await notify(q, { recipient: p, actor, type: 'note_shared', entityType: 'note', entityId: noteId, dedupe: `note_shared:${noteId}`, pref: 'shares' });
  }
}

export const noteRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/notes'),
    async handler(ctx) {
      await ctx.profile();
      const f = parse(ListSchema, Object.fromEntries(ctx.url.searchParams));
      const where: string[] = [];
      const params: unknown[] = [ctx.user.id];
      const p = (v: unknown) => (params.push(v), `$${params.length}`);
      let order = 'n.updated_at desc, n.id';
      switch (f.scope) {
        case 'mine':
          where.push('n.author_id = $1', f.archived === '1' ? 'n.archived_at is not null' : 'n.archived_at is null');
          order = 'n.pinned desc, n.updated_at desc, n.id';
          break;
        case 'shared':
          where.push(`n.author_id <> $1 and n.archived_at is null and n.visibility = 'selected'`, `exists (select 1 from segue.note_shares s where s.note_id = n.id and s.user_id = $1)`);
          break;
        case 'discover':
          // Only from people who chose to be findable.
          where.push(`n.author_id <> $1 and n.archived_at is null and n.visibility = 'discoverable' and a.discoverable`, `not ${blockedBetween('n.author_id', '$1')}`);
          break;
        case 'hearted':
          where.push('mi.id is not null and mi.withdrawn_at is null', canSeeNote('n', '$1'));
          break;
      }
      if (f.author) where.push(`n.author_id = ${p(f.author.toLowerCase())}`, canSeeNote('n', '$1'));
      if (f.onDate) where.push(`n.on_date = ${p(f.onDate)}`);
      if (f.q) {
        const like = p(`%${likeEscape(f.q.toLowerCase())}%`);
        where.push(`(lower(n.title) like ${like} or lower(n.body) like ${like} or lower(coalesce(n.place_name, '')) like ${like})`);
      }
      const rows = await ctx.db.query(
        `select ${NOTE_SELECT} where ${where.join(' and ')} order by ${order} limit ${p(f.limit + 1)} offset ${p(f.offset)}`,
        params,
      );
      const more = rows.length > f.limit;
      const page = rows.slice(0, f.limit);
      const shares = await sharesFor(ctx.db.query, page.filter((r) => r.author_id === ctx.user.id).map((r) => String(r.id)));
      return { status: 200, body: { notes: page.map((r) => noteView(r, ctx.user.id, shares.get(String(r.id)))), more } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/notes'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const n = parse(NoteCreateSchema, await ctx.body());
      const visibility = n.visibility ?? 'private';
      const id = await ctx.db.tx(async (q) => {
        const inserted = await q<{ id: string }>(
          `insert into segue.notes (author_id, title, body, visibility, on_date, place_name, block_id, pinned, archived_at, client_id, open_to_join)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end, $10, $11)
           on conflict (author_id, client_id) do nothing returning id`,
          [ctx.user.id, n.title, n.body ?? '', visibility, n.onDate ?? null, n.placeName ?? null, n.blockId ?? null, n.pinned ?? false, n.archived ?? false, n.clientId ?? null, n.openToJoin ?? true],
        );
        // A retry of the same create: hand back the note that was already made.
        if (!inserted[0]) {
          const existing = await q<{ id: string }>('select id from segue.notes where author_id = $1 and client_id = $2', [ctx.user.id, n.clientId]);
          return existing[0]!.id;
        }
        if (n.shareWith?.length) await setShares(q, ctx, inserted[0].id, n.shareWith, visibility);
        return inserted[0].id;
      });
      return { status: 201, body: { note: await loadNote(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    method: 'GET',
    path: path('/v1/notes/:id'),
    async handler(ctx) {
      await ctx.profile();
      return { status: 200, body: { note: await loadNote(ctx.db.query, ctx.user.id, ctx.params[0]!) } };
    },
  },
  {
    method: 'PATCH',
    path: path('/v1/notes/:id'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const u = parse(NoteUpdateSchema, await ctx.body());
      await ctx.db.tx(async (q) => {
        const note = (await q<{ author_id: string; visibility: string }>(`select n.author_id, n.visibility from segue.notes n where n.id = $2 and ${canSeeNote('n', '$1')} for update`, [ctx.user.id, id]))[0];
        if (!note) throw new HttpError(404, "Couldn't find that note");
        if (note.author_id !== ctx.user.id) throw new HttpError(403, 'Only the person who wrote this note can change it');
        const sets: string[] = [];
        const params: unknown[] = [id];
        const set = (col: string, v: unknown) => (params.push(v), sets.push(`${col} = $${params.length}`));
        if (u.title !== undefined) set('title', u.title);
        if (u.body !== undefined) set('body', u.body);
        if (u.visibility !== undefined) set('visibility', u.visibility);
        if (u.onDate !== undefined) set('on_date', u.onDate);
        if (u.placeName !== undefined) set('place_name', u.placeName);
        if (u.blockId !== undefined) set('block_id', u.blockId);
        if (u.pinned !== undefined) set('pinned', u.pinned);
        if (u.openToJoin !== undefined) set('open_to_join', u.openToJoin);
        if (u.archived !== undefined) sets.push(u.archived ? 'archived_at = coalesce(archived_at, now())' : 'archived_at = null');
        if (sets.length) await q(`update segue.notes set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
        const visibility = u.visibility ?? note.visibility;
        if (u.shareWith) await setShares(q, ctx, id, u.shareWith, visibility);
        else if (u.visibility === 'selected' && note.visibility !== 'selected') {
          // Switching back to "selected": the people already on the list get to know.
          const people = await q<{ user_id: string }>('select user_id from segue.note_shares where note_id = $1', [id]);
          await notifyShared(q, ctx.user.id, id, people.map((x) => x.user_id));
        }
      });
      return { status: 200, body: { note: await loadNote(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    method: 'DELETE',
    path: path('/v1/notes/:id'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      const note = (await ctx.db.query<{ author_id: string }>(`select n.author_id from segue.notes n where n.id = $2 and ${canSeeNote('n', '$1')}`, [ctx.user.id, id]))[0];
      if (!note) throw new HttpError(404, "Couldn't find that note");
      if (note.author_id !== ctx.user.id) throw new HttpError(403, 'Only the person who wrote this note can delete it');
      // Hearts and shares go with it; invitations already sent stay, without the link to the note.
      await ctx.db.query('delete from segue.notes where id = $1 and author_id = $2', [id, ctx.user.id]);
      return { status: 200, body: { deleted: true } };
    },
  },
  {
    method: 'POST',
    path: path('/v1/notes/:id/heart'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      await ctx.db.tx(async (q) => {
        const note = (await q<{ author_id: string; archived_at: unknown; open_to_join: boolean }>(`select n.author_id, n.archived_at, n.open_to_join from segue.notes n where n.id = $2 and ${canSeeNote('n', '$1')}`, [ctx.user.id, id]))[0];
        if (!note) throw new HttpError(404, "Couldn't find that note");
        if (note.author_id === ctx.user.id) throw new HttpError(400, "You can't ask to join your own plan");
        if (note.archived_at) throw new HttpError(409, 'This note is archived');
        if (!note.open_to_join) throw new HttpError(409, "This plan isn't open to join requests", undefined, {}, 'not_open');
        const before = (await q<{ declined_at: unknown }>('select declined_at from segue.note_interests where note_id = $1 and user_id = $2', [id, ctx.user.id]))[0];
        if (before?.declined_at) throw new HttpError(409, 'They said not this time for this plan', undefined, {}, 'not_now');
        // One heart per person per note: a second tap is harmless, and a withdrawn heart comes back.
        await q(
          `insert into segue.note_interests (note_id, user_id) values ($1, $2)
           on conflict (note_id, user_id) do update set withdrawn_at = null, updated_at = now() where segue.note_interests.withdrawn_at is not null`,
          [id, ctx.user.id],
        );
        // Notified once per person per note, however often they heart and un-heart.
        await notify(q, { recipient: note.author_id, actor: ctx.user.id, type: 'note_hearted', entityType: 'note', entityId: id, dedupe: `heart:${id}:${ctx.user.id}`, pref: 'hearts' });
      });
      return { status: 200, body: { note: await loadNote(ctx.db.query, ctx.user.id, id) } };
    },
  },
  {
    method: 'DELETE',
    path: path('/v1/notes/:id/heart'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id] = ctx.params as [string];
      // Allowed even if the note is no longer shared with you: it's your own interest.
      const rows = await ctx.db.query<{ inv_status: string | null }>(
        `update segue.note_interests i set withdrawn_at = now(), updated_at = now()
         where i.note_id = $1 and i.user_id = $2 and i.withdrawn_at is null
         returning (select status from segue.invitations v where v.id = i.invitation_id) as inv_status`,
        [id, ctx.user.id],
      );
      // Taking a heart back never cancels an invitation; say so if one is still open.
      const open = rows[0]?.inv_status === 'pending' || rows[0]?.inv_status === 'accepted';
      return { status: 200, body: { hearted: false, invitationStillOpen: open } };
    },
  },
  {
    // Who would like to be invited. Only the author sees this, and only people who can still see the note.
    method: 'GET',
    path: path('/v1/notes/:id/interests'),
    async handler(ctx) {
      await ctx.profile();
      const [id] = ctx.params as [string];
      const note = (await ctx.db.query<{ author_id: string }>(`select n.author_id from segue.notes n where n.id = $2 and ${canSeeNote('n', '$1')}`, [ctx.user.id, id]))[0];
      if (!note) throw new HttpError(404, "Couldn't find that note");
      if (note.author_id !== ctx.user.id) throw new HttpError(403, 'Only the person who wrote this note can see who is interested');
      const rows = await ctx.db.query(
        `select i.id, i.created_at, i.withdrawn_at, i.declined_at, i.invitation_id, v.status as inv_status, v.expires_at as inv_expires, ${profileCols('p')}
         from segue.note_interests i
         join segue.notes n on n.id = i.note_id
         join segue.profiles p on p.id = i.user_id
         left join segue.invitations v on v.id = i.invitation_id
         where i.note_id = $1 and i.withdrawn_at is null and ${interestStillVisible('n', 'i')}
         order by i.created_at`,
        [id],
      );
      const interests: InterestView[] = rows.map((r) => ({
        id: String(r.id),
        user: publicProfile(r, 'p'),
        status: interestStatus(r.withdrawn_at, r.inv_status, r.inv_expires, r.declined_at),
        invitationId: (r.invitation_id as string | null) ?? null,
        createdAt: isoReq(r.created_at),
      }));
      return { status: 200, body: { interests } };
    },
  },
  {
    // "Yes, join me": the author says yes to a request. It becomes a plan you're both in (the person asked, so there's
    // nothing more for them to accept). It never changes either person's own day.
    method: 'POST',
    path: path('/v1/notes/:id/interests/:id/accept'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id, interestId] = ctx.params as [string, string];
      const b = parse(JoinAcceptSchema, await ctx.body());
      const now = ctx.deps.now?.() ?? Date.now();
      if (b.endsAt && !b.startsAt) throw new HttpError(400, 'Add a start time before an end time');
      if (b.startsAt && Date.parse(b.startsAt) < now - 60 * 60_000) throw new HttpError(400, 'That time has already passed');
      if (b.startsAt && b.endsAt && (Date.parse(b.endsAt) <= Date.parse(b.startsAt) || Date.parse(b.endsAt) - Date.parse(b.startsAt) > 24 * 60 * 60_000)) {
        throw new HttpError(400, 'The end has to be after the start, within a day');
      }
      const activityId = await ctx.db.tx(async (q) => {
        const r = (
          await q<{ author_id: string; title: string; body: string; place_name: string | null; archived_at: unknown; user_id: string; withdrawn_at: unknown; declined_at: unknown; inv_status: string | null; inv_expires: unknown; can_see: boolean; blocked: boolean }>(
            `select n.author_id, n.title, n.body, n.place_name, n.archived_at, i.user_id, i.withdrawn_at, i.declined_at,
                    v.status as inv_status, v.expires_at as inv_expires,
                    ${canSeeNote('n', 'i.user_id')} as can_see, ${blockedBetween('i.user_id', 'n.author_id')} as blocked
             from segue.note_interests i join segue.notes n on n.id = i.note_id left join segue.invitations v on v.id = i.invitation_id
             where n.id = $1 and i.id = $2 for update of i`,
            [id, interestId],
          )
        )[0];
        if (!r || r.author_id !== ctx.user.id) throw new HttpError(404, "Couldn't find that request");
        if (r.archived_at) throw new HttpError(409, 'This note is archived');
        const status = interestStatus(r.withdrawn_at, r.inv_status, r.inv_expires, r.declined_at);
        if (status === 'accepted' || status === 'invited') throw new HttpError(409, "You've already answered this request", undefined, {}, 'already_answered');
        if (status !== 'interested') throw new HttpError(409, "This request isn't open any more", undefined, {}, 'not_open');
        // They must still be allowed to see the plan (sharing can be taken back), and nobody blocked anybody.
        if (!r.can_see || r.blocked) throw new HttpError(409, "This request isn't open any more", undefined, {}, 'not_open');
        const act = await q<{ id: string }>(
          `insert into segue.activities (created_by, title, description, starts_at, ends_at, timezone, place_name, meeting_notes, source_note_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [ctx.user.id, r.title, String(r.body).slice(0, 2000), b.startsAt ?? null, b.endsAt ?? null, b.timezone, b.placeName === undefined ? r.place_name : b.placeName, b.meetingNotes ?? '', id],
        );
        const inv = await q<{ id: string }>(
          `insert into segue.invitations (activity_id, sender_id, recipient_id, status, responded_at) values ($1, $2, $3, 'accepted', now()) returning id`,
          [act[0]!.id, ctx.user.id, r.user_id],
        );
        await q('update segue.note_interests set invitation_id = $1, updated_at = now() where id = $2', [inv[0]!.id, interestId]);
        await notify(q, { recipient: r.user_id, actor: ctx.user.id, type: 'join_accepted', entityType: 'invitation', entityId: inv[0]!.id, dedupe: `join_accepted:${inv[0]!.id}`, pref: 'invitations' });
        return act[0]!.id;
      });
      return { status: 201, body: { invitations: await loadInvitations(ctx.db.query, ctx.user.id, 'v.activity_id = $2', [activityId]) } };
    },
  },
  {
    // "Not this time": the request is closed and they're told kindly. They can't ask again for this plan.
    method: 'POST',
    path: path('/v1/notes/:id/interests/:id/decline'),
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('write');
      const [id, interestId] = ctx.params as [string, string];
      await ctx.db.tx(async (q) => {
        const r = (
          await q<{ author_id: string; user_id: string; withdrawn_at: unknown; declined_at: unknown; inv_status: string | null; inv_expires: unknown }>(
            `select n.author_id, i.user_id, i.withdrawn_at, i.declined_at, v.status as inv_status, v.expires_at as inv_expires
             from segue.note_interests i join segue.notes n on n.id = i.note_id left join segue.invitations v on v.id = i.invitation_id
             where n.id = $1 and i.id = $2 for update of i`,
            [id, interestId],
          )
        )[0];
        if (!r || r.author_id !== ctx.user.id) throw new HttpError(404, "Couldn't find that request");
        const status = interestStatus(r.withdrawn_at, r.inv_status, r.inv_expires, r.declined_at);
        if (status === 'not_now') return; // already said; a second tap is harmless
        if (status !== 'interested') throw new HttpError(409, "This request isn't open any more", undefined, {}, 'not_open');
        await q('update segue.note_interests set declined_at = now(), updated_at = now() where id = $1', [interestId]);
        await notify(q, { recipient: r.user_id, actor: ctx.user.id, type: 'join_declined', entityType: 'note', entityId: id, dedupe: `join_declined:${interestId}`, pref: 'invitations' });
      });
      return { status: 200, body: { declined: true } };
    },
  },
];

