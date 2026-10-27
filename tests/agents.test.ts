/**
 * Kolejka agentów PC: claim zleceń analizy, heartbeat, lista pracy. Prawdziwa baza z docker compose (tracker_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test';

let svc: typeof import('../src/server/service.ts');
let ag: typeof import('../src/server/agents.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let dz: typeof import('drizzle-orm');
let P: import('../src/server/projects.ts').Project;
let alice: { id: number; name: string };
let bob: { id: number; name: string };
let outsider: { id: number; name: string };

const DEV_A1 = '11111111-1111-4111-8111-111111111111';
const DEV_A2 = '22222222-2222-4222-8222-222222222222';
const DEV_B1 = '33333333-3333-4333-8333-333333333333';
const DEV_O1 = '44444444-4444-4444-8444-444444444444';

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test with (force)');
  await admin.unsafe('create database tracker_test');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  ag = await import('../src/server/agents.ts');
  schema = await import('../src/db/schema.ts');
  dz = await import('drizzle-orm');
  const projects = await import('../src/server/projects.ts');
  const { db } = dbmod;
  const [creator] = await db.insert(schema.users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'AGT', name: 'Agents' });
  await db.delete(schema.projectMembers).where(dz.eq(schema.projectMembers.userId, creator.id));
  await svc.seedDefaults();
  [alice] = await db.insert(schema.users).values({ login: 'alice', name: 'Alice' }).returning();
  [bob] = await db.insert(schema.users).values({ login: 'bob', name: 'Bob' }).returning();
  [outsider] = await db.insert(schema.users).values({ login: 'outsider', name: 'Outsider' }).returning();
  await db.insert(schema.projectMembers).values([{ projectId: P.id, userId: alice.id }, { projectId: P.id, userId: bob.id }]);
  await db.insert(schema.agents).values([
    { id: DEV_A1, userId: alice.id, name: 'ALICE-PC', repoKeys: ['AGT'] },
    { id: DEV_A2, userId: alice.id, name: 'ALICE-LAPTOP', repoKeys: ['AGT'] },
    { id: DEV_B1, userId: bob.id, name: 'BOB-PC', repoKeys: ['AGT'] },
    { id: DEV_O1, userId: outsider.id, name: 'OUT-PC', repoKeys: ['AGT'] },
  ]);
});
afterAll(async () => { await dbmod?.sql.end(); });

const newIssue = async (title = 't') => (await svc.createIssue(P, null, { title })).number;
const row = async (number: number) => {
  const [r] = await dbmod.db.select().from(schema.issues).where(dz.and(dz.eq(schema.issues.projectId, P.id), dz.eq(schema.issues.number, number)));
  return r;
};
const setTeamQueue = async (on: boolean) => { P = await (await import('../src/server/projects.ts')).updateProject(P.id, { agentTeamQueue: on }); };
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { code: string }).code);

describe('claimAnalysis', () => {
  it('lets exactly one of two concurrent devices win', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    // Obie przejmują jako zlecający, z dwóch własnych urządzeń.
    const res = await Promise.allSettled([ag.claimAnalysis(P, alice, n, DEV_A1), ag.claimAnalysis(P, alice, n, DEV_A2)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('conflict');
  });

  it('is idempotent for the same device and returns deep and model', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n, true);
    const a = await ag.claimAnalysis(P, alice, n, DEV_A1);
    const b = await ag.claimAnalysis(P, alice, n, DEV_A1);
    expect(a.deep).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.model).toBe('opus');
    // Aktywność "claimed" tylko raz.
    const acts = await dbmod.db.select().from(schema.activity).where(dz.eq(schema.activity.issueId, (await row(n)).id));
    expect(acts.filter((x) => x.payload.kind === 'analysis_claimed')).toHaveLength(1);
  });

  it('fails when nothing is requested', async () => {
    const n = await newIssue();
    expect(await code(ag.claimAnalysis(P, alice, n, DEV_A1))).toBe('conflict');
  });

  it('lets another device take over an expired claim', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    expect(await code(ag.claimAnalysis(P, alice, n, DEV_A2))).toBe('conflict');
    await dbmod.sql`update issues set analysis_claimed_at = now() - interval '31 minutes' where id = ${(await row(n)).id}`;
    await expect(ag.claimAnalysis(P, alice, n, DEV_A2)).resolves.toMatchObject({ ok: true });
    expect((await row(n)).analysisClaimedDevice).toBe(DEV_A2);
  });

  it('respects the team queue and the local reservation', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await setTeamQueue(false);
    expect(await code(ag.claimAnalysis(P, bob, n, DEV_B1))).toBe('conflict');
    await setTeamQueue(true);
    await expect(ag.claimAnalysis(P, bob, n, DEV_B1)).resolves.toMatchObject({ ok: true });

    // Kliknięte na PC zlecającego: przez 60 s tylko on (link tracker:// zaraz ruszy).
    const m = await newIssue();
    await svc.requestAnalysis(P, alice, m, false, true);
    expect(await code(ag.claimAnalysis(P, bob, m, DEV_B1))).toBe('conflict');
    await expect(ag.claimAnalysis(P, alice, m, DEV_A1)).resolves.toMatchObject({ ok: true });
    await setTeamQueue(false);
  });

  it('refuses a device of another user', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    expect(await code(ag.claimAnalysis(P, alice, n, DEV_B1))).toBe('forbidden');
    expect(await code(ag.claimAnalysis(P, alice, n, '55555555-5555-4555-8555-555555555555'))).toBe('invalid');
  });
});

describe('claim lifecycle', () => {
  const claimed = async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    expect((await row(n)).analysisClaimedDevice).toBe(DEV_A1);
    return n;
  };
  const clear = (r: Awaited<ReturnType<typeof row>>) => {
    expect([r.analysisClaimedAt, r.analysisClaimedBy, r.analysisClaimedDevice, r.analysisLocalUntil]).toEqual([null, null, null, null]);
  };

  it('is cleared by saving an analysis', async () => {
    const n = await claimed();
    await svc.updateIssue(P, null, n, { analysis: 'done' });
    clear(await row(n));
  });

  it('is cleared by cancelAnalysis', async () => {
    const n = await claimed();
    await svc.cancelAnalysis(P, n);
    clear(await row(n));
  });

  it('is cleared by a new request', async () => {
    const n = await claimed();
    await svc.requestAnalysis(P, alice, n);
    clear(await row(n));
  });

  it('is released only by the claiming device and user', async () => {
    const n = await claimed();
    await ag.releaseClaim(P, alice, n, DEV_A2);
    expect((await row(n)).analysisClaimedDevice).toBe(DEV_A1);
    await ag.releaseClaim(P, bob, n, DEV_A1);
    expect((await row(n)).analysisClaimedDevice).toBe(DEV_A1);
    await ag.releaseClaim(P, alice, n, DEV_A1);
    clear(await row(n));
    expect((await row(n)).analysisRequestedAt).not.toBeNull();
  });
});
