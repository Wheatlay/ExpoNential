/**
 * MCP zawężone do jednego zgłoszenia (nagłówek X-Exponential-Issue): tylko get_issue, list_comments, get_procedure, set_analysis,
 * i tylko dla tego zgłoszenia.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_mcpscope';

let dbmod: typeof import('../src/db/index.ts');
let app: import('fastify').FastifyInstance;
let token: string;
let n1: number, n2: number;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_mcpscope with (force)');
  await admin.unsafe('create database tracker_test_mcpscope');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  const svc = await import('../src/server/service.ts');
  const mcp = await import('../src/server/mcp.ts');
  const schema = await import('../src/db/schema.ts');
  const projects = await import('../src/server/projects.ts');
  const [creator] = await dbmod.db.insert(schema.users).values({ login: 'seed-creator', name: 'Seed' }).returning();
  const P = await projects.createProject(creator.id, { key: 'SC', name: 'Scope' });
  await svc.seedDefaults();
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'dora', name: 'Dora' }).returning();
  await dbmod.db.insert(schema.projectMembers).values({ projectId: P.id, userId: u.id });
  n1 = (await svc.createIssue(P, null, { title: 'one' })).number;
  n2 = (await svc.createIssue(P, null, { title: 'two' })).number;
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const auth = await import('../src/server/auth.ts');
  token = await auth.createApiToken(u.id, 'mcp');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await mcp.registerMcp(app);
  await app.ready();
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

/** Wywołanie narzędzia przez /mcp (JSON-RPC, odpowiedź JSON). */
async function call(name: string, args: Record<string, unknown>, scopeHeader?: string) {
  const res = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(scopeHeader ? { 'x-exponential-issue': scopeHeader } : {}) },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  return { status: res.statusCode, body: res.body };
}
const isError = (r: { body: string }) => !!JSON.parse(r.body).result?.isError;
const text = (r: { body: string }) => JSON.parse(r.body).result?.content?.[0]?.text as string;

describe('MCP issue scope', () => {
  it('without the header every tool works', async () => {
    expect(isError(await call('list_projects', {}))).toBe(false);
    expect(isError(await call('get_issue', { id: `SC-${n2}` }))).toBe(false);
  });
  it('allows the four tools for the scoped issue', async () => {
    const id = `SC-${n1}`;
    expect(isError(await call('get_issue', { id }, id))).toBe(false);
    expect(isError(await call('list_comments', { id }, id))).toBe(false);
    expect(isError(await call('get_procedure', { name: 'analyze' }, id))).toBe(false);
    expect(isError(await call('set_analysis', { id, type: 'bug', sections: { verdict: 'Yes' } }, id))).toBe(false);
  });
  it('rejects another issue, a bare number and other tools', async () => {
    const id = `SC-${n1}`;
    const other = await call('get_issue', { id: `SC-${n2}` }, id);
    expect(isError(other)).toBe(true);
    expect(text(other)).toContain(id);
    expect(isError(await call('set_analysis', { id: `SC-${n2}`, type: 'bug', sections: { verdict: 'x' } }, id))).toBe(true);
    expect(isError(await call('get_issue', { id: String(n1) }, id))).toBe(true);
    expect(isError(await call('list_projects', {}, id))).toBe(true);
    expect(isError(await call('save_comment', { id, body: 'hi' }, id))).toBe(true);
    expect(isError(await call('save_issue', { id, title: 'renamed' }, id))).toBe(true);
  });
  it('an invalid header is a 400', async () => {
    expect((await call('list_projects', {}, 'nonsense')).status).toBe(400);
  });
});
