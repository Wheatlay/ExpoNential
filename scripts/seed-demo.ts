/** Dane demo do lokalnego oglądania UI (ta sama treść co publiczne demo). Czyści wszystkie tabele aplikacji. */
import { runMigrations, sql } from '../src/db/index.ts';
import { seedDemo } from '../src/server/demo/seed.ts';

await runMigrations();
await seedDemo();
await sql.end();
console.log('Demo data seeded. Sign in as login "demo" (DEV_LOGIN=1 /auth/dev?login=demo) or run with DEMO_MODE=1 and open /auth/demo.');
