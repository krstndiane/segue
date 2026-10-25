/**
 * Postgres access for accounts and the social features. One small pool,
 * parameterised queries only, and a transaction helper for anything that
 * changes more than one row.
 */
import pg from 'pg';
import { MIGRATIONS, type Migration } from './migrations';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs `fn` in one transaction: all of it happens, or none of it. */
  tx<T>(fn: (q: Db['query']) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// DATE columns stay "YYYY-MM-DD" strings (pg would turn them into local-midnight Dates).
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') =>
    oid === 1082 ? (v: string) => v : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export interface DbOptions {
  url: string;
  /** 'require' (default): encrypted; 'verify': also check the server certificate (needs `ca` for Supabase); 'off': local only. */
  ssl?: 'require' | 'verify' | 'off';
  ca?: string;
  max?: number;
}

export function connect(opts: DbOptions): Db {
  const mode = opts.ssl ?? 'require';
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: mode === 'off' ? false : mode === 'verify' ? { rejectUnauthorized: true, ca: opts.ca } : { rejectUnauthorized: false },
    types,
  });
  pool.on('error', (e) => console.error(`database pool error: ${e.message}`));
  const query: Db['query'] = async <T,>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
  return {
    query,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(async <T,>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[]);
        await client.query('commit');
        return out;
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Lock id so two servers starting at once don't migrate together. */
const MIGRATION_LOCK = 7_420_311;

/** Applies migrations that haven't run yet. Returns the ids it applied. */
export async function migrate(db: Db, list: Migration[] = MIGRATIONS): Promise<string[]> {
  return db.tx(async (q) => {
    await q('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await q('create schema if not exists segue');
    await q('create table if not exists segue.schema_migrations (id text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await q<{ id: string }>('select id from segue.schema_migrations')).map((r) => r.id));
    const applied: string[] = [];
    for (const m of list) {
      if (done.has(m.id)) continue;
      await q(m.up);
      await q('insert into segue.schema_migrations (id) values ($1)', [m.id]);
      applied.push(m.id);
    }
    return applied;
  });
}

/** Undoes the most recent migration. For development and rollbacks; deletes that migration's data. */
export async function rollback(db: Db, list: Migration[] = MIGRATIONS): Promise<string | null> {
  return db.tx(async (q) => {
    await q('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    const last = (await q<{ id: string }>('select id from segue.schema_migrations order by applied_at desc, id desc limit 1'))[0];
    if (!last) return null;
    const m = list.find((x) => x.id === last.id);
    if (!m) throw new Error(`Unknown migration ${last.id}`);
    await q(m.down);
    await q('delete from segue.schema_migrations where id = $1', [m.id]);
    return m.id;
  });
}
