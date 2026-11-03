/**
 * Kolejka zespołu na zgodę: zlecenie kolegi trafia tylko do komputera, którego właściciel dołączył do projektu.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_team';

let svc: typeof import('../src/server/service.ts');
let ag: typeof import('../src/server/agents.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let projects: typeof import('../src/server/projects.ts');
let P: import('../src/server/projects.ts').Project;
let alice: { id: number; name: string };
let bob: { id: number; name: string };

const DEV_A = '11111111-aaaa-4111-8111-111111111111';
const DEV_B = '22222222-bbbb-4222-8222-222222222222';

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_team with (force)');
  await admin.unsafe('create database tracker_test_team');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  ag = await import('../src/server/agents.ts');
  schema = await import('../src/db/schema.ts');
  projects = await import('../src/server/projects.ts');
  const { db } = dbmod;
  const [creator] = await db.insert(schema.users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'TQ', name: 'Team' });
  await svc.seedDefaults();
  [alice] = await db.insert(schema.users).values({ login: 'alice', name: 'Alice' }).returning();
  [bob] = await db.insert(schema.users).values({ login: 'bob', name: 'Bob' }).returning();
  await db.insert(schema.projectMembers).values([{ projectId: P.id, userId: alice.id }, { projectId: P.id, userId: bob.id }]);
  const now = new Date();
  await db.insert(schema.agents).values([
    { id: DEV_A, userId: alice.id, name: 'ALICE-PC', version: ag.agentScriptsVersion(), lastSeenAt: now },
    { id: DEV_B, userId: bob.id, name: 'BOB-PC', version: ag.agentScriptsVersion(), lastSeenAt: now },
  ]);
  await db.insert(schema.agentRepos).values([DEV_A, DEV_B].map((agentId) => ({ agentId, projectId: P.id, path: 'C:/tq', source: 'manual' as const })));
  P = await projects.updateProject(P.id, { agentTeamQueue: true });
});
afterAll(async () => { await dbmod?.sql.end(); });

const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { code: string }).code);
const agentOf = async (id: string) => {
  const [a] = await dbmod.sql`select * from agents where id = ${id}`;
  return { id, busy: false, repoKeys: a.repo_keys as string[], version: a.version as string };
};
const keys = (jobs: Awaited<ReturnType<typeof ag.pendingWork>>) => jobs.filter((j) => j.kind === 'analyze').map((j) => (j as { key: string }).key);
const requested = async (user: { id: number; name: string }) => {
  const n = (await svc.createIssue(P, null, { title: 't' })).number;
  await svc.requestAnalysis(P, user, n);
  return n;
};
const clear = () => dbmod.sql`update issues set analysis_requested_at = null, analysis_claimed_at = null, analysis_claimed_device = null`;
const runner = (by: number) => ag.analysisRunner(P, { analysisRequestedBy: by, analysisClaimedDevice: null, analysisRequestedAt: new Date(), analysisClaimedAt: null });

describe('team queue opt-in', () => {
  it('does not offer or let a non-joined device claim a teammate request; own requests are unaffected', async () => {
    await clear();
    const n = await requested(alice), m = await requested(bob);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toEqual([`TQ-${m}`]);
    expect(await code(ag.claimAnalysis(P, bob, n, DEV_B))).toBe('conflict');
    await expect(ag.claimAnalysis(P, bob, m, DEV_B)).resolves.toMatchObject({ ok: true });
  });

  it('offers and allows the claim after PUT, and stops after DELETE', async () => {
    await clear();
    const n = await requested(alice);
    await ag.joinTeamQueue(bob, DEV_B, 'TQ');
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${n}`);
    await ag.leaveTeamQueue(bob, DEV_B, 'TQ');
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).not.toContain(`TQ-${n}`);
    expect(await code(ag.claimAnalysis(P, bob, n, DEV_B))).toBe('conflict');
    // Alice offline, komputer Boba bez zgody: nikt nie może wziąć zlecenia Alice.
    await dbmod.sql`update agents set last_seen_at = now() - interval '1 hour' where id = ${DEV_A}`;
    const r = await runner(alice.id);
    expect(r.noCapablePc).toBe(true);
    expect(r.canRun).toBe(false);
    await ag.joinTeamQueue(bob, DEV_B, 'TQ');
    expect((await runner(alice.id)).noCapablePc).toBe(false);
    await ag.leaveTeamQueue(bob, DEV_B, 'TQ');
    await dbmod.sql`update agents set last_seen_at = now() where id = ${DEV_A}`;
  });

  it('only the owner can join, only members, only when the project has the queue on', async () => {
    expect(await code(ag.joinTeamQueue(alice, DEV_B, 'TQ'))).toBe('forbidden');
    expect(await code(ag.joinTeamQueue(bob, DEV_B, 'NOPE'))).toBe('not_found');
    P = await projects.updateProject(P.id, { agentTeamQueue: false });
    expect(await code(ag.joinTeamQueue(bob, DEV_B, 'TQ'))).toBe('conflict');
    P = await projects.updateProject(P.id, { agentTeamQueue: true });
  });

  it('lists invites, drops them after dismiss and after join, and sets attention', async () => {
    await dbmod.sql`delete from agent_team_projects`;
    const mine = async () => (await ag.myAgents(bob))[0];
    expect((await mine()).teamInvites).toEqual(['TQ']);
    expect((await ag.aiStatus(bob)).attention).toContain('team-invite');
    await ag.dismiss(bob, `team-invite:${P.id}`);
    expect((await mine()).teamInvites).toEqual([]);
    expect((await ag.aiStatus(bob)).attention).not.toContain('team-invite');
    await dbmod.sql`delete from user_dismissals`;
    expect((await mine()).teamInvites).toEqual(['TQ']);
    await ag.joinTeamQueue(bob, DEV_B, 'TQ');
    const a = await mine();
    expect(a.teamInvites).toEqual([]);
    expect(a.teamProjects).toEqual(['TQ']);
  });

  it('project agents list shows joined and not joined computers', async () => {
    const list = await ag.projectAgents(P);
    expect(list.map((a) => [a.owner, a.joined])).toEqual([['Alice', false], ['Bob', true]]);
  });

  it('the data migration SQL keeps existing team queue participants', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('drizzle/0024_team_queue_optin.sql', 'utf8').split('--> statement-breakpoint').pop()!;
    await dbmod.sql`delete from agent_team_projects`;
    await dbmod.sql.unsafe(sql);
    const rows = await dbmod.sql`select agent_id from agent_team_projects order by agent_id`;
    expect(rows.map((r) => r.agent_id)).toEqual([DEV_A, DEV_B]);
  });
});
