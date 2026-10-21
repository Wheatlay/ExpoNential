/**
 * Testy bezpieczeństwa: przejęcie konta po loginie, endpointy push (SSRF), maskowanie sekretów w logach.
 * Osobna baza tracker_test_sec, tworzona od zera.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_sec';

let dbmod: typeof import('../src/db/index.ts');
let auth: typeof import('../src/server/auth.ts');
let schema: typeof import('../src/db/schema.ts');
let notify: typeof import('../src/server/notify.ts');
let rules: typeof import('../src/server/rules.ts');

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_sec with (force)');
  await admin.unsafe('create database tracker_test_sec');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  notify = await import('../src/server/notify.ts');
  rules = await import('../src/server/rules.ts');
});
afterAll(async () => { await dbmod?.sql.end(); });

describe('upsertGithubUser', () => {
  it('does not take over an account already bound to another GitHub id', async () => {
    await dbmod.db.insert(schema.users).values({ login: 'alice', name: 'Alice', githubId: 111 });
    const id = await auth.upsertGithubUser({ id: 222, login: 'alice', name: null, avatar_url: '', email: null });
    expect(id).toBeNull();
  });
  it('binds an account without GitHub id by login', async () => {
    const [bob] = await dbmod.db.insert(schema.users).values({ login: 'bob', name: 'Bob', githubId: null }).returning();
    const id = await auth.upsertGithubUser({ id: 333, login: 'Bob', name: null, avatar_url: '', email: null });
    expect(id).toBe(bob.id);
  });
});

describe('isPushEndpoint', () => {
  it('accepts known push services', () => {
    for (const u of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x']) {
      expect(notify.isPushEndpoint(u)).toBe(true);
    }
  });
  it('rejects everything else', () => {
    for (const u of ['http://fcm.googleapis.com/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.com/x', 'not a url']) {
      expect(notify.isPushEndpoint(u)).toBe(false);
    }
  });
});

describe('maskUrl', () => {
  it('masks secrets', () => {
    expect(rules.maskUrl('/hooks/coolify?secret=abc&x=1')).toBe('/hooks/coolify?secret=***&x=1');
    expect(rules.maskUrl('/calendar/AbCdEf123456789012345.ics')).toBe('/calendar/***');
  });
});
