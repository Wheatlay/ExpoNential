/** Spójność bazy: FK ze SET NULL, unikalny lower(login), sprzątanie przy usuwaniu konta. Prawdziwa baza (tracker_test_integrity). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_integrity';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let acc: typeof import('../src/server/account.ts');
let svc: typeof import('../src/server/service.ts');
let pr: typeof import('../src/server/projects.ts');
let P: import('../src/server/projects.ts').Project;
let statusId: number;
let boss: { id: number };

beforeAll(async () => {
  const root = postgres(ADMIN_URL, { onnotice: () => {} });
  await root.unsafe('drop database if exists tracker_test_integrity with (force)');
  await root.unsafe('create database tracker_test_integrity');
  await root.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  svc = await import('../src/server/service.ts');
  pr = await import('../src/server/projects.ts');
  acc = await import('../src/server/account.ts');
  [boss] = await dbmod.db.insert(schema.users).values({ login: 'boss', name: 'Boss', isAdmin: true }).returning();
  P = await pr.createProject(boss.id, { key: 'INT', name: 'Integrity' });
  await svc.seedDefaults();
  const [s] = await dbmod.db.select().from(schema.statuses).limit(1);
  statusId = s.id;
});
afterAll(async () => { await dbmod?.sql.end(); });

const mkIssue = async (n: number, parentId?: number) =>
  (await dbmod.db.insert(schema.issues).values({ projectId: P.id, number: n, title: `t${n}`, statusId, parentId: parentId ?? null }).returning())[0];

describe('db integrity', () => {
  it('deleting a comment nulls reply_to_id of replies', async () => {
    const { db } = dbmod;
    const i = await mkIssue(1);
    const [c] = await db.insert(schema.comments).values({ issueId: i.id, authorId: boss.id, body: 'q' }).returning();
    const [r] = await db.insert(schema.comments).values({ issueId: i.id, authorId: boss.id, body: 'a', replyToId: c.id }).returning();
    await db.delete(schema.comments).where(eq(schema.comments.id, c.id));
    const [after] = await db.select().from(schema.comments).where(eq(schema.comments.id, r.id));
    expect(after.replyToId).toBeNull();
  });

  it('deleting a parent nulls children parent_id', async () => {
    const { db } = dbmod;
    const parent = await mkIssue(2);
    const child = await mkIssue(3, parent.id);
    await db.delete(schema.issues).where(eq(schema.issues.id, parent.id));
    const [after] = await db.select().from(schema.issues).where(eq(schema.issues.id, child.id));
    expect(after.parentId).toBeNull();
  });

  it('login is unique case-insensitively', async () => {
    const { db } = dbmod;
    await db.insert(schema.users).values({ login: 'foo', name: 'foo' });
    await expect(db.insert(schema.users).values({ login: 'Foo', name: 'Foo' })).rejects.toThrow();
  });

  it('deleteAccount removes pairings, tombstones and dismissals', async () => {
    const { db } = dbmod;
    const [u] = await db.insert(schema.users).values({ login: 'leaver', name: 'Leaver' }).returning();
    await db.insert(schema.agentPairings).values({ hash: 'h-leaver', userId: u.id, expiresAt: new Date(Date.now() + 60000) });
    await db.insert(schema.agentTombstones).values({ id: 'dev-leaver', userId: u.id });
    await db.insert(schema.userDismissals).values({ userId: u.id, key: 'x' });
    await acc.deleteAccount(u.id, 'leaver');
    expect(await db.select().from(schema.agentPairings).where(eq(schema.agentPairings.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(schema.agentTombstones).where(eq(schema.agentTombstones.userId, u.id))).toHaveLength(0);
    expect(await db.select().from(schema.userDismissals).where(eq(schema.userDismissals.userId, u.id))).toHaveLength(0);
  });
});
