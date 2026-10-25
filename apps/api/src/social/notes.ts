/**
 * Notes and hearts.
 *
 * A note is private unless its author says otherwise: shared with selected
 * people, or discoverable. A heart on someone else's note means "I'd like to
 * be invited": it records interest and tells the author, nothing more. It
 * never adds anything to anyone's plan.
 */
import { NOTE_SCOPES, NoteCreateSchema, NoteUpdateSchema, type InterestView, type NoteView, type PublicProfile } from '@segue/schemas';
import { z } from 'zod';
import type { Db } from '../db';
import { HttpError } from '../http';
import { notify, parse, path, type Ctx, type Route } from './core';
import { canSeeNote, interestStatus, interestStillVisible, isoReq, likeEscape, profileCols, publicProfile, type Row } from './views';

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
  mi.withdrawn_at as mi_withdrawn, inv.status as inv_status, inv.expires_at as inv_expires, mi.id as mi_id
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
  };
  if (mine) {
    view.pinned = !!r.pinned;
    view.blockId = (r.block_id as string | null) ?? null;
    view.heartCount = Number(r.heart_count ?? 0);
    view.sharedWith = shares ?? [];
  } else {
    view.hearted = r.mi_id != null && r.mi_withdrawn == null;
    if (r.mi_id != null) view.interest = interestStatus(r.mi_withdrawn, r.inv_status, r.inv_expires);
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
  const found = wanted.length ? (await q<{ id: string }>('select id from segue.profiles where id = any($1::uuid[])', [wanted])).map((r) => r.id) : [];
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
          where.push(`n.author_id <> $1 and n.archived_at is null and n.visibility = 'discoverable' and a.discoverable`);
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
          `insert into segue.notes (author_id, title, body, visibility, on_date, place_name, block_id, pinned, archived_at, client_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, case when $9 then now() end, $10)
           on conflict (author_id, client_id) do nothing returning id`,
          [ctx.user.id, n.title, n.body ?? '', visibility, n.onDate ?? null, n.placeName ?? null, n.blockId ?? null, n.pinned ?? false, n.archived ?? false, n.clientId ?? null],
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
        const note = (await q<{ author_id: string; archived_at: unknown }>(`select n.author_id, n.archived_at from segue.notes n where n.id = $2 and ${canSeeNote('n', '$1')}`, [ctx.user.id, id]))[0];
        if (!note) throw new HttpError(404, "Couldn't find that note");
        if (note.author_id === ctx.user.id) throw new HttpError(400, "You can't heart your own note");
        if (note.archived_at) throw new HttpError(409, 'This note is archived');
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
        `select i.id, i.created_at, i.withdrawn_at, i.invitation_id, v.status as inv_status, v.expires_at as inv_expires, ${profileCols('p')}
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
        status: interestStatus(r.withdrawn_at, r.inv_status, r.inv_expires),
        invitationId: (r.invitation_id as string | null) ?? null,
        createdAt: isoReq(r.created_at),
      }));
      return { status: 200, body: { interests } };
    },
  },
];

