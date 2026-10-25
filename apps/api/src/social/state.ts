/**
 * Your planner on every device: routines and one-offs, settings, saved
 * places, place history and past days. One JSON value per key, each with a
 * version. A write must say which version it started from; if another
 * device saved in between, the write is refused (409) with the newer value,
 * so stale data never silently replaces newer data.
 *
 * Google Calendar events are never sent here: they stay on the device.
 */
import { StatePutSchema, SyncKeySchema, type StateItem } from '@segue/schemas';
import { HttpError } from '../http';
import { parse, path, type Route } from './core';
import { isoReq, type Row } from './views';

/** Biggest value per key (the past-days archive is the large one). */
export const MAX_STATE_BYTES = 480 * 1024;

const item = (r: Row): StateItem => ({ value: r.value, version: Number(r.version), updatedAt: isoReq(r.updated_at) });

/** Settings never carry a precise position to the server. */
function clean(key: string, value: unknown): unknown {
  if (key !== 'settings' || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { lastLocation: _a, lastLocationLabel: _b, lastLocatedAt: _c, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Past days: anything that came from Google Calendar stays on the device. */
function withoutCalendar(key: string, value: unknown): unknown {
  if (key !== 'dayArchive' || !value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [date, day] of Object.entries(value as Record<string, { items?: { blockId?: string }[] }>)) {
    if (!day || typeof day !== 'object') continue;
    out[date] = { ...day, items: (day.items ?? []).filter((i) => !String(i?.blockId ?? '').startsWith('gcal_')) };
  }
  return out;
}

export const stateRoutes: Route[] = [
  {
    method: 'GET',
    path: path('/v1/state'),
    async handler(ctx) {
      await ctx.profile();
      const rows = await ctx.db.query('select key, value, version, updated_at from segue.user_state where user_id = $1', [ctx.user.id]);
      return { status: 200, body: { items: Object.fromEntries(rows.map((r) => [String(r.key), item(r)])) } };
    },
  },
  {
    method: 'PUT',
    path: /^\/v1\/state\/([A-Za-z]+)$/,
    async handler(ctx) {
      await ctx.profile();
      ctx.limit('sync');
      const key = parse(SyncKeySchema, ctx.url.pathname.split('/').pop());
      const { value, baseVersion } = parse(StatePutSchema, await ctx.body({ limit: MAX_STATE_BYTES + 1024 }));
      const stored = withoutCalendar(key, clean(key, value));
      const json = JSON.stringify(stored);
      if (Buffer.byteLength(json) > MAX_STATE_BYTES) throw new HttpError(413, 'That is more than Segue can sync for one device');
      return ctx.db.tx(async (q) => {
        const current = (await q('select value, version, updated_at from segue.user_state where user_id = $1 and key = $2 for update', [ctx.user.id, key]))[0];
        const have = current ? Number(current.version) : 0;
        if (have !== baseVersion) {
          throw new HttpError(409, 'Another device saved this first', { current: current ? item(current) : null }, {}, 'version_conflict');
        }
        const row = (
          await q(
            `insert into segue.user_state (user_id, key, value, version) values ($1, $2, $3::jsonb, $4)
             on conflict (user_id, key) do update set value = excluded.value, version = excluded.version, updated_at = now()
             returning value, version, updated_at`,
            [ctx.user.id, key, json, have + 1],
          )
        )[0]!;
        return { status: 200, body: { item: item(row) } };
      });
    },
  },
];
