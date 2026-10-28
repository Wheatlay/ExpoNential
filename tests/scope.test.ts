/**
 * Zakres tokenów Bearer (trk_ i exa_) i sprzątanie OAuth.
 * Osobna baza tracker_test_scope, trasy przez Fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_scope';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let auth: typeof import('../src/server/auth.ts');
let oauth: typeof import('../src/server/oauth.ts');
let app: import('fastify').FastifyInstance;
let sessionCookie: string;
let trk: string;
let exa: string;
let userId: number;
const { eq } = await import('drizzle-orm');

const FORBIDDEN = 'This token can only be used by AI clients and the agent';
const OLD = new Date(Date.now() - 3 * 864e5);

async function mkClient(id: string, createdAt: Date) {
  await dbmod.db.insert(schema.oauthClients).values({ id, name: id, redirectUris: ['http://127.0.0.1:1/cb'], createdAt });
}
async function mkGrant(clientId: string, o: { revokedAt?: Date | null; refreshExpiresAt?: Date; token?: string } = {}) {
  const token = o.token ?? `exa_${randomBytes(16).toString('hex')}`;
  const [g] = await dbmod.db.insert(schema.oauthGrants).values({
    clientId, userId, accessHash: auth.sha256(token), refreshHash: auth.sha256(`exr_${token}`),
    accessExpiresAt: new Date(Date.now() + 3600e3), refreshExpiresAt: o.refreshExpiresAt ?? new Date(Date.now() + 864e5), revokedAt: o.revokedAt ?? null,
  }).returning();
  return { token, id: g.id };
}

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_scope with (force)');
  await admin.unsafe('create database tracker_test_scope');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  oauth = await import('../src/server/oauth.ts');
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'sc', name: 'Scope User' }).returning();
  userId = u.id;
  const raw = randomBytes(16).toString('base64url');
  await dbmod.db.insert(schema.sessions).values({ id: auth.sha256(raw), userId, expiresAt: new Date(Date.now() + 864e5) });
  sessionCookie = `tracker_session=${raw}`;
  trk = await auth.createApiToken(userId, 't');
  await mkClient('c-live', new Date());
  exa = (await mkGrant('c-live')).token;
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { registerApi } = await import('../src/server/api.ts');
  const { registerMcp } = await import('../src/server/mcp.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerApi(app);
  await registerOAuth_();
  await registerMcp(app);
});
async function registerOAuth_() { await oauth.registerOAuth(app); }
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe.each([['trk_', () => trk], ['exa_', () => exa]])('token %s', (_n, get) => {
  it('is refused outside AI/agent routes', async () => {
    for (const [method, url] of [['POST', '/api/tokens'], ['GET', '/api/tokens'], ['DELETE', '/api/tokens/1'], ['GET', '/api/connections'], ['DELETE', '/api/connections/1']] as const) {
      const r = await app.inject({ method, url, headers: as(get()), payload: method === 'POST' ? { name: 'x' } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error).toBe(FORBIDDEN);
    }
  });

  it('may use /mcp, /api/me and agent routes', async () => {
    const init = await app.inject({
      method: 'POST', url: '/mcp', headers: { ...as(get()), accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    });
    expect(init.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: as(get()) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: as(get()) })).statusCode).toBe(200);
    // Trasa agenta przechodzi przez filtr tokenu (wynik może być inny niż 403 z naszej bramki).
    const work = await app.inject({ method: 'GET', url: '/api/agent/work?deviceId=d1', headers: as(get()) });
    expect(work.json()?.error).not.toBe(FORBIDDEN);
    const claim = await app.inject({ method: 'POST', url: '/api/issues/ACME-1/analyze/claim', headers: as(get()), payload: {} });
    expect(claim.json()?.error).not.toBe(FORBIDDEN);
  });
});

describe('session cookie', () => {
  it('still creates and lists tokens and connections', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/tokens', headers: { cookie: sessionCookie }, payload: { name: 'cli' } });
    expect(r.statusCode).toBeLessThan(300);
    expect((await app.inject({ method: 'GET', url: '/api/connections', headers: { cookie: sessionCookie } })).statusCode).toBe(200);
  });
});

describe('oauth sweep', () => {
  it('removes old clients without grants, revoked and expired grants; keeps live ones', async () => {
    await mkClient('c-old-empty', OLD);
    await mkClient('c-new-empty', new Date());
    await mkClient('c-old-live', OLD);
    await mkClient('c-old-revoked', OLD);
    const live = await mkGrant('c-old-live');
    const revoked = await mkGrant('c-old-revoked', { revokedAt: OLD });
    const expired = await mkGrant('c-old-live', { refreshExpiresAt: OLD });
    await oauth.sweepOAuth();
    const clients = (await dbmod.db.select({ id: schema.oauthClients.id }).from(schema.oauthClients)).map((c) => c.id);
    expect(clients).not.toContain('c-old-empty');
    expect(clients).not.toContain('c-old-revoked');
    expect(clients).toContain('c-new-empty');
    expect(clients).toContain('c-old-live');
    expect(clients).toContain('c-live');
    const grants = (await dbmod.db.select({ id: schema.oauthGrants.id }).from(schema.oauthGrants)).map((g) => g.id);
    expect(grants).toContain(live.id);
    expect(grants).not.toContain(revoked.id);
    expect(grants).not.toContain(expired.id);
    expect((await dbmod.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.id, live.id))).length).toBe(1);
  });
});
