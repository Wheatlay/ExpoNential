/**
 * Stan podłączenia AI w /api/me (aiStatus): flagi klient, ślad pracy i agent przełączają się na zdarzeniach.
 * Prawdziwa baza z docker compose (tracker_test).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_me';

let svc: typeof import('../src/server/service.ts');
let ag: typeof import('../src/server/agents.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let P: import('../src/server/projects.ts').Project;
let u: { id: number; name: string };

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_me with (force)');
  await admin.unsafe('create database tracker_test_me');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  ag = await import('../src/server/agents.ts');
  schema = await import('../src/db/schema.ts');
  const projects = await import('../src/server/projects.ts');
  const { db } = dbmod;
  const [creator] = await db.insert(schema.users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  P = await projects.createProject(creator.id, { key: 'ME', name: 'Me' });
  await svc.seedDefaults();
  [u] = await db.insert(schema.users).values({ login: 'carol', name: 'Carol' }).returning();
});
afterAll(async () => { await dbmod?.sql.end(); });

describe('aiStatus', () => {
  it('starts with everything off', async () => {
    expect(await ag.aiStatus(u)).toEqual({ client: false, clientName: null, clientAt: null, workTrace: false, agent: false });
  });

  it('client turns on with the first MCP call of an OAuth grant, and off again when it is revoked', async () => {
    const { db } = dbmod;
    await db.insert(schema.oauthClients).values({ id: 'c1', name: 'Codex', redirectUris: [] });
    const [g] = await db.insert(schema.oauthGrants).values({
      clientId: 'c1', userId: u.id, accessHash: 'a1', refreshHash: 'r1', accessExpiresAt: new Date(Date.now() + 1e6), refreshExpiresAt: new Date(Date.now() + 1e7),
    }).returning();
    expect((await ag.aiStatus(u)).client).toBe(false);
    await db.update(schema.oauthGrants).set({ firstMcpAt: new Date() }).where(dz(g.id));
    const s = await ag.aiStatus(u);
    expect(s.client).toBe(true);
    expect(s.clientName).toBe('Codex');
    expect(s.clientAt).toBeTruthy();
    await db.update(schema.oauthGrants).set({ revokedAt: new Date() }).where(dz(g.id));
    expect((await ag.aiStatus(u)).client).toBe(false);
  });

  it('a used API token counts as Claude Code', async () => {
    const { db } = dbmod;
    await db.insert(schema.apiTokens).values({ userId: u.id, name: 't', tokenHash: 'h1' });
    expect((await ag.aiStatus(u)).client).toBe(false);
    await db.update(schema.apiTokens).set({ lastUsedAt: new Date() });
    const s = await ag.aiStatus(u);
    expect(s.client).toBe(true);
    expect(s.clientName).toBe('Claude Code');
  });

  it('workTrace turns on with the first worklog written by the user', async () => {
    const n = (await svc.createIssue(P, null, { title: 't' })).number;
    await svc.upsertWorklog(P, { id: u.id, name: u.name } as never, n, { session: 's1', repo: 'x', files: [], commits: [], prompts: [] });
    expect((await ag.aiStatus(u)).workTrace).toBe(true);
  });

  it('agent needs an online computer with an up to date version', async () => {
    const { db } = dbmod;
    const [a] = await db.insert(schema.agents).values({ id: '66666666-6666-4666-8666-666666666666', userId: u.id, name: 'PC', version: 'old', lastSeenAt: new Date() }).returning();
    expect((await ag.aiStatus(u)).agent).toBe(false);
    await db.update(schema.agents).set({ version: ag.agentScriptsVersion() }).where(dz2(a.id));
    expect((await ag.aiStatus(u)).agent).toBe(true);
    await db.update(schema.agents).set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) }).where(dz2(a.id));
    expect((await ag.aiStatus(u)).agent).toBe(false);
  });
});

import { eq } from 'drizzle-orm';
const dz = (id: number) => eq(schema.oauthGrants.id, id);
const dz2 = (id: string) => eq(schema.agents.id, id);
