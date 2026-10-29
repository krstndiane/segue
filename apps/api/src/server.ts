import { createServer } from 'node:http';
import { createApp } from './app';
import { loadConfig } from './config';
import { buildGeocoder, buildPlacesProvider, buildWeatherProvider } from './providers';
import { claudeUnderstand } from './understand';
import { claudeAssistant } from './assistant';
import { createVerifier, deleteAuthUser } from './auth';
import { supabaseAvatarStorage } from './social/avatars';
import { connect, migrate } from './db';
import { createSocial, type SocialRoutes } from './social';

const config = loadConfig();
if (process.env.NODE_ENV === 'production' && !config.corsOrigins.some((o) => o === '*' || o.startsWith('https://'))) {
  console.warn('CORS_ORIGINS has no https origin, so browsers on your real site will be blocked. Set it to your web app URL.');
}
const places = buildPlacesProvider(config);
const understand = config.smartAdd ? claudeUnderstand() : undefined;
/** Checks Segue sign-ins (accounts and the AI assistant both need it). */
const verifier = config.supabaseUrl || config.supabaseJwtSecret ? createVerifier({ supabaseUrl: config.supabaseUrl, jwtSecret: config.supabaseJwtSecret }) : undefined;
// The AI assistant is still in development: it needs ASSISTANT_AI=on as well as the Anthropic key (shared with smart add) and sign-ins.
const assistant = config.assistantAi && config.smartAdd && verifier ? { ask: claudeAssistant(), verifier } : undefined;

/** Accounts need both a database and a way to check sign-ins; without them the planner still works. */
async function buildSocial(): Promise<SocialRoutes | undefined> {
  if (!config.databaseUrl) return undefined;
  if (!config.supabaseUrl && !config.supabaseJwtSecret) {
    console.warn('DATABASE_URL is set but SUPABASE_URL is not, so accounts stay off.');
    return undefined;
  }
  const db = connect({ url: config.databaseUrl, ssl: config.databaseSsl, ca: config.databaseCa });
  if (config.migrateOnStart) {
    const applied = await migrate(db);
    if (applied.length) console.log(`Database migrations applied: ${applied.join(', ')}`);
  }
  const { supabaseUrl, supabaseServiceRoleKey } = config;
  return createSocial({
    db,
    verifier: verifier!,
    deleteAuthUser: supabaseUrl && supabaseServiceRoleKey ? (id) => deleteAuthUser(supabaseUrl, supabaseServiceRoleKey, id) : undefined,
    avatars: supabaseUrl && supabaseServiceRoleKey ? supabaseAvatarStorage(supabaseUrl, supabaseServiceRoleKey) : undefined,
    reservedUsernames: config.reservedUsernames,
    limits: { writesPerHour: config.socialWriteRateLimit, searchesPerHour: config.searchRateLimit },
    log: (l) => console.log(l),
  });
}

const social = await buildSocial().catch((e: Error) => {
  // A database problem must not take the planner down with it.
  console.error(`Accounts are off: ${e.message}`);
  return undefined;
});
const server = createServer(createApp({ config, places, weather: buildWeatherProvider(), understand, geocoder: buildGeocoder(config), social, assistant }));

server.listen(config.port, () => {
  console.log(`Segue API on http://localhost:${config.port} · places: ${places.name} · smart add: ${understand ? 'on' : 'off'} · accounts: ${social ? 'on' : 'off'} · assistant: ${assistant ? 'ai' : 'basic'}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
