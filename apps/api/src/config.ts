export interface Config {
  port: number;
  placesProvider: 'osm' | 'google' | 'mock';
  googlePlacesApiKey?: string;
  /** Daily cap on paid Google calls before falling back to OSM. */
  googleDailyBudget: number;
  corsOrigins: string[];
  rerouteRateLimit: number;
  /** "Ask in your own words" via Claude. Needs Anthropic credentials. */
  smartAdd: boolean;
  smartAddRateLimit: number;
  /** Reads (places, weather, place names) per client per hour. Each one can reach a free upstream service. */
  readRateLimit: number;
  /** All clients together: paid smart-add calls per UTC day. 0 turns the cap off. */
  smartAddDailyCap: number;
  /** A header the host sets to the real client IP (for example x-real-ip). Wins over x-forwarded-for. */
  clientIpHeader?: string;
  /** Proxies in front of this server that each append to x-forwarded-for. */
  trustedProxyHops: number;
  /** Postgres for accounts, notes and invitations (Supabase's connection string). Unset = accounts off. */
  databaseUrl?: string;
  databaseSsl: 'require' | 'verify' | 'off';
  /** PEM certificate for DATABASE_SSL=verify (Supabase's CA). */
  databaseCa?: string;
  /** Apply new database migrations when the server starts. */
  migrateOnStart: boolean;
  /** https://<project>.supabase.co — sign-in tokens are checked against its public keys. */
  supabaseUrl?: string;
  /** Legacy Supabase JWT secret, for projects still signing tokens with HS256. */
  supabaseJwtSecret?: string;
  /** Lets "Delete my account" remove the sign-in too. Server only, never sent to the browser. */
  supabaseServiceRoleKey?: string;
  /** Per signed-in user, per hour. */
  socialWriteRateLimit: number;
  reservedUsernames: string[];
  searchRateLimit: number;
}

/** A non-negative whole number from the environment, or the fallback when it is unset. */
function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, 0 or more (got "${raw}")`);
  return n;
}

function sslMode(raw: string | undefined): Config['databaseSsl'] {
  const v = (raw ?? 'require').trim().toLowerCase();
  if (v !== 'require' && v !== 'verify' && v !== 'off') throw new Error(`DATABASE_SSL must be require, verify or off (got "${raw}")`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.PLACES_PROVIDER ?? 'osm').toLowerCase();
  if (!['osm', 'google', 'mock'].includes(provider)) {
    throw new Error(`PLACES_PROVIDER must be osm, google or mock (got "${provider}")`);
  }
  if (provider === 'google' && !env.GOOGLE_PLACES_API_KEY) {
    throw new Error('PLACES_PROVIDER=google needs GOOGLE_PLACES_API_KEY');
  }
  return {
    port: Number(env.PORT ?? 8787),
    placesProvider: provider as Config['placesProvider'],
    googlePlacesApiKey: env.GOOGLE_PLACES_API_KEY || undefined,
    googleDailyBudget: Number(env.GOOGLE_DAILY_BUDGET ?? 500),
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    rerouteRateLimit: Number(env.REROUTE_RATE_LIMIT ?? 60),
    // On with SMART_ADD=on, or automatically when an Anthropic key is set (SMART_ADD=off wins).
    smartAdd: env.SMART_ADD === 'on' || (env.SMART_ADD !== 'off' && !!env.ANTHROPIC_API_KEY),
    smartAddRateLimit: Number(env.SMART_ADD_RATE_LIMIT ?? 40),
    readRateLimit: count(env, 'READ_RATE_LIMIT', 300),
    smartAddDailyCap: count(env, 'SMART_ADD_DAILY_CAP', 300),
    clientIpHeader: env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
    trustedProxyHops: count(env, 'TRUSTED_PROXY_HOPS', 1),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    databaseSsl: sslMode(env.DATABASE_SSL),
    databaseCa: env.DATABASE_CA?.trim() || undefined,
    migrateOnStart: env.MIGRATE_ON_START !== 'off',
    supabaseUrl: env.SUPABASE_URL?.trim().replace(/\/+$/, '') || undefined,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET?.trim() || undefined,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined,
    socialWriteRateLimit: count(env, 'SOCIAL_WRITE_RATE_LIMIT', 300),
    reservedUsernames: (env.RESERVED_USERNAMES ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
    searchRateLimit: count(env, 'SEARCH_RATE_LIMIT', 60),
  };
}
