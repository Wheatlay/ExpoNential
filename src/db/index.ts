import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema.ts';

const url = process.env.DATABASE_URL ?? 'postgres://tracker:tracker@localhost:5434/tracker';

export const sql = postgres(url, { max: 10, onnotice: () => {} });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export async function runMigrations() {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
