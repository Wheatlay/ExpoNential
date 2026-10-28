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
    { id: DEV_A1, userId: alice.id, name: 'ALICE-PC', repoKeys: ['AGT'], version: ag.agentScriptsVersion() },
    { id: DEV_A2, userId: alice.id, name: 'ALICE-LAPTOP', repoKeys: ['AGT'], version: ag.agentScriptsVersion() },
    { id: DEV_B1, userId: bob.id, name: 'BOB-PC', repoKeys: ['AGT'], version: ag.agentScriptsVersion() },
    { id: DEV_O1, userId: outsider.id, name: 'OUT-PC', repoKeys: ['AGT'], version: ag.agentScriptsVersion() },
  ]);
  // Każde urządzenie ma repo projektu (analizy trafiają tylko na komputery z mapowaniem).
  await db.insert(schema.agentRepos).values([DEV_A1, DEV_A2, DEV_B1, DEV_O1].map((agentId) => ({ agentId, projectId: P.id, path: 'C:/agt', source: 'manual' as const })));
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
  });

  it('registers an unknown device of the caller on claim (handler started before the agent checked in)', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    const fresh = '55555555-5555-4555-8555-555555555555';
    // Nowe urządzenie nie ma jeszcze mapowania: wystarcza prawo klonowania.
    P = await (await import('../src/server/projects.ts')).updateProject(P.id, { agentsMayClone: true });
    expect((await ag.claimAnalysis(P, alice, n, fresh, ag.agentScriptsVersion())).ok).toBe(true);
    expect((await ag.myAgents(alice)).some((a) => a.id === fresh)).toBe(true);
    P = await (await import('../src/server/projects.ts')).updateProject(P.id, { agentsMayClone: false });
  });
});

describe('claim lifecycle', () => {
  it('a failed run is not offered again until a new request (no retry loop)', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    await ag.releaseClaim(P, alice, n, DEV_A1, 'Brak repo projektu AGT');
    const r = await row(n);
    expect(r.analysisFailedAt).not.toBeNull();
    expect(r.analysisError).toBe('Brak repo projektu AGT');
    const agent = { id: DEV_A1, busy: false, repoKeys: ['AGT'], version: ag.agentScriptsVersion() };
    expect((await ag.pendingWork(alice, agent)).some((j) => j.kind === 'analyze' && j.key === `AGT-${n}`)).toBe(false);
    expect(await code(ag.claimAnalysis(P, alice, n, DEV_A2))).toBe('conflict');
    await svc.requestAnalysis(P, alice, n);
    expect((await row(n)).analysisFailedAt).toBeNull();
    expect((await ag.pendingWork(alice, agent)).some((j) => j.kind === 'analyze' && j.key === `AGT-${n}`)).toBe(true);
  });

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

describe('pendingWork', () => {
  const clearAll = async () => { await dbmod.sql`update issues set analysis_requested_at = null, analysis_claimed_at = null, analysis_claimed_device = null, analysis_claimed_by = null`; };
  const agentOf = async (id: string) => (await dbmod.db.select().from(schema.agents).where(dz.eq(schema.agents.id, id)))[0];
  const keys = (jobs: { kind: string; key?: string }[]) => jobs.filter((j) => j.kind === 'analyze').map((j) => j.key);

  it('returns my request but not a teammate\'s unless the team queue is on', async () => {
    await clearAll();
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    const id = `AGT-${n}`;
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A1)))).toContain(id);
    await setTeamQueue(false);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B1)))).not.toContain(id);
    await setTeamQueue(true);
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B1)))).toContain(id);
    await setTeamQueue(false);
  });

  it('a Codex agent (ownOnly) gets only its owner\'s requests, never the team queue, and cannot claim a teammate\'s', async () => {
    await clearAll();
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    const id = `AGT-${n}`;
    await setTeamQueue(true);
    expect(keys(await ag.pendingWork(bob, { ...(await agentOf(DEV_B1)), ownOnly: true }))).not.toContain(id);
    expect(keys(await ag.pendingWork(alice, { ...(await agentOf(DEV_A1)), ownOnly: true }))).toContain(id);
    await expect(ag.claimAnalysis(P, bob, n, DEV_B1, undefined, true)).rejects.toThrow();
    expect((await ag.claimAnalysis(P, bob, n, DEV_B1)).ok).toBe(true);
    await setTeamQueue(false);
  });

  it('never lists an issue from a project the user is not a member of', async () => {
    await clearAll();
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await setTeamQueue(true);
    expect(keys(await ag.pendingWork(outsider, await agentOf(DEV_O1)))).toEqual([]);
    await setTeamQueue(false);
  });

  it('is filtered by the repos on the PC and empty for a busy agent', async () => {
    await clearAll();
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    expect(keys(await ag.pendingWork(alice, { busy: false, repoKeys: ['OTHER'], version: ag.agentScriptsVersion() }))).toEqual([]);
    expect(keys(await ag.pendingWork(alice, { busy: false, repoKeys: [], version: ag.agentScriptsVersion() }))).toEqual([]);
    expect(await ag.pendingWork(alice, { busy: true, repoKeys: ['AGT'], version: ag.agentScriptsVersion() })).toEqual([]);
  });

  it('skips an issue that is already claimed (fresh) and offers it again once stale', async () => {
    await clearAll();
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toEqual([]);
    await dbmod.sql`update issues set analysis_claimed_at = now() - interval '31 minutes' where id = ${(await row(n)).id}`;
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toEqual([`AGT-${n}`]);
  });
});

