/** saveDeployEnvs (jedno środowisko produkcyjne) i webhook Coolify bez skonfigurowanego API. Baza tracker_test_dep. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import Fastify from 'fastify';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_dep';
delete process.env.COOLIFY_API_URL;
delete process.env.COOLIFY_API_TOKEN;
process.env.COOLIFY_WEBHOOK_SECRET = 'sekret';

let dbmod: typeof import('../src/db/index.ts');
let deploys: typeof import('../src/server/deploys.ts');
let projects: typeof import('../src/server/projects.ts');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_dep with (force)');
  await admin.unsafe('create database tracker_test_dep');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  await (await import('../src/server/service.ts')).seedDefaults();
  deploys = await import('../src/server/deploys.ts');
  projects = await import('../src/server/projects.ts');
});
afterAll(async () => { await dbmod?.sql.end(); });

async function newProject(key: string) {
  const { users } = await import('../src/db/schema.ts');
  const [u] = await dbmod.db.insert(users).values({ login: `o-${key}`, name: key }).returning();
  const p = await projects.createProject(u.id, { key, name: key });
  return (await projects.getProjectByKey(p.key))!;
}

describe('saveDeployEnvs', () => {
  it('marks the first env as production when none is', async () => {
    const p = await newProject('DEA');
    const envs = await deploys.saveDeployEnvs(p, [{ name: 'Stage', sourceRef: '', isProduction: false }, { name: 'Prod', sourceRef: '', isProduction: false }]);
    expect(envs.filter((e) => e.isProduction).map((e) => e.name)).toEqual(['Stage']);
  });
  it('rejects more than one production env', async () => {
    const p = await newProject('DEB');
    await expect(deploys.saveDeployEnvs(p, [{ name: 'A', sourceRef: '', isProduction: true }, { name: 'B', sourceRef: '', isProduction: true }])).rejects.toThrow(/production/);
  });
  it('allows an empty list', async () => {
    const p = await newProject('DEC');
    expect(await deploys.saveDeployEnvs(p, [])).toEqual([]);
  });
});

describe('Coolify webhook without API configured', () => {
  it('answers 200 and does not call the Coolify API', async () => {
    const p = await newProject('DED');
    await projects.updateProject(p.id, { githubRepo: 'acme/ded' });
    await deploys.ensureDeployEnv((await projects.getProjectByKey('DED'))!, { source: 'coolify', ref: 'uuid-ded-1', name: 'Prod', production: true });
    const { registerCoolify } = await import('../src/server/coolify.ts');
    const app = Fastify();
    await registerCoolify(app);
    const res = await app.inject({ method: 'POST', url: '/hooks/coolify?secret=sekret', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ event: 'deployment_success', app: 'uuid-ded-1' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sha: null });
    await app.close();
  });
});
