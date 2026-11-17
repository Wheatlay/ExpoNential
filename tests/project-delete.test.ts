/**
 * Usuwanie projektu: wymaga wpisanego klucza, kasuje całą zawartość, nie rusza innych projektów.
 * Prawdziwa baza z docker compose (tracker_project_delete_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_project_delete_test';

let svc: typeof import('../src/server/service.ts');
let projects: typeof import('../src/server/projects.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let userId: number;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_project_delete_test with (force)');
  await admin.unsafe('create database tracker_project_delete_test');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  projects = await import('../src/server/projects.ts');
  schema = await import('../src/db/schema.ts');
  await svc.seedDefaults();
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'pd', name: 'Deleter' }).returning();
  userId = u.id;
});
afterAll(async () => { await dbmod?.sql.end(); });

async function withIssues(key: string) {
  const p = await projects.createProject(userId, { key, name: key });
  const statusId = (await svc.getMeta(p)).statuses[0].id;
  const a = await svc.createIssue(p, null, { title: 'first', statusId });
  const b = await svc.createIssue(p, null, { title: 'second', statusId });
  await svc.addComment(p, null, a.number, 'hello');
  await svc.updateIssue(p, null, b.number, { statusId: (await svc.getMeta(p)).statuses[1].id });
  return p;
}

describe('deleteProject', () => {
  it('refuses without the typed key', async () => {
    const p = await withIssues('DELA');
    await expect(projects.deleteProject(p, 'nope')).rejects.toThrow('Type the project key to confirm');
    expect(await projects.getProjectByKey('DELA')).toBeTruthy();
  });

  it('removes the project with its issues and leaves other projects alone', async () => {
    const p = await withIssues('DELB');
    const other = await withIssues('KEEP');
    await projects.deleteProject(p, ' delb ');
    expect(await projects.getProjectByKey('DELB')).toBeFalsy();
    const { eq } = await import('drizzle-orm');
    expect(await dbmod.db.select().from(schema.issues).where(eq(schema.issues.projectId, p.id))).toHaveLength(0);
    expect(await dbmod.db.select().from(schema.statuses).where(eq(schema.statuses.projectId, p.id))).toHaveLength(0);
    expect(await dbmod.db.select().from(schema.issues).where(eq(schema.issues.projectId, other.id))).toHaveLength(2);
  });
});
