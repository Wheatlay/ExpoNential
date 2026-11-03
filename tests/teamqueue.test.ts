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
let app: import('fastify').FastifyInstance;
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
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const auth = await import('../src/server/auth.ts');
  const { registerApi } = await import('../src/server/api.ts');
  tokenBob = await auth.createApiToken(bob.id, 'agent');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerApi(app);
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });
let tokenBob: string;
const setMode = (id: string, mode: string) => dbmod.sql`update agents set team_mode = ${mode} where id = ${id}`;

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

describe('team mode per computer', () => {
  it('mode off gets no teammate jobs and cannot claim; own requests are unaffected', async () => {
    await clear();
    await setMode(DEV_B, 'off');
    const n = await requested(alice), m = await requested(bob);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toEqual([`TQ-${m}`]);
    expect(await code(ag.claimAnalysis(P, bob, n, DEV_B))).toBe('conflict');
    await expect(ag.claimAnalysis(P, bob, m, DEV_B)).resolves.toMatchObject({ ok: true });
  });

  it('ask and auto get teammate jobs and can claim', async () => {
    for (const mode of ['ask', 'auto']) {
      await clear();
      await setMode(DEV_B, mode);
      const n = await requested(alice);
      expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${n}`);
      await expect(ag.claimAnalysis(P, bob, n, DEV_B)).resolves.toMatchObject({ ok: true });
    }
  });

  it('noCapablePc and canRun follow the mode of the teammate computers', async () => {
    await clear();
    await requested(alice);
    await dbmod.sql`update agents set last_seen_at = now() - interval '1 hour' where id = ${DEV_A}`;
    await setMode(DEV_B, 'off');
    const r = await runner(alice.id);
    expect(r.noCapablePc).toBe(true);
    expect(r.canRun).toBe(false);
    await setMode(DEV_B, 'ask');
    expect((await runner(alice.id)).noCapablePc).toBe(false);
    expect((await runner(alice.id)).canRun).toBe(true);
    await dbmod.sql`update agents set last_seen_at = now() where id = ${DEV_A}`;
  });

  it('myAgents and the aiStatus attention no longer carry team invites', async () => {
    await setMode(DEV_B, 'auto');
    const a = (await ag.myAgents(bob))[0] as Record<string, unknown>;
    expect(a.teamMode).toBe('auto');
    expect(a).not.toHaveProperty('teamProjects');
    expect(a).not.toHaveProperty('teamInvites');
    expect((await ag.aiStatus(bob)).attention).not.toContain('team-invite');
  });

  it('project agents list shows the mode of each computer', async () => {
    await setMode(DEV_A, 'ask'); await setMode(DEV_B, 'off');
    const list = await ag.projectAgents(P);
    expect(list.map((a) => [a.owner, a.teamMode])).toEqual([['Alice', 'ask'], ['Bob', 'off']]);
    await setMode(DEV_B, 'ask');
  });

  it('token PATCH of teamMode works for own computer, fails for another one and for other fields', async () => {
    const patch = (id: string, body: unknown) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, headers: { authorization: `Bearer ${tokenBob}` }, payload: body as object });
    expect((await patch(DEV_B, { teamMode: 'off' })).statusCode).toBe(200);
    expect((await dbmod.sql`select team_mode from agents where id = ${DEV_B}`)[0].team_mode).toBe('off');
    expect((await patch(DEV_A, { teamMode: 'off' })).statusCode).toBe(404);
    expect((await dbmod.sql`select team_mode from agents where id = ${DEV_A}`)[0].team_mode).toBe('ask');
    expect((await patch(DEV_B, { label: 'x' })).statusCode).toBe(403);
    expect((await patch(DEV_B, { teamMode: 'bogus' })).statusCode).toBeGreaterThanOrEqual(400);
    await setMode(DEV_B, 'ask');
  });

  it('GET /api/agent/work includes teamMode', async () => {
    await clear();
    await setMode(DEV_B, 'auto');
    await requested(bob);
    const res = await app.inject({ method: 'GET', url: `/api/agent/work?deviceId=${DEV_B}&version=${ag.agentScriptsVersion()}`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ teamMode: 'auto' });
  });

  it('old team routes answer 410 Gone', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/agents/${DEV_B}/team/TQ`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect([403, 410]).toContain(res.statusCode);
  });

  it('the data migration SQL maps opted-in computers to auto and leaves the rest on ask', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('drizzle/0026_team_mode.sql', 'utf8').split('--> statement-breakpoint').pop()!;
    await dbmod.sql`update agents set team_mode = 'ask'`;
    await dbmod.sql`delete from agent_team_projects`;
    await dbmod.sql`insert into agent_team_projects (agent_id, project_id) values (${DEV_B}, ${P.id})`;
    await dbmod.sql.unsafe(sql);
    const rows = await dbmod.sql`select id, team_mode from agents order by id`;
    expect(rows.map((r) => [r.id, r.team_mode])).toEqual([[DEV_A, 'ask'], [DEV_B, 'auto']]);
  });
});
