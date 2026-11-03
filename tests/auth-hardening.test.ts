/**
 * Utwardzenie logowania i tokenów: trasy tylko dla agenta (H1), wygasanie kluczy trk_ (H10), reset i wylogowanie wszędzie,
 * CSRF wylogowania, drugi limiter logowania, admin po ID GitHuba (H11), maskowanie adresów w logach.
 * Osobna baza tracker_test_authhard, trasy przez Fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_authhard';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let auth: typeof import('../src/server/auth.ts');
let oauth: typeof import('../src/server/oauth.ts');
let app: import('fastify').FastifyInstance;
const { eq } = await import('drizzle-orm');
const XRW = { 'x-requested-with': 'exponential' };

async function mkUser(login: string, extra: Record<string, unknown> = {}) {
  const [u] = await dbmod.db.insert(schema.users).values({ login, name: login, ...extra }).returning();
  return u;
}
async function mkSession(userId: number) {
  const raw = randomBytes(16).toString('base64url');
  await dbmod.db.insert(schema.sessions).values({ id: auth.sha256(raw), userId, expiresAt: new Date(Date.now() + 864e5) });
  return `tracker_session=${raw}`;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_authhard with (force)');
  await admin.unsafe('create database tracker_test_authhard');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  oauth = await import('../src/server/oauth.ts');
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await oauth.registerOAuth(app);
  // Zaślepki tras agenta: sprawdzamy tylko bramkę tokenów z registerAuth.
  app.get('/api/agent/work', async () => ({ ok: true }));
  app.post('/api/agent/runs', async () => ({ ok: true }));
  app.post('/api/issues/:id/analyze/claim', async () => ({ ok: true }));
  app.post('/api/agent/start-jobs/:id/claim', async () => ({ ok: true }));
  app.delete('/api/agents/:id', async () => ({ ok: true }));
  app.patch('/api/agents/:id', async () => ({ ok: true }));
  app.get('/api/me', async (req) => ({ id: req.user?.id, agent: req.tokenAgent }));
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

describe('H1: agent-only routes', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/agent/work'], ['POST', '/api/agent/runs'], ['POST', '/api/issues/ACME-1/analyze/claim'],
    ['POST', '/api/agent/start-jobs/5/claim'], ['DELETE', '/api/agents/abc'], ['PATCH', '/api/agents/abc'],
  ];
  it('403 for a plain trk_ key and for an OAuth grant of another client', async () => {
    const u = await mkUser('h1a');
    const trk = await auth.createApiToken(u.id, 'cursor');
    await dbmod.db.insert(schema.oauthClients).values({ id: 'mcp-x', name: 'Cursor', redirectUris: ['http://127.0.0.1/cb'] });
    const exa = (await oauth.issueGrant('mcp-x', u.id, '')).access_token;
    for (const t of [trk, exa]) {
      for (const [method, url] of routes) {
        const r = await app.inject({ method: method as 'GET', url, headers: bearer(t) });
        expect(r.statusCode, `${method} ${url}`).toBe(403);
      }
      expect((await app.inject({ url: '/api/me', headers: bearer(t) })).json()).toMatchObject({ agent: false });
    }
  });
  it('allowed for the agent grant and for a trk_ key with an agentId', async () => {
    const u = await mkUser('h1b');
    await dbmod.db.insert(schema.oauthClients).values({ id: oauth.AGENT_CLIENT_ID, name: 'Exponential agent', redirectUris: ['http://127.0.0.1/cb'] }).onConflictDoNothing();
    const exa = (await oauth.issueGrant(oauth.AGENT_CLIENT_ID, u.id, '', null)).access_token;
    const trk = await auth.createApiToken(u.id, 'Claude Code · PC', randomUUID());
    for (const t of [exa, trk]) {
      for (const [method, url] of routes) {
        const r = await app.inject({ method: method as 'GET', url, headers: bearer(t) });
        expect(r.statusCode, `${method} ${url}`).toBe(200);
      }
      expect((await app.inject({ url: '/api/me', headers: bearer(t) })).json()).toMatchObject({ agent: true });
    }
  });
  it('the old local-agent route is no longer open to tokens', async () => {
    const u = await mkUser('h1c');
    const trk = await auth.createApiToken(u.id, 'k');
    expect(auth.tokenAllowed('POST', '/api/me/local-agent')).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/api/me/local-agent', headers: bearer(trk) })).statusCode).toBe(403);
  });
});

describe('H10: trk_ expiry', () => {
  it('new keys expire in 180 days; expired keys are rejected; legacy (null) keys get a date on first use', async () => {
    const u = await mkUser('h10a');
    const t = await auth.createApiToken(u.id, 'k');
    const hash = auth.sha256(t);
    const [row] = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hash));
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 864e5);
    expect(await auth.userFromToken(`Bearer ${t}`)).toMatchObject({ id: u.id });
    // Nieprzesunięty, bo zostało > 90 dni.
    const [same] = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hash));
    expect(same.expiresAt!.getTime()).toBe(row.expiresAt!.getTime());

    await dbmod.db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.tokenHash, hash));
    expect(await auth.userFromToken(`Bearer ${t}`)).toBeNull();

    await dbmod.db.update(schema.apiTokens).set({ expiresAt: null }).where(eq(schema.apiTokens.tokenHash, hash));
    expect(await auth.userFromToken(`Bearer ${t}`)).toMatchObject({ id: u.id });
    const [legacy] = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, hash));
    expect(legacy.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 864e5);
  });
  it('slides to 180 days when fewer than 90 remain', async () => {
    const u = await mkUser('h10b');
    const t = await auth.createApiToken(u.id, 'k');
    await dbmod.db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() + 10 * 864e5) }).where(eq(schema.apiTokens.tokenHash, auth.sha256(t)));
    expect(await auth.userFromToken(`Bearer ${t}`)).not.toBeNull();
    const [row] = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, auth.sha256(t)));
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 864e5);
  });
});

describe('H10: reset and logout-all revoke grants and keys', () => {
  it('password reset revokes OAuth grants and deletes trk_ keys of the account only', async () => {
    const { hashPassword } = await import('../src/server/password.ts');
    const { createResetLink } = await import('../src/server/invites.ts');
    const admin = await mkUser('h10admin', { isAdmin: true });
    const u = await mkUser('h10reset', { email: 'h10reset@example.com', passwordHash: await hashPassword('old-password-1') });
    const other = await mkUser('h10other');
    await dbmod.db.insert(schema.oauthClients).values({ id: 'mcp-r', name: 'Claude', redirectUris: ['http://127.0.0.1/cb'] });
    const exa = (await oauth.issueGrant('mcp-r', u.id, '')).access_token;
    const exaOther = (await oauth.issueGrant('mcp-r', other.id, '')).access_token;
    const trk = await auth.createApiToken(u.id, 'k');
    const trkOther = await auth.createApiToken(other.id, 'k');
    expect(await auth.userFromToken(`Bearer ${exa}`)).not.toBeNull();
    const { url } = await createResetLink(admin.id, u.id);
    const done = await app.inject({ method: 'POST', url: `/auth/reset/${url.split('/reset/')[1]}`, payload: { password: 'new-password-123' } });
    expect(done.statusCode).toBe(200);
    expect(await auth.userFromToken(`Bearer ${exa}`)).toBeNull();
    expect(await auth.userFromToken(`Bearer ${trk}`)).toBeNull();
    expect(await auth.userFromToken(`Bearer ${exaOther}`)).not.toBeNull();
    expect(await auth.userFromToken(`Bearer ${trkOther}`)).not.toBeNull();
  });
  it('POST /auth/logout-all needs the header and a session, and kills sessions, grants and keys', async () => {
    const u = await mkUser('h10all');
    const cookie = await mkSession(u.id);
    const cookie2 = await mkSession(u.id);
    await dbmod.db.insert(schema.oauthClients).values({ id: 'mcp-all', name: 'Codex', redirectUris: ['http://127.0.0.1/cb'] });
    const exa = (await oauth.issueGrant('mcp-all', u.id, '')).access_token;
    const trk = await auth.createApiToken(u.id, 'k');
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all', headers: XRW })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { ...XRW, ...bearer(exa) } })).statusCode).toBe(403); // tokenem nie wolno
    expect((await app.inject({ method: 'POST', url: '/auth/logout-all', headers: { ...XRW, cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().id).toBeUndefined();
    expect((await app.inject({ url: '/api/me', headers: { cookie: cookie2 } })).json().id).toBeUndefined();
    expect(await auth.userFromToken(`Bearer ${exa}`)).toBeNull();
    expect(await auth.userFromToken(`Bearer ${trk}`)).toBeNull();
  });
});

describe('logout CSRF', () => {
  it('POST /auth/logout without X-Requested-With is 403 and keeps the session', async () => {
    const u = await mkUser('lo1');
    const cookie = await mkSession(u.id);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().id).toBe(u.id);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...XRW } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).json().id).toBeUndefined();
  });
});

describe('C4: login limiter on e-mail alone', () => {
  it('blocks after 20 failures even when the IP changes', async () => {
    const { hashPassword } = await import('../src/server/password.ts');
    await mkUser('lim', { email: 'lim@example.com', passwordHash: await hashPassword('right-password-1') });
    const attempt = (ip: string, password: string) => app.inject({ method: 'POST', url: '/auth/password', remoteAddress: ip, payload: { email: 'lim@example.com', password } });
    for (let i = 0; i < 20; i++) expect((await attempt(`10.0.${Math.floor(i / 200)}.${i + 1}`, 'wrong-password-1')).statusCode).toBe(401);
    expect((await attempt('10.1.1.1', 'right-password-1')).statusCode).toBe(429);
  });
});

describe('H11: admin by GitHub id', () => {
  const gh = (id: number, login: string, created_at?: string) => ({ id, login, name: login, avatar_url: 'x', email: null, created_at });
  it('ADMIN_GITHUB_IDS wins over ADMIN_LOGINS', async () => {
    process.env.ADMIN_GITHUB_IDS = '9001, 9002';
    process.env.ADMIN_LOGINS = 'loginonly';
    try {
      expect(await auth.upsertGithubUser(gh(9100, 'loginonly'))).toBeNull();
      const id = await auth.upsertGithubUser(gh(9001, 'someadmin'));
      const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.id, id!));
      expect(u.isAdmin).toBe(true);
    } finally { delete process.env.ADMIN_GITHUB_IDS; delete process.env.ADMIN_LOGINS; }
  });
  it('ADMIN_LOGINS does not promote a login that belongs to an account with another githubId', async () => {
    process.env.ADMIN_LOGINS = 'renamed, freshadmin';
    try {
      await mkUser('renamed', { githubId: 5001 });
      expect(await auth.upsertGithubUser(gh(5002, 'renamed'))).toBeNull();
      const id = await auth.upsertGithubUser(gh(5003, 'freshadmin'));
      expect(id).not.toBeNull();
    } finally { delete process.env.ADMIN_LOGINS; }
  });
  it('a pre-added row is claimed by login only by a GitHub account older than the row', async () => {
    const row = await mkUser('preadded');
    const older = new Date(row.createdAt.getTime() - 864e5).toISOString();
    const newer = new Date(row.createdAt.getTime() + 864e5).toISOString();
    expect(await auth.upsertGithubUser(gh(7001, 'preadded', newer))).toBeNull();
    expect((await dbmod.db.select().from(schema.users).where(eq(schema.users.id, row.id)))[0].githubId).toBeNull();
    expect(await auth.upsertGithubUser(gh(7001, 'preadded', older))).toBe(row.id);
    // Potem rozpoznajemy po ID, także po zmianie loginu.
    expect(await auth.upsertGithubUser(gh(7001, 'preadded-renamed', newer))).toBe(row.id);
  });
  it('without created_at the login match is enough (warning only)', async () => {
    const row = await mkUser('nodate');
    expect(await auth.upsertGithubUser(gh(7100, 'nodate'))).toBe(row.id);
  });
});

describe('maskUrl', () => {
  it('masks pairing tokens and code/state/token query params', async () => {
    const { maskUrl } = await import('../src/server/rules.ts');
    expect(maskUrl('/api/agent/pair/pair_abc123?x=1')).toBe('/api/agent/pair/***?x=1');
    expect(maskUrl('/oauth/authorize?client_id=c&state=SECRET&code=XYZ&token=T')).toBe('/oauth/authorize?client_id=c&state=***&code=***&token=***');
    expect(maskUrl('/hooks/x?secret=s')).toBe('/hooks/x?secret=***');
    expect(maskUrl('/calendar/abcdef.ics')).toBe('/calendar/***');
  });
});