describe('repo mappings and routing', () => {
  const clearAll = async () => { await dbmod.sql`update issues set analysis_requested_at = null, analysis_claimed_at = null, analysis_claimed_device = null, analysis_claimed_by = null`; };
  const agentOf = async (id: string) => (await dbmod.db.select().from(schema.agents).where(dz.eq(schema.agents.id, id)))[0];
  const keys = (jobs: { kind: string; key?: string }[]) => jobs.filter((j) => j.kind === 'analyze').map((j) => j.key);
  const projects = () => import('../src/server/projects.ts');
  const unmap = (dev: string) => dbmod.sql`delete from agent_repos where agent_id = ${dev}`;
  const map = (dev: string) => dbmod.db.insert(schema.agentRepos).values({ agentId: dev, projectId: P.id, path: 'C:/x', source: 'manual', status: 'ok' })
    .onConflictDoUpdate({ target: [schema.agentRepos.agentId, schema.agentRepos.projectId], set: { status: 'ok' } });
  const mayClone = async (on: boolean) => { P = await (await projects()).updateProject(P.id, { agentsMayClone: on }); };

  it('a device without a mapping gets no work and cannot claim; with an ok mapping it can', async () => {
    await clearAll();
    await unmap(DEV_A2);
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toEqual([]);
    expect(await code(ag.claimAnalysis(P, alice, n, DEV_A2))).toBe('conflict');
    await map(DEV_A2);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toContain(`AGT-${n}`);
    await expect(ag.claimAnalysis(P, alice, n, DEV_A2)).resolves.toMatchObject({ ok: true });
  });

  it('an error mapping does not receive work', async () => {
    await clearAll();
    await dbmod.sql`update agent_repos set status = 'error' where agent_id = ${DEV_A2}`;
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toEqual([]);
    await dbmod.sql`update agent_repos set status = 'ok' where agent_id = ${DEV_A2}`;
  });

  it('agentsMayClone lets a device without a mapping take the work', async () => {
    await clearAll();
    await unmap(DEV_A2);
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await mayClone(true);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A2)))).toContain(`AGT-${n}`);
    await expect(ag.claimAnalysis(P, alice, n, DEV_A2)).resolves.toMatchObject({ ok: true });
    const w = await ag.repoState(alice, DEV_A2);
    expect(w.cloneAllowed).toContain('AGT');
    await mayClone(false);
    await map(DEV_A2);
  });

  it('team queue: only the teammate device with a mapping gets the issue', async () => {
    await clearAll();
    await unmap(DEV_B1);
    await map(DEV_A1);
    await setTeamQueue(true);
    const n = await newIssue();
    await svc.requestAnalysis(P, bob, n);
    // Alice (z mapowaniem) bierze zlecenie Boba, urządzenie Boba bez mapowania nie dostaje nic.
    expect(keys(await ag.pendingWork(bob, await agentOf(DEV_B1)))).toEqual([]);
    expect(keys(await ag.pendingWork(alice, await agentOf(DEV_A1)))).toContain(`AGT-${n}`);
    expect(await code(ag.claimAnalysis(P, bob, n, DEV_B1))).toBe('conflict');
    await expect(ag.claimAnalysis(P, alice, n, DEV_A1)).resolves.toMatchObject({ ok: true });
    await setTeamQueue(false);
    await map(DEV_B1);
  });

  it('changing githubRepo clears the mappings (other fields do not)', async () => {
    await map(DEV_A1);
    P = await (await projects()).updateProject(P.id, { deployBranch: 'main' });
    expect((await ag.repoState(alice, DEV_A1)).repos).toHaveLength(1);
    P = await (await projects()).updateProject(P.id, { githubRepo: 'acme/agt' });
    expect((await ag.repoState(alice, DEV_A1)).repos).toEqual([]);
    expect((await ag.repoState(alice, DEV_A2)).repos).toEqual([]);
    for (const d of [DEV_A1, DEV_A2, DEV_B1, DEV_O1]) await map(d);
  });

  it('old format {KEY: path} and key-only reports upsert; unsent non-manual rows are removed, manual stay', async () => {
    const id = '99999999-9999-4999-8999-999999999999';
    await ag.heartbeat(alice, id, { name: 'PS-PC', busy: false, repoKeys: ['AGT'], repos: { AGT: 'C:/work/agt' } });
    expect((await ag.repoState(alice, id)).repos).toMatchObject([{ project: 'AGT', path: 'C:/work/agt', source: 'hook', status: 'ok' }]);
    // Same klucze bez ścieżki (skrypty PS) nie kasują zapisanej ścieżki.
    await ag.heartbeat(alice, id, { name: 'PS-PC', busy: false, repoKeys: ['AGT'] });
    expect((await ag.repoState(alice, id)).repos[0].path).toBe('C:/work/agt');
    // Nowy format ze statusem błędu.
    await ag.heartbeat(alice, id, { name: 'PS-PC', busy: false, repoKeys: ['AGT'], repos: { AGT: { path: 'C:/work/agt', source: 'clone', status: 'error', error: 'boom' } } });
    expect((await ag.repoState(alice, id)).repos[0]).toMatchObject({ source: 'clone', status: 'error', error: 'boom' });
    // Klucz nie zgłoszony więcej znika.
    await ag.heartbeat(alice, id, { name: 'PS-PC', busy: false, repoKeys: [] });
    expect((await ag.repoState(alice, id)).repos).toEqual([]);
    // Ręczne mapowanie przeżywa heartbeat bez niego; cudze urządzenie nie ustawi.
    await ag.setAgentRepo(alice, id, 'agt', ' C:/manual ');
    await ag.heartbeat(alice, id, { name: 'PS-PC', busy: false, repoKeys: [] });
    expect((await ag.repoState(alice, id)).repos).toMatchObject([{ path: 'C:/manual', source: 'manual' }]);
    expect(await code(ag.setAgentRepo(bob, id, 'AGT', 'x'))).toBe('forbidden');
    await ag.removeAgentRepo(alice, id, 'AGT');
    expect((await ag.repoState(alice, id)).repos).toEqual([]);
    await ag.removeAgent(alice, id);
  });

  it('does not map projects the user is not a member of', async () => {
    await unmap(DEV_O1);
    await ag.heartbeat(outsider, DEV_O1, { name: 'OUT-PC', busy: false, repoKeys: ['AGT'], repos: { AGT: 'C:/o' } });
    expect((await ag.repoState(outsider, DEV_O1)).repos).toEqual([]);
    await map(DEV_O1);
  });

  it('analysisNoCapablePc: true without a capable online PC, false with one, false when claimed', async () => {
    await clearAll();
    const online = async (ids: string[]) => {
      await dbmod.sql`update agents set last_seen_at = now() - interval '10 minutes'`;
      for (const id of ids) await dbmod.sql`update agents set last_seen_at = now(), version = ${ag.agentScriptsVersion()} where id = ${id}`;
    };
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    const det = async () => ag.analysisRunner(P, await row(n));
    await online([DEV_A1]);
    await unmap(DEV_A1);
    expect((await det()).noCapablePc).toBe(true);
    await map(DEV_A1);
    expect((await det()).noCapablePc).toBe(false);
    // Stary agent z mapowaniem się nie liczy.
    await dbmod.sql`update agents set version = 'old' where id = ${DEV_A1}`;
    expect((await det()).noCapablePc).toBe(true);
    await dbmod.sql`update agents set version = ${ag.agentScriptsVersion()} where id = ${DEV_A1}`;
    // Urządzenie kolegi liczy się tylko przy kolejce zespołu.
    await online([DEV_B1]);
    expect((await det()).noCapablePc).toBe(true);
    await setTeamQueue(true);
    expect((await det()).noCapablePc).toBe(false);
    await setTeamQueue(false);
    // Prawo klonowania wystarcza bez mapowania.
    await online([DEV_A1]);
    await unmap(DEV_A1);
    await mayClone(true);
    expect((await det()).noCapablePc).toBe(false);
    await mayClone(false);
    await map(DEV_A1);
    // Przejęte zlecenie nie czeka.
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    await unmap(DEV_A1);
    expect((await det()).noCapablePc).toBe(false);
    await map(DEV_A1);
  });
});

