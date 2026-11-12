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
    { id: DEV_A, userId: alice.id, name: 'ALICE-PC', version: ag.MIN_EXE_AGENT, lastSeenAt: now },
    { id: DEV_B, userId: bob.id, name: 'BOB-PC', version: ag.MIN_EXE_AGENT, lastSeenAt: now },
  ]);
  await db.insert(schema.agentRepos).values([DEV_A, DEV_B].map((agentId) => ({ agentId, projectId: P.id, path: 'C:/tq', source: 'manual' as const })));
  P = await projects.updateProject(P.id, { agentTeamQueue: true });
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const auth = await import('../src/server/auth.ts');
  const { registerApi } = await import('../src/server/api.ts');
  tokenBob = await auth.createApiToken(bob.id, 'agent', DEV_B);
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

  it('a fresh request waits for the requester\'s own free PC before going to the team queue', async () => {
    await clear();
    await setMode(DEV_B, 'ask');
    const n = await requested(alice);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).not.toContain(`TQ-${n}`);
    await dbmod.sql`update issues set analysis_requested_at = now() - make_interval(secs => ${ag.OWN_PC_GRACE_S + 5}) where number = ${n}`;
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${n}`);
    await dbmod.sql`update agents set busy = true where id = ${DEV_A}`;
    const m = await requested(alice);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${m}`);
    await dbmod.sql`update agents set busy = false where id = ${DEV_A}`;
  });

  it('ask and auto get teammate jobs and can claim', async () => {
    await dbmod.sql`update agents set busy = true where id = ${DEV_A}`;
    for (const mode of ['ask', 'auto']) {
      await clear();
      await setMode(DEV_B, mode);
      const n = await requested(alice);
      expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${n}`);
      await expect(ag.claimAnalysis(P, bob, n, DEV_B)).resolves.toMatchObject({ ok: true });
    }
    await dbmod.sql`update agents set busy = false where id = ${DEV_A}`;
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
    // The agent's own token may set the limit for others (the agent window), and the poll returns it.
    expect((await patch(DEV_B, { maxOthersTokensPerDay: 500_000 })).statusCode).toBe(200);
    expect(Number((await dbmod.sql`select max_others_tokens_per_day as v from agents where id = ${DEV_B}`)[0].v)).toBe(500_000);
    expect((await patch(DEV_B, { teamMode: 'bogus' })).statusCode).toBeGreaterThanOrEqual(400);
    await setMode(DEV_B, 'ask');
  });

  it('GET /api/agent/work includes teamMode', async () => {
    await clear();
    await setMode(DEV_B, 'auto');
    await requested(bob);
    const res = await app.inject({ method: 'GET', url: `/api/agent/work?deviceId=${DEV_B}&version=${ag.MIN_EXE_AGENT}`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ teamMode: 'auto', maxOthersTokensPerDay: 500_000 });
    await dbmod.sql`update agents set max_others_tokens_per_day = null where id = ${DEV_B}`;
  });

  it('old team routes are gone', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/agents/${DEV_B}/team/TQ`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('GET /api/me reports hasAgent and no localAgentAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tokenBob}` } });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.hasAgent).toBe(true);
    expect(me.agentOutdated).toBe(false);
    expect('localAgentAt' in me).toBe(false);
    await dbmod.sql`update agents set version = '0.1.0' where id = ${DEV_B}`;
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${tokenBob}` } })).json().agentOutdated).toBe(true);
    await dbmod.sql`update agents set version = ${ag.MIN_EXE_AGENT} where id = ${DEV_B}`;
  });

  it('DELETE claim with requeue puts the job back without marking it failed; without requeue it fails', async () => {
    await clear();
    const n = await requested(bob);
    const del = (body: object) => app.inject({ method: 'DELETE', url: `/api/issues/TQ-${n}/analyze/claim`, headers: { authorization: `Bearer ${tokenBob}`, 'content-type': 'application/json' }, payload: body });
    await ag.claimAnalysis(P, bob, n, DEV_B, ag.MIN_EXE_AGENT);
    expect((await del({ deviceId: DEV_B, error: 'no repo', requeue: true })).statusCode).toBe(200);
    let [row] = await dbmod.sql`select analysis_requested_at, analysis_claimed_at, analysis_claimed_device, analysis_failed_at from issues where number = ${n}`;
    expect(row.analysis_requested_at).not.toBeNull();
    expect(row.analysis_claimed_at).toBeNull();
    expect(row.analysis_failed_at).toBeNull();
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B)))).toContain(`TQ-${n}`);
    await ag.claimAnalysis(P, bob, n, DEV_B, ag.MIN_EXE_AGENT);
    expect((await del({ deviceId: DEV_B, error: 'boom' })).statusCode).toBe(200);
    [row] = await dbmod.sql`select analysis_failed_at from issues where number = ${n}`;
    expect(row.analysis_failed_at).not.toBeNull();
    await clear();
    await dbmod.sql`update issues set analysis_failed_at = null`;
  });

  it('skip is truncated to 50 ids and a long skip or error query is accepted', async () => {
    const raw = Array.from({ length: 80 }, (_, i) => i + 1000).join(',');
    expect(ag.parseSkip(raw)).toHaveLength(50);
    await clear();
    await requested(bob);
    const longSkip = Array.from({ length: 200 }, (_, i) => i + 100000).join(',').slice(0, 900);
    const res = await app.inject({ method: 'GET', url: `/api/agent/work?deviceId=${DEV_B}&version=${ag.MIN_EXE_AGENT}&skip=${longSkip}&error=${'e'.repeat(700)}`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect(res.statusCode).toBe(200);
    const [a] = await dbmod.sql`select last_error from agents where id = ${DEV_B}`;
    expect((a.last_error as string).length).toBe(300);
  });

  it('poll stores repo status and error from the repos JSON', async () => {
    await clear();
    await requested(bob);
    // Repo w błędzie nie przyjmuje pracy, więc bez klonowania odpytanie by czekało: włączamy je na czas testu.
    P = await projects.updateProject(P.id, { agentsMayClone: true });
    const repos = encodeURIComponent(JSON.stringify({ TQ: { path: 'C:/tq', source: 'hook', status: 'error', error: 'x'.repeat(500) } }));
    const res = await app.inject({ method: 'GET', url: `/api/agent/work?deviceId=${DEV_B}&version=${ag.MIN_EXE_AGENT}&repos=${repos}`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect(res.statusCode).toBe(200);
    const [r] = await dbmod.sql`select status, error from agent_repos where agent_id = ${DEV_B}`;
    expect(r.status).toBe('error');
    expect((r.error as string).length).toBe(300);
    await dbmod.sql`update agent_repos set status = 'ok', error = null, source = 'manual' where agent_id = ${DEV_B}`;
    P = await projects.updateProject(P.id, { agentsMayClone: false });
  });

  it('waitForWork wakes on a new analysis request instead of waiting for the fallback', async () => {
    await clear();
    const t0 = Date.now();
    setTimeout(() => { void requested(bob); }, 400);
    const out = await ag.waitForWork(bob, DEV_B, { name: 'BOB-PC', busy: false, repoKeys: ['TQ'], version: ag.MIN_EXE_AGENT }, new AbortController().signal);
    expect(out.jobs.some((j) => j.kind === 'analyze')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
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
