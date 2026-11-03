/**
 * Pobranie agenta z parowaniem: /agent/download (sesja, stopka EXPCFG01), GET/POST /api/agent/pair, token exa_ działa na /mcp.
 * Osobna baza tracker_test_pairing; pobieranie z GitHuba podmienione na lokalny plik.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_pairing';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let auth: typeof import('../src/server/auth.ts');
let app: import('fastify').FastifyInstance;
let sessionCookie: string;
const EXE = Buffer.from('MZ-fake-exe-bytes');
const { eq } = await import('drizzle-orm');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_pairing with (force)');
  await admin.unsafe('create database tracker_test_pairing');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'pr', name: 'Pair User' }).returning();
  const raw = randomBytes(16).toString('base64url');
  await dbmod.db.insert(schema.sessions).values({ id: auth.sha256(raw), userId: u.id, expiresAt: new Date(Date.now() + 864e5) });
  sessionCookie = `tracker_session=${raw}`;
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { registerMcp } = await import('../src/server/mcp.ts');
  const { registerOAuth } = await import('../src/server/oauth.ts');
  const pairing = await import('../src/server/pairing.ts');
  pairing.setAgentExeSource({ fetcher: async () => new Response(EXE, { status: 200 }) });
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerOAuth(app);
  await pairing.registerPairing(app);
  await registerMcp(app);
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

/** Czyta stopkę tak, jak zrobi to agent: ostatnie 12 bajtów = długość + znacznik. */
function readTrailer(body: Buffer) {
  expect(body.subarray(body.length - 8).toString('ascii')).toBe('EXPCFG01');
  const len = body.readUInt32LE(body.length - 12);
  const json = body.subarray(body.length - 12 - len, body.length - 12);
  return { cfg: JSON.parse(json.toString('utf8')) as { url: string; pairing: string }, exe: body.subarray(0, body.length - 12 - len) };
}
const download = async () => readTrailer((await app.inject({ method: 'GET', url: '/agent/download', headers: { cookie: sessionCookie } })).rawPayload);

describe('agent download', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/download' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('appends a parsable trailer to the exe', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/download', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('exponential-agent.exe');
    expect(res.headers['cache-control']).toBe('no-store');
    const { cfg, exe } = readTrailer(res.rawPayload);
    expect(exe.equals(EXE)).toBe(true);
    expect(cfg.url).toBe('http://localhost:5173');
    expect(cfg.pairing).toMatch(/^pair_/);
    expect((cfg as { engine?: string }).engine).toBe('claude');
  });
  it('carries the client chosen in the wizard as the engine', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/download?engine=codex', headers: { cookie: sessionCookie } });
    expect((readTrailer(res.rawPayload).cfg as { engine?: string }).engine).toBe('codex');
  });
});

describe('pairing', () => {
  it('pair info is valid, pair issues an exa_ token that works on /mcp, second use is 404', async () => {
    const { cfg } = await download();
    const info = await app.inject({ method: 'GET', url: `/api/agent/pair/${cfg.pairing}` });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ user: { name: 'Pair User' } });
    const res = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing, name: 'PC' } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.access_token).toMatch(/^exa_/);
    expect(j.refresh_token).toMatch(/^exr_/);
    expect(j.token_type).toBe('Bearer');
    expect(j.client_id).toBe('exponential-agent');
    expect(j.user.name).toBe('Pair User');
    const mcp = await app.inject({
      method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${j.access_token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    });
    expect(mcp.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/agent/pair/${cfg.pairing}` })).statusCode).toBe(404);
  });

  it('expired and unknown pairings are 404', async () => {
    const { cfg } = await download();
    await dbmod.db.update(schema.agentPairings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.agentPairings.hash, auth.sha256(cfg.pairing)));
    expect((await app.inject({ method: 'GET', url: `/api/agent/pair/${cfg.pairing}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: 'pair_nope' } })).statusCode).toBe(404);
  });

  it('answers 502 when GitHub fails', async () => {
    const pairing = await import('../src/server/pairing.ts');
    pairing.setAgentExeSource({ fetcher: async () => new Response('x', { status: 500 }) });
    const res = await app.inject({ method: 'GET', url: '/agent/download', headers: { cookie: sessionCookie } });
    expect(res.statusCode).toBe(502);
    pairing.setAgentExeSource({ fetcher: async () => new Response(EXE, { status: 200 }) });
  });
});