describe('heartbeat', () => {
  it('registers a device and refreshes the claim of a busy device', async () => {
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    await ag.claimAnalysis(P, alice, n, DEV_A1);
    await dbmod.sql`update issues set analysis_claimed_at = now() - interval '20 minutes' where id = ${(await row(n)).id}`;
    const before = (await row(n)).analysisClaimedAt!.getTime();
    // Nieobciążony agent nie odświeża claima, zajęty tak.
    await ag.heartbeat(alice, DEV_A1, { name: 'ALICE-PC', busy: false, repoKeys: ['agt'] });
    expect((await row(n)).analysisClaimedAt!.getTime()).toBe(before);
    const a = await ag.heartbeat(alice, DEV_A1, { name: 'ALICE-PC', busy: true, repoKeys: ['agt', 'bad key'] });
    expect(a.repoKeys).toEqual(['AGT']);
    expect((await row(n)).analysisClaimedAt!.getTime()).toBeGreaterThan(before + 19 * 60_000);
    await ag.heartbeat(alice, DEV_A1, { name: 'ALICE-PC', busy: false, repoKeys: ['AGT'] });
  });

  it('refuses a device id that belongs to another user', async () => {
    expect(await code(ag.heartbeat(bob, DEV_A1, { name: 'x', busy: false, repoKeys: [] }))).toBe('forbidden');
  });

  it('creates a new device row for a first heartbeat', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    await ag.heartbeat(bob, id, { name: 'NEW-PC', busy: false, repoKeys: ['AGT'] });
    expect((await ag.myAgents(bob)).find((a) => a.id === id)).toMatchObject({ name: 'NEW-PC', online: true });
    await ag.removeAgent(alice, id);
    expect((await ag.myAgents(bob)).some((a) => a.id === id)).toBe(true);
    await ag.removeAgent(bob, id);
    expect((await ag.myAgents(bob)).some((a) => a.id === id)).toBe(false);
  });

  it('stores the reported error, an empty error keeps it, and an error older than 24 h is hidden', async () => {
    const base = { name: 'ALICE-PC', busy: false, repoKeys: ['AGT'] };
    await ag.heartbeat(alice, DEV_A1, { ...base, error: 'boom' });
    expect((await ag.myAgents(alice)).find((a) => a.id === DEV_A1)?.lastError).toBe('boom');
    await ag.heartbeat(alice, DEV_A1, { ...base, error: '' });
    expect((await ag.myAgents(alice)).find((a) => a.id === DEV_A1)?.lastError).toBe('boom');
    await dbmod.db.update(schema.agents).set({ lastErrorAt: new Date(Date.now() - 25 * 3600_000) }).where(dz.eq(schema.agents.id, DEV_A1));
    expect((await ag.myAgents(alice)).find((a) => a.id === DEV_A1)?.lastError).toBe('');
  });
});

