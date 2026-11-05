/** Dziennik projektu: wpisy przy członkach, rolach, zaproszeniach i ustawieniach (bez sekretów) oraz trasa tylko dla adminów projektu. Baza tracker_test_plog. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_plog';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let pr: typeof import('../src/server/projects.ts');
let inv: typeof import('../src/server/invites.ts');
let plog: typeof import('../src/server/projectLog.ts');
let auth: typeof import('../src/server/auth.ts');
let app: import('fastify').FastifyInstance;
let sess: (userId: number) => Promise<Record<string, string>>;
let P: import('../src/server/projects.ts').Project;
let boss: { id: number; name: string; login: string; isAdmin: boolean };
let dave: { id: number; name: string; login: string };
let erin: { id: number; name: string; login: string };

const log = async (kind?: string) => (await plog.listProjectLog(P.id)).filter((e) => !kind || e.kind === kind);

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_plog with (force)');
  await admin.unsafe('create database tracker_test_plog');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  pr = await import('../src/server/projects.ts');
  inv = await import('../src/server/invites.ts');
  plog = await import('../src/server/projectLog.ts');
  auth = await import('../src/server/auth.ts');
  await (await import('../src/server/service.ts')).seedDefaults();
  const { db } = dbmod;
  [boss] = await db.insert(schema.users).values({ login: 'plboss', name: 'Boss' }).returning();
  [dave] = await db.insert(schema.users).values({ login: 'pldave', name: 'Dave' }).returning();
  [erin] = await db.insert(schema.users).values({ login: 'plerin', name: 'Erin' }).returning();
  P = await pr.createProject(boss.id, { key: 'PLG', name: 'Plog' });
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

describe('project log', () => {
  it('logs project creation', async () => {
    const e = (await log('project_created'))[0];
    expect(e.actor?.id).toBe(boss.id);
  });

  it('member added, role changed (only when it changes), member removed', async () => {
    const actor = { id: boss.id, isAdmin: true };
    await pr.addMember(actor, P.id, dave.login, 'member');
    const added = (await log('member_added'))[0];
    expect(added.target?.id).toBe(dave.id);
    expect(added.data).toMatchObject({ role: 'member' });

    await pr.addMember(actor, P.id, dave.login, 'member');
    expect(await log('role_changed')).toHaveLength(0);

    await pr.addMember(actor, P.id, dave.login, 'admin');
    const changed = await log('role_changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].data).toMatchObject({ from: 'member', to: 'admin' });
    expect(changed[0].actor?.id).toBe(boss.id);

    await pr.removeMember(P.id, dave.id, boss.id);
    const removed = (await log('member_removed'))[0];
    expect(removed.target?.id).toBe(dave.id);
    expect(removed.actor?.id).toBe(boss.id);
  });

  it('invite created and consumed', async () => {
    const i = await inv.createInvite(boss.id, P.id, 'member');
    expect((await log('invite_created'))[0].data).toMatchObject({ role: 'member' });
    await inv.consumeInvite(i.url.split('/').pop()!, erin.id);
    const joined = (await log('member_added')).find((e) => e.target?.id === erin.id)!;
    expect(joined.data).toMatchObject({ role: 'member', via: 'invite' });
    expect(joined.actor).toBeNull();
  });

  it('settings change stores no secret value and skips unchanged fields', async () => {
    const url = 'https://discord.com/api/webhooks/123456/SECRET-TOKEN-xyz';
    await pr.updateProject(P.id, { discordWebhookUrl: url, sprintLengthDays: 14 }, boss.id);
    const e = (await log('settings_changed'))[0];
    expect(JSON.stringify(e.data)).not.toContain(url);
    expect(JSON.stringify(e.data)).not.toContain('SECRET-TOKEN');
    expect(e.data).toMatchObject({ fields: { discordWebhookUrl: { set: true } } });
    const n = (await log('settings_changed')).length;
    await pr.updateProject(P.id, { sprintLengthDays: 14 }, boss.id);
    expect(await log('settings_changed')).toHaveLength(n);
    await pr.updateProject(P.id, { name: 'Plog 2' }, boss.id);
    expect((await log('settings_changed'))[0].data).toMatchObject({ fields: { name: { from: 'Plog', to: 'Plog 2' } } });
  });

  it('route: member gets 403, admin gets entries newest first with names', async () => {
    await dbmod.db.insert(schema.projectMembers).values({ projectId: P.id, userId: dave.id, role: 'member' });
    const denied = await app.inject({ method: 'GET', url: '/api/projects/PLG/log', headers: await sess(dave.id) });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/projects/PLG/log', headers: await sess(boss.id) });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as { id: number; kind: string; actor: { name: string } | null }[];
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].id).toBeGreaterThan(rows[i].id);
    expect(rows.find((r) => r.kind === 'project_created')?.actor?.name).toBe('Boss');
    const older = await app.inject({ method: 'GET', url: `/api/projects/PLG/log?before=${rows[0].id}`, headers: await sess(boss.id) });
    expect((older.json() as unknown[]).length).toBe(rows.length - 1);
  });
});
