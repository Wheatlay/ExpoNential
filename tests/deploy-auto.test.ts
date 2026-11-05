/** Deploye wykrywane automatycznie: GitHub, webhook, Coolify (odkrywanie aplikacji). Baza tracker_test_auto. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_auto';
process.env.COOLIFY_API_URL = 'http://coolify.test';
process.env.COOLIFY_API_TOKEN = 'tok';

let dbmod: typeof import('../src/db/index.ts');
let svc: typeof import('../src/server/service.ts');
let hooks: typeof import('../src/server/hooks.ts');
let deploys: typeof import('../src/server/deploys.ts');
let projects: typeof import('../src/server/projects.ts');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_auto with (force)');
  await admin.unsafe('create database tracker_test_auto');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  svc = await import('../src/server/service.ts');
  await svc.seedDefaults();
  hooks = await import('../src/server/hooks.ts');
  deploys = await import('../src/server/deploys.ts');
  projects = await import('../src/server/projects.ts');
});
afterAll(async () => { vi.unstubAllGlobals(); await dbmod?.sql.end(); });

async function newProject(key: string, repo: string) {
  const { users } = await import('../src/db/schema.ts');
  const [u] = await dbmod.db.insert(users).values({ login: `o-${key}`, name: key }).returning();
  const p = await projects.createProject(u.id, { key, name: key });
  await projects.updateProject(p.id, { githubRepo: repo });
  return (await projects.getProjectByKey(key))!;
}

const ghEvent = (repo: string, sha: string, environment?: string) => ({
  deployment_status: { state: 'success' }, deployment: { sha, ...(environment ? { environment } : {}) }, repository: { full_name: repo },
});

describe('GitHub deployments', () => {
  it('create the Production env from the first event and mark the commit as deployed', async () => {
    const { issueCommits } = await import('../src/db/schema.ts');
    const { eq } = await import('drizzle-orm');
    const p = await newProject('AUA', 'acme/aua');
    const i = await svc.createIssue(p, null, { title: 'auto' });
    await hooks.recordCommits([{ id: 'aua0001', message: `fix AUA-${i.number}`, url: 'https://x', timestamp: new Date().toISOString(), author: { name: 'K' } }], 'acme/aua');
    expect(await deploys.listDeployEnvs(p.id)).toEqual([]);
    expect(await hooks.reportGithubDeployment(ghEvent('Acme/AUA', 'aua0001'))).toEqual(['AUA']);
    const envs = await deploys.listDeployEnvs(p.id);
    expect(envs.map((e) => [e.name, e.source, e.sourceRef, e.isProduction])).toEqual([['Production', 'github', 'production', true]]);
    const [row] = await dbmod.db.select().from(issueCommits).where(eq(issueCommits.sha, 'aua0001'));
    expect(row.deployedAt).toBeInstanceOf(Date);
  });

  it('a second environment is created as non-production', async () => {
    const p = await newProject('AUB', 'acme/aub');
    await hooks.reportGithubDeployment(ghEvent('acme/aub', 'aub0001', 'production'));
    await hooks.reportGithubDeployment(ghEvent('acme/aub', 'aub0002', 'staging'));
    const envs = await deploys.listDeployEnvs(p.id);
    expect(envs.map((e) => [e.name, e.isProduction])).toEqual([['Production', true], ['Staging', false]]);
  });

  it('a removed environment is not created again', async () => {
    const p = await newProject('AUC', 'acme/auc');
    await hooks.reportGithubDeployment(ghEvent('acme/auc', 'auc0001', 'production'));
    await hooks.reportGithubDeployment(ghEvent('acme/auc', 'auc0002', 'staging'));
    const [prod, stage] = await deploys.listDeployEnvs(p.id);
    await deploys.saveDeployEnvs(p, [prod]);
    expect((await projects.getProjectByKey('AUC'))!.deployIgnored).toEqual(['github:staging']);
    expect(await hooks.reportGithubDeployment(ghEvent('acme/auc', 'auc0003', 'staging'))).toEqual([]);
    expect((await deploys.listDeployEnvs(p.id)).map((e) => e.id)).toEqual([prod.id]);
    expect(stage.source).toBe('github');
  });
});

describe('generic webhook', () => {
  it('works without any deploy source and creates Production from the first event', async () => {
    const p = await newProject('AUD', 'acme/aud');
    expect((await hooks.reportDeployHook({ project: 'AUD', sha: 'aud0001', status: 'finished' })).code).toBe(200);
    expect((await deploys.listDeployEnvs(p.id)).map((e) => [e.name, e.source, e.isProduction])).toEqual([['Production', 'webhook', true]]);
    expect((await hooks.reportDeployHook({ project: 'AUD', sha: 'aud0002', status: 'finished', env: 'EU' })).code).toBe(200);
    expect((await deploys.listDeployEnvs(p.id)).map((e) => e.name)).toEqual(['Production', 'EU']);
  });
});

describe('Coolify discovery', () => {
  it('creates envs from apps built from the project repo and skips a uuid used by another project', async () => {
    const a = await newProject('AUE', 'acme/aue');
    const b = await newProject('AUF', 'acme/auf');
    await deploys.ensureDeployEnv(b, { source: 'coolify', ref: 'uuidtaken0000001', name: 'Prod', production: true });
    const apps = [
      { uuid: 'uuidaue00000001', name: 'aue-prod', git_repository: 'https://github.com/Acme/AUE.git', git_branch: 'main' },
      { uuid: 'uuidaue00000002', name: 'aue-stage', git_repository: 'git@github.com:acme/aue', git_branch: 'develop' },
      { uuid: 'uuidtaken0000001', name: 'shared', git_repository: 'acme/aue', git_branch: 'main' },
      { uuid: 'uuidother0000001', name: 'other', git_repository: 'https://github.com/acme/other', git_branch: 'main' },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(apps), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { discoverCoolifyApps } = await import('../src/server/coolify.ts');
    await discoverCoolifyApps({ warn: () => {} } as never);
    expect(fetchMock).toHaveBeenCalledWith('http://coolify.test/api/v1/applications', expect.anything());
    const envs = await deploys.listDeployEnvs(a.id);
    expect(envs.map((e) => [e.name, e.source, e.sourceRef, e.isProduction])).toEqual([
      ['aue-prod', 'coolify', 'uuidaue00000001', true], ['aue-stage', 'coolify', 'uuidaue00000002', false],
    ]);
    expect((await deploys.listDeployEnvs(b.id)).map((e) => e.sourceRef)).toEqual(['uuidtaken0000001']);
    // Drugi przebieg niczego nie dubluje.
    await discoverCoolifyApps({ warn: () => {} } as never);
    expect((await deploys.listDeployEnvs(a.id)).length).toBe(2);
    vi.unstubAllGlobals();
  });
});
