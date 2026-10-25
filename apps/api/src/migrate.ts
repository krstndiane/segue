/**
 * Run database migrations by hand:
 *   pnpm --filter @segue/api migrate          # apply anything new
 *   pnpm --filter @segue/api migrate down     # undo the latest one (deletes its data)
 * The server also applies new migrations when it starts (MIGRATE_ON_START=off turns that off).
 */
import { connect, migrate, rollback } from './db';
import { loadConfig } from './config';

const config = loadConfig();
if (!config.databaseUrl) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}
const db = connect({ url: config.databaseUrl, ssl: config.databaseSsl, ca: config.databaseCa, max: 1 });
try {
  if (process.argv[2] === 'down') {
    const id = await rollback(db);
    console.log(id ? `Rolled back ${id}` : 'Nothing to roll back');
  } else {
    const applied = await migrate(db);
    console.log(applied.length ? `Applied ${applied.join(', ')}` : 'Up to date');
  }
} finally {
  await db.close();
}
