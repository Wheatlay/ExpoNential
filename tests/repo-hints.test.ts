/** Repo z PC: normalizacja pola GitHub repo, `found` z odpytania, podpowiedzi repo dla członków projektu, polecenia dla PC. Baza tracker_test_repohints. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_repohints';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let ag: typeof import('../src/server/agents.ts');
let rules: typeof import('../src/server/rules.ts');
let auth: typeof import('../src/server/auth.ts');
let app: import('fastify').FastifyInstance;
let sess: (userId: number) => Promise<Record<string, string>>;
let P: import('../src/server/projects.ts').Project;
let alice: { id: number; name: string };
let bob: { id: number; name: string };
let carol: { id: number; name: string };

const DEV_A = '11111111-aaaa-4111-8111-111111111111';
const DEV_B = '22222222-bbbb-4222-8222-222222222222';
const DEV_C = '33333333-cccc-4333-8333-333333333333';

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_repohints with (force)');
  await admin.unsafe('create database tracker_test_repohints');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  ag = await import('../src/server/agents.ts');
  rules = await import('../src/server/rules.ts');
  auth = await import('../src/server/auth.ts');
  const pr = await import('../src/server/projects.ts');
  const svc = await import('../src/server/service.ts');
  const { db } = dbmod;
  await svc.seedDefaults();
  [alice] = await db.insert(schema.users).values({ login: 'alice', name: 'Alice' }).returning();
  [bob] = await db.insert(schema.users).values({ login: 'bob', name: 'Bob' }).returning();
  [carol] = await db.insert(schema.users).values({ login: 'carol', name: 'Carol' }).returning();
  P = await pr.createProject(alice.id, { key: 'RHA', name: 'Alpha' });
  await pr.createProject(carol.id, { key: 'RHB', name: 'Beta' });
  await db.insert(schema.projectMembers).values({ projectId: P.id, userId: bob.id });
  await db.insert(schema.agents).values([
    { id: DEV_A, userId: alice.id, name: 'A-PC', foundRepos: ['acme/web'] },
    { id: DEV_B, userId: bob.id, name: 'B-PC', foundRepos: ['acme/api', 'acme/web'] },
    { id: DEV_C, userId: carol.id, name: 'C-PC', foundRepos: ['secret/other'] },
  ]);
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { registerApi } = await import('../src/server/api.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerApi(app);
  sess = async (userId) => {
    const raw = randomBytes(16).toString('base64url');
    await db.insert(schema.sessions).values({ id: auth.sha256(raw), userId, expiresAt: new Date(Date.now() + 864e5) });
    return { cookie: `tracker_session=${raw}`, 'x-requested-with': 'exponential' };
  };
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

describe('normGithubRepo', () => {
  it('accepts the usual forms', () => {
    for (const s of ['Acme/Web', ' Acme/Web ', 'https://github.com/Acme/Web', 'http://github.com/Acme/Web.git', 'github.com/Acme/Web/', 'https://github.com/Acme/Web/tree/main', 'git@github.com:Acme/Web.git', 'https://www.github.com/Acme/Web?tab=x'])
      expect(rules.normGithubRepo(s), s).toBe('Acme/Web');
  });
  it('empty clears, junk is null', () => {
    expect(rules.normGithubRepo('  ')).toBe('');
    for (const s of ['acme', 'a b/c', 'https://gitlab.com/a', 'acme/', '/web', 'a$/b']) expect(rules.normGithubRepo(s), s).toBeNull();
  });
});

describe('heartbeat found', () => {
  it('parseFound keeps valid lowercase owner/name only, caps at 100', () => {
    expect(ag.parseFound(undefined)).toBeUndefined();
    expect(ag.parseFound('not json')).toBeUndefined();
    expect(ag.parseFound(JSON.stringify(['a/b', 'A/B', 'x', 5, 'c/d', 'a/b']))).toEqual(['a/b', 'c/d']);
    expect(ag.parseFound(JSON.stringify(Array.from({ length: 150 }, (_, i) => `o/r${i}`)))?.length).toBe(100);
  });
  it('is stored only when present', async () => {
    const user = { id: alice.id };
    await ag.heartbeat(user, DEV_A, { name: 'A-PC', busy: false, repoKeys: [], found: ['acme/web', 'acme/docs'] });
    let [row] = await dbmod.sql`select found_repos from agents where id = ${DEV_A}`;
    expect(row.found_repos).toEqual(['acme/web', 'acme/docs']);
    await ag.heartbeat(user, DEV_A, { name: 'A-PC', busy: false, repoKeys: [] });
    [row] = await dbmod.sql`select found_repos from agents where id = ${DEV_A}`;
    expect(row.found_repos).toEqual(['acme/web', 'acme/docs']);
  });
});

describe('repo suggestions', () => {
  it('only the asking user own PCs, sorted; teammates PCs excluded', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/RHA/repo-suggestions', headers: await sess(alice.id) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(['acme/docs', 'acme/web']);
  });
  it('non-member is refused', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/projects/RHA/repo-suggestions', headers: await sess(carol.id) });
    expect([403, 404]).toContain(r.statusCode);
    expect(r.body).not.toContain('acme');
  });
});

describe('repo actions', () => {
  it('owner queues, agent takes once; others refused', async () => {
    const mine = await sess(alice.id);
    const url = `/api/agents/${DEV_A}/repo-action`;
    expect((await app.inject({ method: 'POST', url, headers: mine, payload: { kind: 'pick', project: 'RHA' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: mine, payload: { kind: 'pick', project: 'RHA' } })).statusCode).toBe(200); // dedupe
    expect((await app.inject({ method: 'POST', url, headers: mine, payload: { kind: 'rescan' } })).statusCode).toBe(200);
    expect(ag.takeRepoActions(DEV_A)).toEqual([{ kind: 'pick', project: 'RHA' }, { kind: 'rescan', project: '' }]);
    expect(ag.takeRepoActions(DEV_A)).toEqual([]);
    // cudzy komputer
    expect((await app.inject({ method: 'POST', url: `/api/agents/${DEV_B}/repo-action`, headers: mine, payload: { kind: 'rescan' } })).statusCode).toBe(403);
    // projekt, w którym nie jestem
    expect((await app.inject({ method: 'POST', url, headers: mine, payload: { kind: 'pick', project: 'RHB' } })).statusCode).toBe(404);
    // clone wymaga repo w projekcie
    expect((await app.inject({ method: 'POST', url, headers: mine, payload: { kind: 'clone', project: 'RHA' } })).statusCode).toBe(422);
    expect(ag.takeRepoActions(DEV_A)).toEqual([]);
  });
  it('clone queued when the project has a repo; agent route returns only own PC queue', async () => {
    await dbmod.sql`update projects set github_repo = 'acme/web' where id = ${P.id}`;
    const mine = await sess(alice.id);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${DEV_A}/repo-action`, headers: mine, payload: { kind: 'clone', project: 'RHA' } })).statusCode).toBe(200);
    const tokenBob = await auth.createApiToken(bob.id, 'agent', DEV_B);
    const other = await app.inject({ method: 'GET', url: `/api/agent/repo-actions?deviceId=${DEV_A}`, headers: { authorization: `Bearer ${tokenBob}` } });
    expect(other.statusCode).toBe(403);
    const tokenAlice = await auth.createApiToken(alice.id, 'agent', DEV_A);
    const own = await app.inject({ method: 'GET', url: `/api/agent/repo-actions?deviceId=${DEV_A}`, headers: { authorization: `Bearer ${tokenAlice}` } });
    expect(own.json()).toEqual([{ kind: 'clone', project: 'RHA' }]);
    const again = await app.inject({ method: 'GET', url: `/api/agent/repo-actions?deviceId=${DEV_A}`, headers: { authorization: `Bearer ${tokenAlice}` } });
    expect(again.json()).toEqual([]);
  });
});

describe('PATCH githubRepo', () => {
  it('normalizes a pasted URL and rejects junk with 400', async () => {
    const h = await sess(alice.id);
    const ok = await app.inject({ method: 'PATCH', url: '/api/projects/RHA', headers: h, payload: { githubRepo: 'https://github.com/Acme/Web.git' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().githubRepo).toBe('Acme/Web');
    const bad = await app.inject({ method: 'PATCH', url: '/api/projects/RHA', headers: h, payload: { githubRepo: 'not a repo' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('Not a GitHub repo. Use owner/name or the repo URL.');
    const clear = await app.inject({ method: 'PATCH', url: '/api/projects/RHA', headers: h, payload: { githubRepo: '' } });
    expect(clear.json().githubRepo).toBe('');
  });
});
