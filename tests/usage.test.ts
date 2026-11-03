/**
 * Przebiegi agenta: POST /api/agent/runs, limit dla innych, statystyki 30 dni, kody "do sprawdzenia". Prawdziwa baza (tracker_usage).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_usage';

let svc: typeof import('../src/server/service.ts');
let ag: typeof import('../src/server/agents.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let P: import('../src/server/projects.ts').Project;
let alice: { id: number; name: string };
let bob: { id: number; name: string };
let carol: { id: number; name: string };

const DEV_A = '55555555-5555-4555-8555-555555555555';
const run = (over: Partial<import('../src/server/agents.ts').RunReport> = {}) => ({ deviceId: DEV_A, key: 'USG-1', kind: 'analyze' as const, engine: 'claude', model: 'sonnet', durationMs: 1000, exitCode: 0, ...over });
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e as { code: string }).code);

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_usage with (force)');
  await admin.unsafe('create database tracker_usage');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  ag = await import('../src/server/agents.ts');
  schema = await import('../src/db/schema.ts');
  const projects = await import('../src/server/projects.ts');
  const { db } = dbmod;
  const [creator] = await db.insert(schema.users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'USG', name: 'Usage' });
  await db.delete(schema.projectMembers).where((await import('drizzle-orm')).eq(schema.projectMembers.userId, creator.id));
  await svc.seedDefaults();
  [alice] = await db.insert(schema.users).values({ login: 'alice', name: 'Alice' }).returning();
  [bob] = await db.insert(schema.users).values({ login: 'bob', name: 'Bob' }).returning();
  [carol] = await db.insert(schema.users).values({ login: 'carol', name: 'Carol' }).returning();
  await db.insert(schema.projectMembers).values([alice, bob, carol].map((u) => ({ projectId: P.id, userId: u.id })));
  await db.insert(schema.agents).values({ id: DEV_A, userId: alice.id, name: 'ALICE-PC', repoKeys: ['USG'], version: ag.MIN_EXE_AGENT, lastSeenAt: new Date() });
  await db.insert(schema.agentRepos).values({ agentId: DEV_A, projectId: P.id, path: 'C:/usg', source: 'manual' });
  await db.insert(schema.agentTeamProjects).values({ agentId: DEV_A, projectId: P.id });
  P = await projects.updateProject(P.id, { agentTeamQueue: true });
});
afterAll(async () => { await dbmod?.sql.end(); });

const newIssue = async () => (await svc.createIssue(P, null, { title: 't' })).number;
const pending = async () => {
  const [a] = await dbmod.sql`select * from agents where id = ${DEV_A}`;
  return ag.pendingWork(alice, { id: DEV_A, busy: false, repoKeys: a.repo_keys, version: a.version, maxOthersTokensPerDay: a.max_others_tokens_per_day == null ? null : Number(a.max_others_tokens_per_day) });
};
const setLimit = (n: number | null) => ag.setAgentLimit(alice, DEV_A, n);
const setRequester = async (id: number) => { await dbmod.sql`update agents set current_requester_id = ${id} where id = ${DEV_A}`; };
const clean = async () => { await dbmod.sql`delete from agent_runs`; await dbmod.sql`update issues set analysis_requested_at = null, analysis_claimed_at = null, analysis_claimed_device = null`; await setLimit(null); };

describe('POST /api/agent/runs', () => {
  it('can be called with a token (scope)', async () => {
    const { tokenAllowed } = await import('../src/server/auth.ts');
    expect(tokenAllowed('POST', '/api/agent/runs')).toBe(true);
    expect(tokenAllowed('GET', '/api/agent/runs')).toBe(false);
  });

  it('stores the requester captured at claim time and validates numbers', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, bob, n);
    const claim = await ag.claimAnalysis(P, alice, n, DEV_A);
    expect(claim.requester).toEqual({ id: bob.id, name: 'Bob' });
    // Analiza kasuje claim na zgłoszeniu, ale zlecający zostaje zapamiętany na komputerze.
    await dbmod.sql`update issues set analysis_claimed_device = null, analysis_requested_at = null where number = ${n}`;
    const r = await ag.recordRun(alice, run({ key: `USG-${n}`, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 1.25 } }));
    const [row] = await dbmod.sql`select * from agent_runs where id = ${r.id}`;
    expect(row.requester_id).toBe(bob.id);
    expect(row.owner_id).toBe(alice.id);
    expect(row.issue_number).toBe(n);
    expect(Number(row.cost_usd)).toBe(1.25);
    expect(await code(ag.recordRun(alice, run({ durationMs: -1 })))).toBe('invalid');
    expect(await code(ag.recordRun(alice, run({ usage: { inputTokens: -5 } })))).toBe('invalid');
    expect(await code(ag.recordRun(bob, run()))).toBe('forbidden');
  });

  it('start runs belong to the owner', async () => {
    const r = await ag.recordRun(alice, run({ kind: 'start' }));
    const [row] = await dbmod.sql`select requester_id from agent_runs where id = ${r.id}`;
    expect(row.requester_id).toBe(alice.id);
  });
});

describe('limit for others', () => {
  it('blocks others in pendingWork and claim, never own requests', async () => {
    await clean();
    const mineN = await newIssue(), othersN = await newIssue();
    await svc.requestAnalysis(P, alice, mineN);
    await svc.requestAnalysis(P, bob, othersN);
    expect((await pending()).filter((j) => j.kind === 'analyze')).toHaveLength(2);
    await setRequester(bob.id);
    // Odczyty cache nie liczą się do tokenów: 1000 + 500 + 0 na przebieg.
    const big = { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 9_000_000, cacheWriteTokens: 100 };
    await ag.recordRun(alice, run({ usage: big })); await ag.recordRun(alice, run({ usage: big }));
    await setLimit(3000);
    const jobs = (await pending()).filter((j) => j.kind === 'analyze');
    expect(jobs).toMatchObject([{ kind: 'analyze', key: `USG-${mineN}`, deep: false, requestedBy: { name: 'Alice' } }]);
    expect(await code(ag.claimAnalysis(P, alice, othersN, DEV_A))).toBe('conflict');
    await expect(ag.claimAnalysis(P, alice, mineN, DEV_A)).resolves.toMatchObject({ ok: true });
    await setLimit(3001);
    expect((await pending()).some((j) => j.kind === 'analyze' && j.key === `USG-${othersN}`)).toBe(true);
  });
});

describe('usage and attention', () => {
  it('aggregates usage30d with a top requester breakdown', async () => {
    await clean();
    await setRequester(bob.id);
    await ag.recordRun(alice, run({ usage: { costUsd: 1, inputTokens: 100, outputTokens: 50, cacheReadTokens: 999, cacheWriteTokens: 10 } })); await ag.recordRun(alice, run({ usage: { costUsd: 2, inputTokens: 200 } }));
    await setRequester(carol.id);
    await ag.recordRun(alice, run({ usage: { costUsd: 0.5, outputTokens: 7 } }));
    await ag.recordRun(alice, run({ kind: 'start' }));
    await dbmod.sql`insert into agent_runs (agent_id, owner_id, requester_id, kind, created_at) values (${DEV_A}, ${alice.id}, ${bob.id}, 'analyze', now() - interval '40 days')`;
    const a = (await ag.myAgents(alice)).find((x) => x.id === DEV_A)!;
    expect(a.usage30d).toEqual({ runs: 4, forOthers: 3, costUsd: 3.5, tokens: 367, byRequester: [{ name: 'Bob', runs: 2, costUsd: 3, tokens: 360 }, { name: 'Alice', runs: 1, costUsd: 0, tokens: 0 }, { name: 'Carol', runs: 1, costUsd: 0.5, tokens: 7 }] });
    const pa = (await ag.projectAgents(P)).find((x) => x.owner === 'Alice')!;
    expect(pa.usage30d.runs).toBe(4);
  });

  it('raises limit and busy-for-others attention codes', async () => {
    await clean();
    expect((await ag.aiStatus(alice)).attention).not.toContain('limit');
    await setRequester(bob.id);
    for (let i = 0; i < 2; i++) await ag.recordRun(alice, run({ usage: { inputTokens: 1_000_000 } }));
    expect((await ag.aiStatus(alice)).attention).toContain('busy-for-others');
    await setLimit(1_500_000);
    const att = (await ag.aiStatus(alice)).attention;
    expect(att).toContain('limit');
    expect(att).not.toContain('busy-for-others');
    expect((await ag.myAgents(alice)).find((x) => x.id === DEV_A)!.limitReached24h).toBe(true);
    await clean();
  });
});
