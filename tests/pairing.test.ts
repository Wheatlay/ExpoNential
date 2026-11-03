/**
 * Pobranie agenta z parowaniem: /agent/download (sesja, stopka EXPCFG01), GET/POST /api/agent/pair, token exa_ działa na /mcp.
 * Osobna baza tracker_test_pairing; pobieranie z GitHuba podmienione na lokalny plik.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';

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

describe('goal in the trailer', () => {
  const goalOf = async (q: string) => (readTrailer((await app.inject({ method: 'GET', url: '/agent/download' + q, headers: { cookie: sessionCookie } })).rawPayload).cfg as { goal?: number }).goal;
  it('defaults to 3 and accepts 1..3 only', async () => {
    expect(await goalOf('')).toBe(3);
    expect(await goalOf('?goal=1')).toBe(1);
    expect(await goalOf('?engine=codex&goal=2')).toBe(2);
    expect(await goalOf('?goal=9')).toBe(3);
    expect(await goalOf('?goal=x')).toBe(3);
  });
});

describe('POST /api/agent/mcp-key', () => {
  const mcpInit = (token: string) => app.inject({
    method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
  });
  const post = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/api/agent/mcp-key', headers, payload: payload as object });
  const agentToken = async () => {
    const { cfg } = await download();
    return (await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing, deviceId: randomUUID() } })).json().access_token as string;
  };
  it('gives the agent grant a trk_ token that works on /mcp and replaces the same name', async () => {
    const exa = await agentToken();
    const res = await post({ authorization: `Bearer ${exa}` }, { client: 'Claude Code', device: 'PC-1' });
    expect(res.statusCode).toBe(200);
    const { token } = res.json();
    expect(token).toMatch(/^trk_/);
    expect((await mcpInit(token)).statusCode).toBe(200);
    const again = (await post({ authorization: `Bearer ${exa}` }, { client: 'Claude Code', device: 'PC-1' })).json().token as string;
    expect((await mcpInit(token)).statusCode).toBe(401);
    expect((await mcpInit(again)).statusCode).toBe(200);
    const rows = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.name, 'Claude Code · PC-1'));
    expect(rows).toHaveLength(1);
    expect((await post({ authorization: `Bearer ${exa}` }, { client: 'x'.repeat(41), device: 'PC' })).statusCode).toBe(400);
  });
  it('400 for an agent grant without a computer; only the key of the same computer and name is replaced', async () => {
    const { cfg } = await download();
    const noDev = (await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing } })).json().access_token as string;
    expect((await post({ authorization: `Bearer ${noDev}` }, { client: 'Codex', device: 'PC-X' })).statusCode).toBe(400);
    const a = await agentToken();
    const b = await agentToken();
    const ka = (await post({ authorization: `Bearer ${a}` }, { client: 'Cursor', device: 'SAME' })).json().token as string;
    const kb = (await post({ authorization: `Bearer ${b}` }, { client: 'Cursor', device: 'SAME' })).json().token as string;
    expect((await mcpInit(ka)).statusCode).toBe(200);
    expect((await mcpInit(kb)).statusCode).toBe(200);
    const [row] = await dbmod.db.select().from(schema.apiTokens).where(eq(schema.apiTokens.tokenHash, auth.sha256(ka)));
    expect(row.agentId).not.toBeNull();
    expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 179 * 864e5);
  });
  it('rejects a dynamically registered client named "Exponential agent"', async () => {
    const { cfg } = await download();
    await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing } });
    const [fake] = await dbmod.db.insert(schema.oauthClients).values({ id: 'fake-agent-client', name: 'Exponential agent', redirectUris: ['http://127.0.0.1/cb'] }).returning();
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.login, 'pr'));
    const { issueGrant } = await import('../src/server/oauth.ts');
    const g = await issueGrant(fake.id, u.id, '');
    expect((await post({ authorization: `Bearer ${g.access_token}` }, { client: 'Codex', device: 'PC' })).statusCode).toBe(403);
  });
  it('re-pairing clears the tombstone of that device; removeAgent revokes its grant and mcp key', async () => {
    const ag = await import('../src/server/agents.ts');
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.login, 'pr'));
    const dev = '99999999-9999-4999-8999-999999999999';
    const { cfg } = await download();
    const j = (await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: cfg.pairing, deviceId: dev } })).json();
    await ag.heartbeat(u, dev, { name: 'PC', busy: false, repoKeys: [] });
    const key = (await post({ authorization: `Bearer ${j.access_token}` }, { client: 'Claude Code', device: 'PC-DEL' })).json().token as string;
    expect((await mcpInit(key)).statusCode).toBe(200);
    await ag.removeAgent(u, dev);
    expect((await mcpInit(j.access_token)).statusCode).toBe(401);
    expect((await mcpInit(key)).statusCode).toBe(401);
    await expect(ag.heartbeat(u, dev, { name: 'PC', busy: false, repoKeys: [] })).rejects.toMatchObject({ code: 'conflict' });
    const again = (await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: (await download()).cfg.pairing, deviceId: dev } })).json();
    expect(again.access_token).toMatch(/^exa_/);
    await expect(ag.heartbeat(u, dev, { name: 'PC', busy: false, repoKeys: [] })).resolves.toBeTruthy();
  });
  it('rejects a session cookie, a trk_ token and other OAuth clients', async () => {
    expect((await post({ cookie: sessionCookie }, { client: 'Claude Code', device: 'PC' })).statusCode).toBe(403);
    const trk = (await post({ authorization: `Bearer ${await agentToken()}` }, { client: 'Codex', device: 'PC' })).json().token as string;
    expect((await post({ authorization: `Bearer ${trk}` }, { client: 'Codex', device: 'PC' })).statusCode).toBe(403);
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

describe('pairing name and rate limit', () => {
  it('uses the body name for the agents row (insert, then update) and does not touch the computer of another user', async () => {
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.login, 'pr'));
    const dev = randomUUID();
    await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: (await download()).cfg.pairing, deviceId: dev, name: 'Desk-1' } });
    expect((await dbmod.db.select().from(schema.agents).where(eq(schema.agents.id, dev)))[0]).toMatchObject({ name: 'Desk-1', userId: u.id });
    await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: (await download()).cfg.pairing, deviceId: dev, name: 'Desk-2' } });
    expect((await dbmod.db.select().from(schema.agents).where(eq(schema.agents.id, dev)))[0].name).toBe('Desk-2');
    const [other] = await dbmod.db.insert(schema.users).values({ login: 'pr2', name: 'Other' }).returning();
    const foreign = randomUUID();
    await dbmod.db.insert(schema.agents).values({ id: foreign, userId: other.id, name: 'Theirs' });
    await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: (await download()).cfg.pairing, deviceId: foreign, name: 'Hijack' } });
    expect((await dbmod.db.select().from(schema.agents).where(eq(schema.agents.id, foreign)))[0].name).toBe('Theirs');
  });
  it('429 carries error rate_limited', async () => {
    let last: { statusCode: number; json: () => { error: string } } | undefined;
    for (let i = 0; i < 70; i++) last = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairing: 'pair_x' }, remoteAddress: '10.9.9.9' });
    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toEqual({ error: 'rate_limited' });
  });
});

describe('download file name', () => {
  it('reads the agent version from the GitHub release URL', async () => {
    const { versionFromUrl } = await import('../src/server/pairing.ts');
    expect(versionFromUrl('https://github.com/Wheatlay/ExpoNential/releases/download/agent-v0.4.0/exponential-agent.exe')).toBe('0.4.0');
    expect(versionFromUrl('http://127.0.0.1:9123/x.exe')).toBe('');
  });
});
