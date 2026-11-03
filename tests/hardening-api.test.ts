/** Utwardzenie: blokady demo przy percent-encoding, uploady (limit, magic bytes), sekret webhooka per projekt, Coolify uuid, linki spotkań, Discord. Baza tracker_test_hard. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_hard';
process.env.DEMO_MODE = '1';
process.env.DEPLOY_WEBHOOK_SECRET = 'root-secret';
delete process.env.DEPLOY_WEBHOOK_LEGACY;
process.env.UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), 'exp-uploads-'));

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let projects: typeof import('../src/server/projects.ts');
let deploys: typeof import('../src/server/deploys.ts');
let hooks: typeof import('../src/server/hooks.ts');
let meetings: typeof import('../src/server/meetings.ts');
let notify: typeof import('../src/server/notify.ts');
let app: FastifyInstance;
let plain: FastifyInstance;
let uid = 0;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_hard with (force)');
  await admin.unsafe('create database tracker_test_hard');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  await (await import('../src/server/service.ts')).seedDefaults();
  schema = await import('../src/db/schema.ts');
  projects = await import('../src/server/projects.ts');
  deploys = await import('../src/server/deploys.ts');
  hooks = await import('../src/server/hooks.ts');
  meetings = await import('../src/server/meetings.ts');
  notify = await import('../src/server/notify.ts');
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'hard-up', name: 'Up' }).returning();
  uid = u.id;
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authVia', null);
  app.addHook('onRequest', async (req) => { req.user = { id: uid, name: 'Up', login: 'hard-up', isAdmin: false }; req.authVia = 'session'; });
  await (await import('../src/server/demo/index.ts')).registerDemo(app);
  app.post('/api/tokens', async () => ({ ok: true }));
  await (await import('../src/server/uploads.ts')).registerUploads(app);
  await app.ready();
  plain = Fastify();
  await hooks.registerHooks(plain);
  await plain.ready();
});
afterAll(async () => { await app?.close(); await plain?.close(); await dbmod?.sql.end(); });

async function newProject(key: string, deploySource: 'webhook' | 'coolify') {
  const [u] = await dbmod.db.insert(schema.users).values({ login: `o-${key}`, name: key }).returning();
  const p = await projects.createProject(u.id, { key, name: key });
  const { eq } = await import('drizzle-orm');
  await dbmod.db.update(schema.projects).set({ deploySource }).where(eq(schema.projects.id, p.id));
  return (await projects.getProjectByKey(p.key))!;
}

describe('demo blocklist', () => {
  it('blocks the plain and the percent-encoded path', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/tokens', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/%74okens', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/%6dcp' })).statusCode).toBe(403);
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe('uploads', () => {
  it('accepts a real PNG', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'image/png' }, payload: PNG });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain(`/uploads/u${uid}-`);
  });
  it('rejects content that does not match the type', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'image/png' }, payload: Buffer.from('<script>alert(1)</script>') });
    expect(res.statusCode).toBe(415);
  });
  it('enforces the demo cap on actual bytes', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 + 10)]);
    // Strumień = brak Content-Length (jak chunked): limit musi zadziałać na faktycznych bajtach.
    const res = await app.inject({ method: 'POST', url: '/api/uploads', headers: { 'content-type': 'image/png' }, payload: Readable.from([big]) });
    expect(res.statusCode).toBe(413);
  });
});

describe('deploy webhook secret', () => {
  it('is derived per project and the global one is rejected', async () => {
    await newProject('HWA', 'webhook');
    expect(hooks.deployWebhookSecret('HWA')).not.toBe(hooks.deployWebhookSecret('HWB'));
    const call = (secret: string) => plain.inject({ method: 'POST', url: '/hooks/deploy', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, payload: JSON.stringify({ project: 'HWA', sha: 'abc' }) });
    expect((await call('root-secret')).statusCode).toBe(401);
    expect((await call(hooks.deployWebhookSecret('HWB')!)).statusCode).toBe(401);
    expect((await call(hooks.deployWebhookSecret('HWA')!)).statusCode).toBe(200);
  });
});

describe('Coolify sourceRef', () => {
  it('must look like a uuid and be unique across projects', async () => {
    const ca = await newProject('HCA', 'coolify');
    const cb = await newProject('HCB', 'coolify');
    await expect(deploys.saveDeployEnvs(ca, [{ name: 'Prod', sourceRef: '../x?y=1', isProduction: true }])).rejects.toThrow();
    await deploys.saveDeployEnvs(ca, [{ name: 'Prod', sourceRef: 'xk0s8cw4kgwsg8kwcoso8ck4', isProduction: true }]);
    await expect(deploys.saveDeployEnvs(cb, [{ name: 'Prod', sourceRef: 'XK0S8CW4KGWSG8KWCOSO8CK4', isProduction: true }])).rejects.toThrow();
  });
});

describe('meeting link and Discord text', () => {
  it('accepts only empty or http(s) links', () => {
    expect(meetings.cleanLocationUrl('')).toBe('');
    expect(meetings.cleanLocationUrl(' https://meet.example.com/a ')).toBe('https://meet.example.com/a');
    expect(() => meetings.cleanLocationUrl('javascript:alert(1)')).toThrow();
    expect(() => meetings.cleanLocationUrl('not a url')).toThrow();
  });
  it('defangs user mentions', () => {
    const out = notify.defangMentions('hi @everyone @here <@123>');
    expect(out).not.toContain('@everyone');
    expect(out).not.toContain('@here');
    expect(out).not.toContain('<@');
  });
});
