/**
 * Paused: powód, bloker, auto-wznowienie i jedna rola na projekt. Prawdziwa baza z docker compose (tracker_paused_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_paused_test';

let svc: typeof import('../src/server/service.ts');
let dbmod: typeof import('../src/db/index.ts');
let P: import('../src/server/projects.ts').Project;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_paused_test with (force)');
  await admin.unsafe('create database tracker_paused_test');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  const projects = await import('../src/server/projects.ts');
  await svc.seedDefaults();
  const { users, projectMembers } = await import('../src/db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const [creator] = await dbmod.db.insert(users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'PAU', name: 'Pause' });
  await dbmod.db.delete(projectMembers).where(eq(projectMembers.userId, creator.id));
});
afterAll(async () => { await dbmod?.sql.end(); });

const statusId = async (name: string) => (await svc.getMeta(P)).statuses.find((s) => s.name === name)!.id;
const make = async (title: string, status: string) => svc.createIssue(P, null, { title, statusId: await statusId(status) });

describe('paused', () => {
  it('stores reason and previous status when entering Paused, and clears them on leaving', async () => {
    const a = await make('reason', 'In Progress');
    const r = await svc.updateIssue(P, null, a.number, { statusId: await statusId('Paused'), pauseReason: '  sandbox is off  ' });
    expect(r.pauseReason).toBe('sandbox is off');
    expect(r.pausePrevStatusId).toBe(await statusId('In Progress'));
    const d = await svc.getIssueDetail(P, a.number);
    expect(d.activity.map((x) => x.payload.kind)).toContain('paused');
    expect(d.comments.some((c) => c.body.includes('sandbox is off'))).toBe(true);
    const back = await svc.updateIssue(P, null, a.number, { statusId: await statusId('In Progress') });
    expect(back.pauseReason).toBe('');
    expect(back.pausePrevStatusId).toBeNull();
  });

  it('creates a waits_on relation from pauseWaitsOn', async () => {
    const blocker = await make('blocker', 'Todo');
    const w = await make('waiter', 'In Progress');
    await svc.updateIssue(P, null, w.number, { statusId: await statusId('Paused'), pauseWaitsOn: blocker.number });
    const d = await svc.getIssueDetail(P, w.number);
    expect(d.relations.waitingOn.map((x) => x.number)).toEqual([blocker.number]);
  });

  it('resumes the paused issue to its previous status when the blocker closes', async () => {
    const blocker = await make('blocker2', 'Todo');
    const w = await make('waiter2', 'In Progress');
    await svc.updateIssue(P, null, w.number, { statusId: await statusId('Paused'), pauseWaitsOn: blocker.number });
    await svc.updateIssue(P, null, blocker.number, { statusId: await statusId('Done') });
    const d = await svc.getIssueDetail(P, w.number);
    expect(d.statusId).toBe(await statusId('In Progress'));
    expect(d.pauseReason).toBe('');
    expect(d.pausePrevStatusId).toBeNull();
    expect(d.activity.map((x) => x.payload.kind)).toContain('resumed');
  });

  it('does not resume while a second open blocker remains', async () => {
    const b1 = await make('b1', 'Todo');
    const b2 = await make('b2', 'Todo');
    const w = await make('waiter3', 'In Progress');
    await svc.updateIssue(P, null, w.number, { statusId: await statusId('Paused'), pauseWaitsOn: b1.number });
    const { addRelation } = await import('../src/server/relations.ts');
    await addRelation(P, null, w.number, 'waits_on', b2.number);
    await svc.updateIssue(P, null, b1.number, { statusId: await statusId('Done') });
    expect((await svc.getIssueDetail(P, w.number)).statusId).toBe(await statusId('Paused'));
    await svc.updateIssue(P, null, b2.number, { statusId: await statusId('Done') });
    expect((await svc.getIssueDetail(P, w.number)).statusId).toBe(await statusId('In Progress'));
  });

  it('setting a role on another status removes it from the original', async () => {
    const before = (await svc.getMeta(P)).statuses;
    const testing = before.find((s) => s.role === 'testing')!;
    const other = before.find((s) => s.name === 'Todo')!;
    await svc.saveStatus(P, { id: other.id, role: 'testing' });
    const after = (await svc.getMeta(P)).statuses;
    expect(after.find((s) => s.id === other.id)!.role).toBe('testing');
    expect(after.find((s) => s.id === testing.id)!.role).toBeNull();
    expect(after.filter((s) => s.role === 'testing')).toHaveLength(1);
  });
});
