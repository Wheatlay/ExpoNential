/**
 * MCP zawężone do jednego zgłoszenia (nagłówek X-Exponential-Issue): tylko get_issue, list_comments, get_procedure, set_analysis,
 * i tylko dla tego zgłoszenia.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_mcpscope';
process.env.UPLOADS_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'mcpscope-'));

let dbmod: typeof import('../src/db/index.ts');
let app: import('fastify').FastifyInstance;
let token: string;
let n1: number, n2: number;
let img: string, otherImg: string;

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
  const up = await import('../src/server/uploads.ts');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  img = up.saveUpload(png, 'png', u.id);
  otherImg = up.saveUpload(png, 'png', u.id);
  n1 = (await svc.createIssue(P, null, { title: 'one', description: `![shot](${img})` })).number;
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

describe('get_attachment', () => {
  it('returns an uploaded image as image content (relative or full URL)', async () => {
    for (const url of [img, `https://tracker.example${img}`]) {
      const c = JSON.parse((await call('get_attachment', { url })).body).result.content[0];
      expect(c.type).toBe('image');
      expect(c.mimeType).toBe('image/png');
    }
  });
  it('rejects paths outside uploads and missing files', async () => {
    expect(isError(await call('get_attachment', { url: '/uploads/../package.json' }))).toBe(true);
    expect(isError(await call('get_attachment', { url: '/uploads/nope.png' }))).toBe(true);
  });
  it('in an issue scope only serves images of that issue', async () => {
    const id = `SC-${n1}`;
    expect(isError(await call('get_attachment', { url: img }, id))).toBe(false);
    expect(isError(await call('get_attachment', { url: otherImg }, id))).toBe(true);
  });
});

describe('MCP extras', () => {
  const res = (r: { body: string }) => JSON.parse(text(r));
  it('list_issues query also searches comments; save_comment edits own comment and appends images; history on request', async () => {
    const id = `SC-${n2}`;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]).toString('base64');
    const c = res(await call('save_comment', { id, body: 'zebra stripes', images: [{ data: png, mimeType: 'image/png' }] }));
    expect(res(await call('list_issues', { project: 'SC', query: 'ZEBRA' })).map((x: { id: string }) => x.id)).toEqual([id]);
    expect(isError(await call('save_comment', { id, body: 'x', images: [{ data: 'aGk=', mimeType: 'image/png' }] }))).toBe(true);
    await call('save_comment', { id, body: 'edited', commentId: c.id });
    const body = res(await call('list_comments', { id }))[0].body as string;
    expect(body).toBe('edited');
    const withHist = res(await call('get_issue', { id, history: true }));
    expect(Array.isArray(withHist.history)).toBe(true);
    expect(res(await call('get_issue', { id })).history).toBeUndefined();
    expect(isError(await call('list_issues', { project: 'SC', sprint: 'current' }))).toBe(true);
  });
});

describe('MCP description limit and set_decision', () => {
  it('save_issue rejects a description over the limit, accepts one at the limit', async () => {
    const { DESCRIPTION_MAX } = await import('../src/server/mcp.ts');
    const long = await call('save_issue', { project: 'SC', title: 'long', description: 'x'.repeat(DESCRIPTION_MAX + 1) });
    expect(isError(long)).toBe(true);
    expect(text(long)).toContain('set_analysis');
    expect(isError(await call('save_issue', { id: `SC-${n2}`, description: 'x'.repeat(DESCRIPTION_MAX) }))).toBe(false);
  });
  it('set_decision picks an option by label, takes an own answer and clears', async () => {
    const r = JSON.parse(text(await call('save_issue', { project: 'SC', title: 'decide' })));
    const id = r.id as string;
    await call('set_analysis', { id, type: 'feature', sections: { current: 'Now' }, decisions: [
      { question: 'Where?', options: [{ label: 'List', recommended: true }, { label: 'Edit form' }] },
    ] });
    expect(isError(await call('set_decision', { id, decision: 2, option: 'List' }))).toBe(true);
    expect(isError(await call('set_decision', { id, decision: 1, option: 'Nope' }))).toBe(true);
    expect(isError(await call('set_decision', { id, decision: 1, option: 'edit form' }))).toBe(false);
    expect(JSON.parse(text(await call('get_issue', { id }))).analysis).toMatch(/Edit form.*✓/);
    await call('set_decision', { id, decision: 1, other: 'Both' });
    expect(JSON.parse(text(await call('get_issue', { id }))).analysis).toContain('Both');
    await call('set_decision', { id, decision: 1 });
    expect(JSON.parse(text(await call('get_issue', { id }))).analysis).not.toContain('Both');
  });
});

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

describe('MCP save_meeting', () => {
  it('schedules a fixed meeting, default length 60 min, and lists it', async () => {
    const r = await call('save_meeting', { title: 'Tests sync', startsAt: '2099-11-12T11:30:00+01:00' });
    expect(isError(r)).toBe(false);
    const m = JSON.parse(text(r));
    expect(new Date(m.startsAt).toISOString()).toBe('2099-11-12T10:30:00.000Z');
    expect(new Date(m.endsAt).toISOString()).toBe('2099-11-12T11:30:00.000Z');
    expect(text(await call('list_meetings', {}))).toContain('Tests sync');
    expect(isError(await call('set_attendance', { meetingId: m.id, answer: 'yes' }))).toBe(false);
    expect(text(await call('list_meetings', {}))).toContain('Dora: yes');
  });
  it('rejects a bad time and an unknown attendee, and is not in the issue scope', async () => {
    expect(isError(await call('save_meeting', { title: 'x', startsAt: 'tomorrow' }))).toBe(true);
    expect(isError(await call('save_meeting', { title: 'x', startsAt: '2099-11-12T11:30:00Z', attendees: ['nobody'] }))).toBe(true);
    expect(isError(await call('save_meeting', { title: 'x', startsAt: '2099-11-12T11:30:00Z' }, `SC-${n1}`))).toBe(true);
  });
});
