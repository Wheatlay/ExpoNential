/**
 * Demo: seed (dane, zgłoszenie #12 bez analizy) i symulacja agenta krok po kroku, bez timerów.
 * Osobna baza tracker_test_demo, tworzona od zera.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_demo';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let seed: typeof import('../src/server/demo/seed.ts');
let sim: typeof import('../src/server/demo/simulate.ts');
let svc: typeof import('../src/server/service.ts');
let pr: typeof import('../src/server/projects.ts');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_demo with (force)');
  await admin.unsafe('create database tracker_test_demo');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  seed = await import('../src/server/demo/seed.ts');
  sim = await import('../src/server/demo/simulate.ts');
  svc = await import('../src/server/service.ts');
  pr = await import('../src/server/projects.ts');
});
afterAll(async () => { await dbmod?.sql.end(); });

const issue = async (key: string, n: number) => {
  const p = (await pr.getProjectByKey(key))!;
  return { p, d: await svc.getIssueDetail(p, n) };
};

describe('demo seed', () => {
  it('creates ACME and MOB with the VAT bug as #12, without analysis', async () => {
    await seed.seedDemo();
    expect(await pr.getProjectByKey('ACME')).toBeTruthy();
    expect(await pr.getProjectByKey('MOB')).toBeTruthy();
    const { d } = await issue('ACME', 12);
    expect(d.title).toBe('Checkout fails for EU VAT numbers');
    expect(d.analysisData).toBeNull();
    expect(d.analysis).toBe('');
    const withAnalysis = (await dbmod.db.select().from(schema.issues)).filter((i) => i.analysisData);
    expect(withAnalysis.length).toBeGreaterThanOrEqual(4);
  });

  it('simulated analyze gives #12 an analysis with two decisions', async () => {
    const { p } = await issue('ACME', 12);
    const [u] = await dbmod.db.select().from(schema.users);
    const demo = (await dbmod.db.select().from(schema.users)).find((x) => x.login === 'demo') ?? u;
    for (const s of sim.steps('analyze', p, 12, demo)) await s.run();
    const { d } = await issue('ACME', 12);
    expect((d.analysisData as { decisions: unknown[] }).decisions).toHaveLength(2);
    expect(d.activity.some((a) => a.viaAi)).toBe(true);
  });

  it('simulated work moves #12 to Testing with deployed commits and change notes', async () => {
    const { p } = await issue('ACME', 12);
    const demo = (await dbmod.db.select().from(schema.users)).find((x) => x.login === 'demo')!;
    for (const s of sim.steps('work', p, 12, demo)) await s.run();
    const { d } = await issue('ACME', 12);
    const meta = await svc.getMeta(p);
    expect(meta.statuses.find((s) => s.id === d.statusId)!.name).toBe('Testing');
    expect(d.commits).toHaveLength(2);
    expect(d.commits.every((c) => c.deployedAt)).toBe(true);
    expect(d.changeHuman).toContain('VAT');
  });

  it('a second seed resets to clean data', async () => {
    await seed.seedDemo();
    const { d } = await issue('ACME', 12);
    expect(d.analysisData).toBeNull();
    expect(d.commits).toHaveLength(0);
  });
});