describe('rename', () => {
  it('own label survives heartbeats, empty label falls back to the Windows name, others cannot rename', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    await ag.heartbeat(bob, id, { name: 'DESKTOP-X', busy: false, repoKeys: [] });
    await ag.renameAgent(bob, id, '  Laptop w domu ');
    await ag.heartbeat(bob, id, { name: 'DESKTOP-X', busy: false, repoKeys: [] });
    expect((await ag.myAgents(bob)).find((a) => a.id === id)).toMatchObject({ name: 'Laptop w domu', computerName: 'DESKTOP-X', label: 'Laptop w domu' });
    expect(await code(ag.renameAgent(alice, id, 'mine'))).toBe('not_found');
    await ag.renameAgent(bob, id, '');
    expect((await ag.myAgents(bob)).find((a) => a.id === id)?.name).toBe('DESKTOP-X');
  });
});

describe('script version', () => {
  it('an agent reporting an old version is outdated, the current one is not', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    await ag.heartbeat(bob, id, { name: 'OLD-PC', busy: false, repoKeys: [], version: 'old' });
    expect((await ag.myAgents(bob)).find((a) => a.id === id)?.outdated).toBe(true);
    await ag.heartbeat(bob, id, { name: 'OLD-PC', busy: false, repoKeys: [], version: ag.agentScriptsVersion() });
    expect((await ag.myAgents(bob)).find((a) => a.id === id)?.outdated).toBe(false);
  });

  it('old scripts get no work and cannot claim; the handler reporting the new version can', async () => {
    const id = '77777777-7777-4777-8777-777777777777';
    const a = await ag.heartbeat(alice, id, { name: 'STALE-PC', busy: false, repoKeys: ['AGT'], version: 'old' });
    const n = await newIssue();
    await svc.requestAnalysis(P, alice, n);
    expect(await ag.pendingWork(alice, a)).toEqual([]);
    expect(await code(ag.claimAnalysis(P, alice, n, id))).toBe('outdated');
    expect(await code(ag.claimAnalysis(P, alice, n, id, 'old'))).toBe('outdated');
    expect((await ag.claimAnalysis(P, alice, n, id, ag.agentScriptsVersion())).ok).toBe(true);
  });
});

