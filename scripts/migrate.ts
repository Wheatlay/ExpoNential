// Uruchamia migracje na DATABASE_URL (np. do sprawdzenia migracji na kopii bazy).
import { runMigrations, sql } from '../src/db/index.ts';

await runMigrations();
await sql.end();
console.log('migrations ok');
