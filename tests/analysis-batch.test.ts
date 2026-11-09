/**
 * Paczka 1.3.23: analiza wymaga repo, 24 h bez komputera = błąd, bez dubli w aktywności, powód oczekiwania, tagi dodawane przez admina,
 * etykieta od członka, discordProjects, wzmianka a nieprzeczytane. Osobna baza tracker_test_batch, trasy przez Fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_batch';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let svc: typeof import('../src/server/service.ts');
let ag: typeof import('../src/server/agents.ts');
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
const call = (login: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie: cookies[login], 'x-project': P.key }, payload: payload as object | undefined });
const actorOf = (login: string) => ({ id: ids[login], name: login });
const activityKinds = async (issueId: number) =>
  (await dbmod.db.select().from(schema.activity).where(eq(schema.activity.issueId, issueId))).map((a) => a.payload.kind);

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_batch with (force)');
  await admin.unsafe('create database tracker_test_batch');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  svc = await import('../src/server/service.ts');
  ag = await import('../src/server/agents.ts');
  const projects = await import('../src/server/projects.ts');
  const boss = await mkUser('boss');
  await mkUser('mia');
  await mkUser('lee');
  P = await projects.createProject(boss.id, { key: 'BAT', name: 'Batch' });
  for (const l of ['mia', 'lee']) await dbmod.db.insert(schema.projectMembers).values({ projectId: P.id, userId: ids[l], role: 'member' });
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const auth = await import('../src/server/auth.ts');
  const { registerApi } = await import('../src/server/api.ts');
  const { registerMeetings } = await import('../src/server/meetingsApi.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerApi(app);
  await registerMeetings(app);
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

describe('analysis without repo, duplicates, 24 h timeout', () => {
  it('answers 400 no_repo when the project has no GitHub repo, and accepts once it has one', async () => {
    const issue = await svc.createIssue(P as never, actorOf('boss'), { title: 'Needs repo' });
    const no = await call('boss', 'POST', `/api/issues/BAT-${issue.number}/analyze`, {});
    expect(no.statusCode).toBe(400);
    expect(no.json()).toEqual({ error: 'no_repo' });
    const detail = await call('boss', 'GET', `/api/issues/BAT-${issue.number}`);
    expect(detail.json().projectHasRepo).toBe(false);
    await dbmod.db.update(schema.projects).set({ githubRepo: 'acme/web' }).where(eq(schema.projects.id, P.id));
    const ok = await call('boss', 'POST', `/api/issues/BAT-${issue.number}/analyze`, {});
    expect(ok.statusCode).toBe(200);
    expect((await call('boss', 'GET', `/api/issues/BAT-${issue.number}`)).json().projectHasRepo).toBe(true);
  });

  it('does not write a second analysis_requested while the request is waiting and unclaimed', async () => {
    const issue = await svc.createIssue(P as never, actorOf('boss'), { title: 'Double click' });
    await call('boss', 'POST', `/api/issues/BAT-${issue.number}/analyze`, {});
    await call('boss', 'POST', `/api/issues/BAT-${issue.number}/analyze`, {});
    const kinds = await activityKinds(issue.id);
    expect(kinds.filter((k) => k === 'analysis_requested')).toHaveLength(1);
  });

  it('fails an unclaimed request after 24 h with an activity entry; a fresh one stays', async () => {
    const old = await svc.createIssue(P as never, actorOf('boss'), { title: 'Forgotten' });
    const fresh = await svc.createIssue(P as never, actorOf('boss'), { title: 'Fresh' });
    await svc.requestAnalysis(P as never, actorOf('boss'), old.number);
    await svc.requestAnalysis(P as never, actorOf('boss'), fresh.number);
    await dbmod.db.update(schema.issues).set({ analysisRequestedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(schema.issues.id, old.id));
    expect(await ag.expireUnclaimedAnalyses()).toBe(1);
    const [row] = await dbmod.db.select().from(schema.issues).where(eq(schema.issues.id, old.id));
    expect(row.analysisFailedAt).not.toBeNull();
    expect(row.analysisError).toBe('No PC took the analysis within 24h');
    const act = (await dbmod.db.select().from(schema.activity).where(eq(schema.activity.issueId, old.id))).map((a) => a.payload);
    expect(act).toContainEqual({ kind: 'analysis_failed', error: 'No PC took the analysis within 24h' });
    const [f] = await dbmod.db.select().from(schema.issues).where(eq(schema.issues.id, fresh.id));
    expect(f.analysisFailedAt).toBeNull();
    // Drugi przebieg niczego nie robi.
    expect(await ag.expireUnclaimedAnalyses()).toBe(0);
  });

  it('writes analysis_failed when the agent reports a failure', async () => {
    const issue = await svc.createIssue(P as never, actorOf('boss'), { title: 'Agent fails' });
    await svc.requestAnalysis(P as never, actorOf('boss'), issue.number);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    await dbmod.db.insert(schema.agents).values({ id: deviceId, userId: ids.boss });
    await dbmod.db.update(schema.issues).set({ analysisClaimedAt: new Date(), analysisClaimedBy: ids.boss, analysisClaimedDevice: deviceId }).where(eq(schema.issues.id, issue.id));
    await ag.releaseClaim(P as never, { id: ids.boss }, issue.number, deviceId, 'boom');
    const act = (await dbmod.db.select().from(schema.activity).where(eq(schema.activity.issueId, issue.id))).map((a) => a.payload);
    expect(act).toContainEqual({ kind: 'analysis_failed', error: 'boom' });
  });

  it('gives a wait reason only for requested, unclaimed issues, and consent-pending flips it', async () => {
    const issue = await svc.createIssue(P as never, actorOf('mia'), { title: 'Waiting' });
    await svc.requestAnalysis(P as never, actorOf('mia'), issue.number);
    let d = (await call('mia', 'GET', `/api/issues/BAT-${issue.number}`)).json();
    expect(d.analysisWaitReason).toBe('queue_off'); // kolejka zespołu wyłączona, mia nie ma własnego komputera
    await dbmod.db.update(schema.projects).set({ agentTeamQueue: true }).where(eq(schema.projects.id, P.id));
    d = (await call('mia', 'GET', `/api/issues/BAT-${issue.number}`)).json();
    expect(d.analysisWaitReason).toBe('no_pc_online');
    await ag.setConsentPending({ id: ids.boss }, issue.id, true);
    const list = (await call('mia', 'GET', '/api/issues')).json() as { number: number; analysisWaitReason: string | null }[];
    expect(list.find((x) => x.number === issue.number)?.analysisWaitReason).toBe('awaiting_consent');
    await ag.setConsentPending({ id: ids.boss }, issue.id, false);
    expect((await call('mia', 'GET', `/api/issues/BAT-${issue.number}`)).json().analysisWaitReason).toBe('no_pc_online');
    const plain = await svc.createIssue(P as never, actorOf('mia'), { title: 'Not requested' });
    expect((await call('mia', 'GET', `/api/issues/BAT-${plain.number}`)).json().analysisWaitReason).toBeNull();
  });
});

describe('tag members', () => {
  it('lets a project admin add and remove any member, forbids others', async () => {
    const tag = (await call('mia', 'POST', '/api/tags', { name: 'crew', color: 'green' })).json();
    const add = await call('boss', 'POST', `/api/tags/${tag.id}/members`, { userId: ids.lee });
    expect(add.statusCode).toBe(200);
    const has = async () => (await dbmod.db.select().from(schema.userTagMembers).where(and(eq(schema.userTagMembers.tagId, tag.id), eq(schema.userTagMembers.userId, ids.lee)))).length;
    expect(await has()).toBe(1);
    // Zwykły członek nie ruszy cudzych tagów, ale własne może.
    expect((await call('mia', 'DELETE', `/api/tags/${tag.id}/members/${ids.lee}`)).statusCode).toBe(403);
    expect((await call('mia', 'POST', `/api/tags/${tag.id}/members`, { userId: ids.boss })).statusCode).toBe(403);
    expect((await call('lee', 'DELETE', `/api/tags/${tag.id}/members/${ids.lee}`)).statusCode).toBe(200);
    expect(await has()).toBe(0);
    expect((await call('boss', 'POST', `/api/tags/${tag.id}/members`, { userId: ids.lee })).statusCode).toBe(200);
    expect((await call('boss', 'DELETE', `/api/tags/${tag.id}/members/${ids.lee}`)).statusCode).toBe(200);
    expect(await has()).toBe(0);
  });
});

describe('labels by members', () => {
  it('creates a label for a non-admin member with a default color and returns the existing one on a repeat', async () => {
    const res = await call('mia', 'POST', '/api/labels', { name: 'Checkout' });
    expect(res.statusCode).toBe(200);
    const label = res.json();
    expect(label).toMatchObject({ name: 'Checkout', projectId: P.id });
    expect(label.color).toMatch(/^#/);
    const again = (await call('lee', 'POST', '/api/labels', { name: 'checkout', color: '#000000' })).json();
    expect(again.id).toBe(label.id);
    expect(again.color).toBe(label.color);
    // Obcy projekt: bez członkostwa nie ma etykiety.
    expect((await call('mia', 'POST', '/api/labels', { projectKey: 'NOPE', name: 'x' })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('notify settings', () => {
  it('lists projects with a Discord webhook and stores analysisToastSticky', async () => {
    let s = (await call('mia', 'GET', '/api/notify-settings')).json();
    expect(s.analysisToastSticky).toBe(true);
    expect(s.discordProjects).toEqual([]);
    await dbmod.db.update(schema.projects).set({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' }).where(eq(schema.projects.id, P.id));
    s = (await call('mia', 'GET', '/api/notify-settings')).json();
    expect(s.discordProjects).toEqual([{ key: 'BAT', name: 'Batch' }]);
    const put = (await call('mia', 'PUT', '/api/notify-settings', { analysisToastSticky: false })).json();
    expect(put.analysisToastSticky).toBe(false);
    expect((await call('mia', 'GET', '/api/notify-settings')).json().analysisToastSticky).toBe(false);
  });

  it('checks a push subscription and answers a test push without crashing', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect((await call('mia', 'GET', `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`)).json()).toEqual({ exists: false });
    await dbmod.db.insert(schema.pushSubscriptions).values({ userId: ids.mia, endpoint, p256dh: 'x', auth: 'y' });
    expect((await call('mia', 'GET', `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`)).json()).toEqual({ exists: true });
    expect((await call('lee', 'GET', `/api/push/subscription?endpoint=${encodeURIComponent(endpoint)}`)).json()).toEqual({ exists: false });
    const t = (await call('mia', 'POST', '/api/push/test', { endpoint })).json();
    expect(typeof t.ok).toBe('boolean');
  });
});

describe('me editor and start-work', () => {
  it('stores the editor choice and validates it', async () => {
    expect((await call('mia', 'GET', '/api/me')).json().editor).toBe('vscode');
    expect((await call('mia', 'PUT', '/api/me', { editor: 'cursor' })).json().editor).toBe('cursor');
    expect((await call('mia', 'PUT', '/api/me', { editor: 'emacs' })).statusCode).toBe(400);
  });

  it('queues an open request when an agent is online, otherwise hands back the prompt', async () => {
    const issue = await svc.createIssue(P as never, actorOf('mia'), { title: 'Start me' });
    const off = (await call('mia', 'POST', '/api/start-work', { issueId: `BAT-${issue.number}` })).json();
    expect(off.viaAgent).toBe(false);
    expect(off.prompt).toContain(`BAT-${issue.number}`);
    await dbmod.db.insert(schema.agents).values({ id: '22222222-2222-4222-8222-222222222222', userId: ids.mia, version: '9.9.9', lastSeenAt: new Date() });
    // PC online but without a folder for the repo: the agent would skip it, so the browser link with a warning.
    const noRepo = (await call('mia', 'POST', '/api/start-work', { issueId: `BAT-${issue.number}` })).json();
    expect(noRepo).toMatchObject({ viaAgent: false, noRepo: true });
    await dbmod.db.insert(schema.agentRepos).values({ agentId: '22222222-2222-4222-8222-222222222222', projectId: P.id, path: 'C:/r', status: 'ok' });
    const on = (await call('mia', 'POST', '/api/start-work', { issueId: `BAT-${issue.number}` })).json();
    // A second click before the agent picks it up replaces the request instead of queueing another tab.
    await call('mia', 'POST', '/api/start-work', { issueId: `BAT-${issue.number}` });
    expect(on).toEqual({ viaAgent: true });
    const q = (await call('mia', 'GET', '/api/agent/open-requests')).json();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ editor: 'cursor', repo: 'acme/web' });
    expect(q[0].prompt).toContain(`BAT-${issue.number}`);
    expect((await call('mia', 'GET', '/api/agent/open-requests')).json()).toEqual([]);
  });
});

describe('agent error display', () => {
  it('hides an error older than the last successful run on an online PC', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const t0 = new Date(Date.now() - 3600_000);
    await dbmod.db.insert(schema.agents).values({ id, userId: ids.lee, version: '9.9.9', lastSeenAt: new Date(), lastError: 'Claude failed', lastErrorAt: t0 });
    const shown = async () => (await call('lee', 'GET', '/api/agents')).json().find((a: { id: string }) => a.id === id).lastError;
    expect(await shown()).toBe('Claude failed');
    await dbmod.db.update(schema.agents).set({ lastOkAt: new Date() }).where(eq(schema.agents.id, id));
    expect(await shown()).toBe('');
  });
});

describe('unread comments from a mention', () => {
  it('counts only comments from the mention on when the viewer qualifies only via the inbox', async () => {
    const issue = await svc.createIssue(P as never, actorOf('boss'), { title: 'Long thread' });
    await svc.addComment(P as never, actorOf('boss'), issue.number, 'old 1');
    await svc.addComment(P as never, actorOf('boss'), issue.number, 'old 2');
    await svc.addComment(P as never, actorOf('boss'), issue.number, '@lee please look');
    await svc.addComment(P as never, actorOf('boss'), issue.number, 'after 1');
    const unread = async (login: string) => (await svc.listIssues(P as never, { viewerId: ids[login] })).find((x) => x.number === issue.number)!.unreadComments;
    expect(await unread('lee')).toBe(2); // wzmianka i komentarz po niej, bez dwóch starszych
    // Autor zgłoszenia nadal liczy wszystko, co napisali inni (tu: nic, bo wszystko napisał sam).
    expect(await unread('boss')).toBe(0);
    // Ktoś, kto sam skomentował, wraca do pełnego zakresu.
    await svc.addComment(P as never, actorOf('mia'), issue.number, 'my comment');
    await svc.addComment(P as never, actorOf('boss'), issue.number, 'after 2');
    expect(await unread('mia')).toBe(1);
  });
});