describe('projectAgents', () => {
  it('lists online computers of project members only', async () => {
    await dbmod.sql`update agents set last_seen_at = now() where id in (${DEV_A1}, ${DEV_O1})`;
    await dbmod.sql`update agents set last_seen_at = now() - interval '10 minutes' where id = ${DEV_B1}`;
    const list = await ag.projectAgents(P);
    expect(list.map((a) => a.name)).toContain('ALICE-PC');
    expect(list.map((a) => a.name)).not.toContain('OUT-PC');
    expect(list.map((a) => a.name)).not.toContain('BOB-PC');
    expect(list.find((a) => a.name === 'ALICE-PC')?.owner).toBe('Alice');
  });
});

describe('start jobs', () => {
  const offlineUser = () => ({ id: outsider.id, name: outsider.name });
  const agentOf = async (id: string) => (await dbmod.db.select().from(schema.agents).where(dz.eq(schema.agents.id, id)))[0];
  const jobsOf = async (userId: number) => (await dbmod.db.select().from(schema.agentJobs).where(dz.eq(schema.agentJobs.userId, userId)));

  it('refuses without an online agent', async () => {
    await dbmod.sql`update agents set last_seen_at = now() - interval '10 minutes' where user_id = ${alice.id}`;
    const n = await newIssue();
    expect(await code(ag.createStartJob(P, alice, n))).toBe('invalid');
    expect(await code(ag.createStartJob(P, offlineUser(), n))).toBe('invalid');
  });

  it('creates a job, assigns the issue and moves it to In Progress', async () => {
    await ag.heartbeat(alice, DEV_A1, { name: 'ALICE-PC', busy: false, repoKeys: ['AGT'] });
    const n = await newIssue();
    const r = await ag.createStartJob(P, alice, n);
    expect(r.ok).toBe(true);
    const cur = await row(n);
    expect(cur.assigneeId).toBe(alice.id);
    expect(cur.statusId).toBe(await (async () => (await svc.getMeta(P)).statuses.find((s) => s.name === 'In Progress')!.id)());
    expect((await jobsOf(alice.id)).some((j) => j.id === r.id && j.issueId === cur.id)).toBe(true);
  });

  it('lists only my unclaimed fresh jobs, claims once, and expires after an hour', async () => {
    await ag.heartbeat(alice, DEV_A1, { name: 'ALICE-PC', busy: false, repoKeys: ['AGT'] });
    await dbmod.sql`delete from agent_jobs`;
    const n = await newIssue();
    const { id } = await ag.createStartJob(P, alice, n);
    const starts = async (u: { id: number }, dev: string) => (await ag.pendingWork(u, await agentOf(dev))).filter((j) => j.kind === 'start');
    expect(await starts(alice, DEV_A1)).toEqual([{ kind: 'start', id, key: `AGT-${n}` }]);
    expect(await starts(bob, DEV_B1)).toEqual([]);
    await expect(ag.claimStartJob(alice, id, DEV_A1)).resolves.toEqual({ key: `AGT-${n}` });
    expect(await code(ag.claimStartJob(alice, id, DEV_A1))).toBe('conflict');
    expect(await starts(alice, DEV_A1)).toEqual([]);

    const m = await newIssue();
    const old = await ag.createStartJob(P, alice, m);
    await dbmod.sql`update agent_jobs set created_at = now() - interval '61 minutes' where id = ${old.id}`;
    expect(await starts(alice, DEV_A1)).toEqual([]);
    expect(await code(ag.claimStartJob(alice, old.id, DEV_A1))).toBe('conflict');
    expect(await code(ag.claimStartJob(bob, old.id, DEV_B1))).toBe('conflict');
  });
});
