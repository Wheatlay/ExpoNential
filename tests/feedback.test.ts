/**
 * "Report a bug or idea": zgłoszenie od osoby spoza projektu trafia jako zadanie do projektu wybranego przez admina workspace.
 * Osobna baza tracker_test_feedback, trasy przez Fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_feedback';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let fb: typeof import('../src/server/feedback.ts');
let app: import('fastify').FastifyInstance;
let P: { id: number; key: string };
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
const { and, eq } = await import('drizzle-orm');

async function mkUser(login: string, isAdmin = false) {
  const [u] = await dbmod.db.insert(schema.users).values({ login, name: login, isAdmin }).returning();
  const raw = randomBytes(16).toString('base64url');
  const auth = await import('../src/server/auth.ts');
  await dbmod.db.insert(schema.sessions).values({ id: auth.sha256(raw), userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  cookies[login] = `tracker_session=${raw}`;
  ids[login] = u.id;
  return u;
}
const call = (login: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: cookies[login] }, payload: payload as object | undefined });
const body = (over: object = {}) => ({ kind: 'bug', title: 'Nie działa', description: 'Kliknąłem i nic', page: '/board', client: 'Firefox 130', ...over });

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_feedback with (force)');
  await admin.unsafe('create database tracker_test_feedback');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  fb = await import('../src/server/feedback.ts');
  const svc = await import('../src/server/service.ts');
  await svc.seedDefaults();
  const projects = await import('../src/server/projects.ts');
  const boss = await mkUser('boss', true);
  await mkUser('outsider');
  await mkUser('spammer');
  P = await projects.createProject(boss.id, { key: 'FBK', name: 'Feedback' });
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const auth = await import('../src/server/auth.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  const { registerApi } = await import('../src/server/api.ts');
  await registerApi(app);
  await fb.registerFeedback(app);
});
afterAll(async () => { delete process.env.DEMO_MODE; await app?.close(); await dbmod?.sql.end(); });

describe('feedback', () => {
  it('answers 400 while no project is chosen', async () => {
    expect((await call('outsider', 'GET', '/api/feedback')).json()).toEqual({ configured: false });
    const r = await call('outsider', 'POST', '/api/feedback', body());
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('Reporting is not set up');
  });

  it('only a workspace admin chooses the project', async () => {
    expect((await call('outsider', 'PUT', '/api/admin/feedback-project', { projectId: P.id })).statusCode).toBe(403);
    expect((await call('boss', 'PUT', '/api/admin/feedback-project', { projectId: 99999 })).statusCode).toBe(404);
    expect((await call('boss', 'PUT', '/api/admin/feedback-project', { projectId: P.id })).statusCode).toBe(200);
    expect((await call('boss', 'GET', '/api/feedback')).json()).toEqual({ configured: true, projectId: P.id });
    expect((await call('outsider', 'GET', '/api/feedback')).json()).toEqual({ configured: true });
  });

  it('a non-member creates a bug in the chosen project with the Bug label and details; the answer has no issue id', async () => {
    const r = await call('outsider', 'POST', '/api/feedback', body());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const [issue] = await dbmod.db.select().from(schema.issues).where(eq(schema.issues.title, 'Nie działa'));
    expect(issue.projectId).toBe(P.id);
    expect(issue.creatorId).toBe(ids.outsider);
    expect(issue.description).toContain('Kliknąłem i nic');
    expect(issue.description).toContain('Page: /board');
    expect(issue.description).toContain('Browser: Firefox 130');
    expect(issue.description).toMatch(/App version: \d+\.\d+\.\d+/);
    const [st] = await dbmod.db.select().from(schema.statuses).where(eq(schema.statuses.id, issue.statusId));
    expect(st.type).toBe('unstarted');
    const links = await dbmod.db.select({ name: schema.labels.name }).from(schema.issueLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.issueLabels.labelId)).where(eq(schema.issueLabels.issueId, issue.id));
    expect(links.map((l) => l.name)).toEqual(['Bug']);
  });

  it('an idea gets the Feature label, reuses an existing label and has no technical details', async () => {
    const before = await dbmod.db.select().from(schema.labels).where(and(eq(schema.labels.projectId, P.id), eq(schema.labels.name, 'Bug')));
    expect((await call('outsider', 'POST', '/api/feedback', body({ kind: 'idea', title: 'Ciemny motyw' }))).statusCode).toBe(200);
    const [issue] = await dbmod.db.select().from(schema.issues).where(eq(schema.issues.title, 'Ciemny motyw'));
    expect(issue.description).not.toContain('Browser:');
    const all = await dbmod.db.select().from(schema.labels).where(eq(schema.labels.projectId, P.id));
    expect(all.filter((l) => l.name === 'Bug')).toHaveLength(before.length);
    expect(all.filter((l) => l.name === 'Feature')).toHaveLength(1);
  });

  it('refuses invalid input', async () => {
    expect((await call('outsider', 'POST', '/api/feedback', body({ title: '  ' }))).statusCode).toBe(400);
    expect((await call('outsider', 'POST', '/api/feedback', body({ kind: 'rant' }))).statusCode).toBe(400);
  });

  it('allows 10 reports per user per hour', async () => {
    fb.resetFeedbackLimit();
    for (let i = 0; i < 10; i++) expect((await call('spammer', 'POST', '/api/feedback', body({ title: `Spam ${i}` }))).statusCode).toBe(200);
    expect((await call('spammer', 'POST', '/api/feedback', body({ title: 'Spam 10' }))).statusCode).toBe(429);
    expect((await call('outsider', 'POST', '/api/feedback', body({ title: 'Inna osoba' }))).statusCode).toBe(200);
  });

  it('is refused in the demo', async () => {
    fb.resetFeedbackLimit();
    process.env.DEMO_MODE = '1';
    try {
      expect((await call('outsider', 'POST', '/api/feedback', body({ title: 'Demo' }))).statusCode).toBe(403);
    } finally { delete process.env.DEMO_MODE; }
    expect(await dbmod.db.select().from(schema.issues).where(eq(schema.issues.title, 'Demo'))).toHaveLength(0);
  });

  it('can be switched off again', async () => {
    expect((await call('boss', 'PUT', '/api/admin/feedback-project', { projectId: null })).statusCode).toBe(200);
    expect((await call('outsider', 'POST', '/api/feedback', body({ title: 'Po wyłączeniu' }))).statusCode).toBe(400);
  });
});
