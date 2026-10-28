/**
 * Logowanie Google, zaproszenia do projektu, konto e-mail + hasło, reset hasła.
 * Osobna baza tracker_test_auth, tworzona od zera. Trasy przez Fastify.inject, bez prawdziwego Google.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_auth';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let auth: typeof import('../src/server/auth.ts');
let inv: typeof import('../src/server/invites.ts');
let pw: typeof import('../src/server/password.ts');
let pr: typeof import('../src/server/projects.ts');
let svc: typeof import('../src/server/service.ts');
let app: import('fastify').FastifyInstance;
let P: import('../src/server/projects.ts').Project;
let owner: { id: number };
let bearer: (userId: number) => Promise<{ authorization: string }>;
const { eq } = await import('drizzle-orm');

const google = (sub: string, email: string, extra: object = {}) => ({ sub, email, email_verified: true, name: 'G User', ...extra });
const tokenOf = (url: string) => url.split('/').pop()!;

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_auth with (force)');
  await admin.unsafe('create database tracker_test_auth');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  inv = await import('../src/server/invites.ts');
  pw = await import('../src/server/password.ts');
  pr = await import('../src/server/projects.ts');
  svc = await import('../src/server/service.ts');
  await svc.seedDefaults();
  [owner] = await dbmod.db.insert(schema.users).values({ login: 'owner', name: 'Owner', isAdmin: true }).returning();
  P = await pr.createProject(owner.id, { key: 'ACME', name: 'Acme' });
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { registerApi } = await import('../src/server/api.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerApi(app);
  bearer = async (userId) => ({ authorization: `Bearer ${await auth.createApiToken(userId, 't')}` });
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

const newInvite = async (role: 'admin' | 'member' = 'member') => tokenOf((await inv.createInvite(owner.id, P.id, role)).url);
const mkUser = async (login: string, extra: Partial<typeof import('../src/db/schema.ts').users.$inferInsert> = {}) =>
  (await dbmod.db.insert(schema.users).values({ login, name: login, ...extra }).returning())[0];
const roleOf = async (userId: number) => (await pr.membership(userId, P.id))?.role ?? null;

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const h = await pw.hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await pw.verifyPassword('correct horse battery', h)).toBe(true);
    expect(await pw.verifyPassword('wrong horse battery', h)).toBe(false);
    expect(await pw.verifyPassword('x', 'garbage')).toBe(false);
  });
  it('enforces length limits', () => {
    expect(pw.passwordProblem('short')).not.toBeNull();
    expect(pw.passwordProblem('x'.repeat(201))).not.toBeNull();
    expect(pw.passwordProblem('x'.repeat(10))).toBeNull();
  });
  it('limiter blocks after max failures and resets', () => {
    const l = pw.createAttemptLimiter(3, 60_000);
    for (let i = 0; i < 2; i++) l.fail('k');
    expect(l.blocked('k')).toBe(false);
    l.fail('k');
    expect(l.blocked('k')).toBe(true);
    expect(l.blocked('other')).toBe(false);
    l.reset('k');
    expect(l.blocked('k')).toBe(false);
  });
});

describe('upsertGoogleUser', () => {
  it('matches an account added by e-mail, case-insensitively, and binds the Google sub', async () => {
    const u = await mkUser('Mixed@Example.com', { email: 'Mixed@Example.com' });
    const id = await auth.upsertGoogleUser(google('sub-mixed', 'mixed@example.com'));
    expect(id).toBe(u.id);
    const [row] = await dbmod.db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row.googleId).toBe('sub-mixed');
  });
  it('logs in again by sub even when the e-mail changed', async () => {
    const id1 = await auth.upsertGoogleUser(google('sub-mixed', 'mixed@example.com'));
    const id2 = await auth.upsertGoogleUser(google('sub-mixed', 'other-address@example.com'));
    expect(id2).toBe(id1);
  });
  it('refuses a stranger and an unverified e-mail', async () => {
    expect(await auth.upsertGoogleUser(google('sub-x', 'stranger@example.com'))).toBeNull();
    await mkUser('unv', { email: 'unv@example.com' });
    expect(await auth.upsertGoogleUser(google('sub-unv', 'unv@example.com', { email_verified: false }))).toBeNull();
  });
  it('does not hand an account bound to another Google sub to a new one', async () => {
    await mkUser('bound', { email: 'bound@example.com', googleId: 'sub-bound' });
    expect(await auth.upsertGoogleUser(google('sub-evil', 'bound@example.com'))).toBeNull();
  });
  it('refuses an inactive account', async () => {
    await mkUser('gone', { email: 'gone@example.com', active: false });
    expect(await auth.upsertGoogleUser(google('sub-gone', 'gone@example.com'))).toBeNull();
  });
  it('creates an admin for ADMIN_EMAILS', async () => {
    process.env.ADMIN_EMAILS = 'boss@example.com, other@example.com';
    try {
      const id = await auth.upsertGoogleUser(google('sub-boss', 'Boss@Example.com'));
      expect(id).not.toBeNull();
      const [row] = await dbmod.db.select().from(schema.users).where(eq(schema.users.id, id!));
      expect(row.isAdmin).toBe(true);
      expect(await roleOf(id!)).toBe('member');
    } finally { delete process.env.ADMIN_EMAILS; }
  });
  it('creates an account for a valid invite only', async () => {
    const token = await newInvite();
    expect(await auth.upsertGoogleUser(google('sub-inv', 'invited@example.com'), { invite: 'not-a-token' })).toBeNull();
    const id = await auth.upsertGoogleUser(google('sub-inv', 'invited@example.com'), { invite: token });
    expect(id).not.toBeNull();
    const joined = await inv.consumeInvite(token, id!);
    expect(joined?.projectKey).toBe('ACME');
    expect(await roleOf(id!)).toBe('member');
  });
});

describe('project invites', () => {
  it('gives the invited role and rejects a second use', async () => {
    const token = await newInvite('admin');
    const u = await mkUser('invitee1');
    expect((await inv.consumeInvite(token, u.id))?.role).toBe('admin');
    expect(await roleOf(u.id)).toBe('admin');
    const other = await mkUser('invitee2');
    expect(await inv.consumeInvite(token, other.id)).toBeNull();
    expect(await roleOf(other.id)).toBeNull();
  });
  it('rejects expired and revoked invites', async () => {
    const expired = await inv.createInvite(owner.id, P.id, 'member');
    await dbmod.db.update(schema.projectInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.projectInvites.id, expired.id));
    const revoked = await inv.createInvite(owner.id, P.id, 'member');
    await inv.revokeInvite(P.id, revoked.id);
    const u = await mkUser('late');
    expect(await inv.consumeInvite(tokenOf(expired.url), u.id)).toBeNull();
    expect(await inv.consumeInvite(tokenOf(revoked.url), u.id)).toBeNull();
    expect(await inv.inviteInfo(tokenOf(revoked.url))).toBeNull();
  });
  it('lets only one of two parallel consumers win', async () => {
    const token = await newInvite();
    const [a, b] = await Promise.all([mkUser('race-a'), mkUser('race-b')]);
    const res = await Promise.all([inv.consumeInvite(token, a.id), inv.consumeInvite(token, b.id)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect((await roleOf(a.id) ? 1 : 0) + (await roleOf(b.id) ? 1 : 0)).toBe(1);
  });
  it('an existing user joins, and an existing admin keeps the admin role', async () => {
    const u = await mkUser('existing');
    expect((await inv.consumeInvite(await newInvite(), u.id))?.projectKey).toBe('ACME');
    expect(await roleOf(u.id)).toBe('member');
    await inv.consumeInvite(await newInvite('member'), owner.id);
    expect(await roleOf(owner.id)).toBe('admin');
  });
  it('lists invites with status (pending, accepted by whom), without tokens', async () => {
    const used = await inv.createInvite(owner.id, P.id, 'member');
    const lister = await mkUser('lister');
    await inv.consumeInvite(tokenOf(used.url), lister.id);
    const pending = await inv.createInvite(owner.id, P.id, 'member');
    const list = await inv.listInvites(P.id);
    expect(list.find((i) => i.id === pending.id)?.status).toBe('pending');
    const accepted = list.find((i) => i.id === used.id);
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.usedByName).toBe(lister.name);
    expect(JSON.stringify(list)).not.toContain(tokenOf(pending.url));
  });
  it('renew replaces an unaccepted invite: same role, old link dead; accepted cannot be renewed', async () => {
    const old = await inv.createInvite(owner.id, P.id, 'admin');
    const fresh = await inv.renewInvite(owner.id, P.id, old.id);
    expect(fresh.role).toBe('admin');
    expect(await inv.inviteInfo(tokenOf(old.url))).toBeNull();
    expect((await inv.inviteInfo(tokenOf(fresh.url)))?.role).toBe('admin');
    await inv.consumeInvite(tokenOf(fresh.url), (await mkUser('renewed')).id);
    await expect(inv.renewInvite(owner.id, P.id, fresh.id)).rejects.toThrow(/not found/);
  });
});

describe('invite API permissions', () => {
  it('only a project admin can create, list and revoke invites', async () => {
    const member = await mkUser('plain-member');
    await pr.addMember({ id: owner.id, isAdmin: true }, P.id, member.login, 'member');
    const asMember = await bearer(member.id);
    const asOwner = await bearer(owner.id);
    expect((await app.inject({ method: 'POST', url: '/api/projects/ACME/invites', headers: asMember, payload: { role: 'member' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/projects/ACME/invites', headers: asMember })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/projects/ACME/invites', headers: asOwner, payload: { role: 'member' } });
    expect(created.statusCode).toBe(200);
    const { url, id } = created.json();
    expect(url).toMatch(/^http:\/\/localhost:5173\/invite\/.{20,}/);
    expect((await app.inject({ method: 'GET', url: `/api/invites/${tokenOf(url)}` })).json()).toEqual({ projectName: 'Acme', role: 'member' });
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/ACME/invites/${id}`, headers: asMember })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/ACME/invites/${id}`, headers: asOwner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/invites/${tokenOf(url)}` })).statusCode).toBe(404);
  });
  it('a logged-in user accepts an invite once', async () => {
    const u = await mkUser('acceptor');
    const token = await newInvite();
    const h = await bearer(u.id);
    expect((await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: h })).json()).toEqual({ projectKey: 'ACME' });
    expect((await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: h })).statusCode).toBe(404);
  });
});

describe('allowlist by e-mail', () => {
  it('saveUser creates an account from an e-mail and refuses a duplicate', async () => {
    await svc.saveUser(P, { login: 'New.Person@Example.com' });
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.email, 'New.Person@Example.com'));
    expect(u.login).toBe('New.Person@Example.com');
    expect(await roleOf(u.id)).toBe('member');
    await expect(svc.saveUser(P, { login: 'new.person@example.com' })).rejects.toThrow(/already has an account/);
  });
  it('addMember takes an e-mail, reuses the account found by e-mail, and a Google login then matches it', async () => {
    const admin = { id: owner.id, isAdmin: true };
    const u = await pr.addMember(admin, P.id, 'Added@Example.com');
    expect(u.email).toBe('Added@Example.com');
    const again = await pr.addMember(admin, P.id, 'added@example.com', 'admin');
    expect(again.id).toBe(u.id);
    expect(await roleOf(u.id)).toBe('admin');
    expect(await auth.upsertGoogleUser(google('sub-added', 'added@example.com'))).toBe(u.id);
  });
  it('a project admin who is not a workspace admin cannot create accounts by e-mail', async () => {
    await expect(pr.addMember({ id: owner.id, isAdmin: false }, P.id, 'nobody@example.com')).rejects.toThrow(/no tracker account/);
  });
});

describe('e-mail and password', () => {
  const login = (email: string, password: string, ip = '10.0.0.1') =>
    app.inject({ method: 'POST', url: '/auth/password', payload: { email, password }, remoteAddress: ip });

  it('logs in with the right password and gives one error for every failure', async () => {
    await dbmod.db.insert(schema.users).values({ login: 'pw1', name: 'Pw', email: 'pw1@example.com', passwordHash: await pw.hashPassword('right-password-1') });
    await dbmod.db.insert(schema.users).values({ login: 'nopw', name: 'NoPw', email: 'nopw@example.com' });
    await dbmod.db.insert(schema.users).values({ login: 'off', name: 'Off', email: 'off@example.com', active: false, passwordHash: await pw.hashPassword('right-password-1') });
    const ok = await login('PW1@example.com', 'right-password-1');
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toContain('tracker_session=');
    const bodies = [
      await login('pw1@example.com', 'wrong-password-1'),
      await login('missing@example.com', 'right-password-1'),
      await login('nopw@example.com', 'right-password-1'),
      await login('off@example.com', 'right-password-1'),
    ];
    for (const r of bodies) { expect(r.statusCode).toBe(401); expect(r.json()).toEqual({ error: 'Wrong e-mail or password' }); }
  });
  it('limits failed attempts per IP and e-mail', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login('limited@example.com', 'whatever-123', '10.0.0.9')).statusCode;
    expect(last).toBe(429);
    // Inny e-mail i inny adres nie są zablokowane.
    expect((await login('limited2@example.com', 'whatever-123', '10.0.0.9')).statusCode).toBe(401);
    expect((await login('limited@example.com', 'whatever-123', '10.0.0.10')).statusCode).toBe(401);
  });
  it('registers only with a valid invite, and consumes it', async () => {
    const reg = (token: string, email: string) => app.inject({ method: 'POST', url: `/auth/invite/${token}/register`, payload: { name: 'New', email, password: 'a-long-password' } });
    expect((await reg('bogus', 'reg@example.com')).statusCode).toBe(404);
    expect((await dbmod.db.select().from(schema.users).where(eq(schema.users.email, 'reg@example.com'))).length).toBe(0);
    const token = await newInvite();
    const r = await reg(token, 'reg@example.com');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ projectKey: 'ACME' });
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.email, 'reg@example.com'));
    expect(await roleOf(u.id)).toBe('member');
    expect((await login('reg@example.com', 'a-long-password')).statusCode).toBe(200);
    expect((await reg(token, 'reg2@example.com')).statusCode).toBe(404);
  });
  it('rejects a taken e-mail without burning the invite, and a short password', async () => {
    const token = await newInvite();
    const taken = await app.inject({ method: 'POST', url: `/auth/invite/${token}/register`, payload: { name: 'X', email: 'REG@example.com', password: 'a-long-password' } });
    expect(taken.statusCode).toBe(409);
    expect(await inv.inviteInfo(token)).not.toBeNull();
    const short = await app.inject({ method: 'POST', url: `/auth/invite/${token}/register`, payload: { name: 'X', email: 'short@example.com', password: 'short' } });
    expect(short.statusCode).toBe(422);
    expect(await inv.inviteInfo(token)).not.toBeNull();
  });
  it('reset link sets a new password, kills every session and works once', async () => {
    const u = await mkUser('resetme', { email: 'resetme@example.com', passwordHash: await pw.hashPassword('old-password-1') });
    await auth.createApiToken(u.id, 'keep');
    await dbmod.db.insert(schema.sessions).values([
      { id: 's1', userId: u.id, expiresAt: new Date(Date.now() + 1e6) }, { id: 's2', userId: u.id, expiresAt: new Date(Date.now() + 1e6) },
    ]);
    const asAdmin = await bearer(owner.id);
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/reset-link`, headers: await bearer(u.id) })).statusCode).toBe(403);
    const link = (await app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/reset-link`, headers: asAdmin })).json();
    const token = tokenOf(link.url);
    expect(link.url).toContain('/reset/');
    expect((await app.inject({ method: 'GET', url: `/api/reset/${token}` })).json()).toEqual({ name: 'resetme' });
    const done = await app.inject({ method: 'POST', url: `/auth/reset/${token}`, payload: { password: 'new-password-123' } });
    expect(done.statusCode).toBe(200);
    // Zostaje tylko sesja założona przez sam reset.
    const left = await dbmod.db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.id));
    expect(left.map((s) => s.id)).not.toContain('s1');
    expect(left.map((s) => s.id)).not.toContain('s2');
    expect(left).toHaveLength(1);
    expect((await login('resetme@example.com', 'old-password-1')).statusCode).toBe(401);
    expect((await login('resetme@example.com', 'new-password-123')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/auth/reset/${token}`, payload: { password: 'another-password-1' } })).statusCode).toBe(404);
  });
  it('no reset link for an account without a password', async () => {
    const u = await mkUser('oauth-only');
    expect((await app.inject({ method: 'POST', url: `/api/admin/users/${u.id}/reset-link`, headers: await bearer(owner.id) })).statusCode).toBe(422);
  });
  it('workspace "Allow" creates only the account, without project membership', async () => {
    const asAdmin = await bearer(owner.id);
    const res = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { ...asAdmin, 'x-project': 'ACME' }, payload: { login: 'Only.Account@Example.com' } });
    expect(res.statusCode).toBe(200);
    const [u] = await dbmod.db.select().from(schema.users).where(eq(schema.users.login, 'Only.Account@Example.com'));
    expect(await roleOf(u.id)).toBeNull();
  });
  it('changing your own password needs the current one when set', async () => {
    const u = await mkUser('changer', { email: 'changer@example.com', passwordHash: await pw.hashPassword('current-password') });
    const h = await bearer(u.id);
    const bad = await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: 'nope-nope-nope', password: 'brand-new-password' } });
    expect(bad.statusCode).toBe(422);
    const ok = await app.inject({ method: 'POST', url: '/api/me/password', headers: h, payload: { current: 'current-password', password: 'brand-new-password' } });
    expect(ok.statusCode).toBe(200);
    expect((await login('changer@example.com', 'brand-new-password', '10.0.1.1')).statusCode).toBe(200);
    // Konto bez hasła ustawia je bez podawania obecnego.
    const g = await mkUser('nopass', { email: 'nopass@example.com' });
    const first = await app.inject({ method: 'POST', url: '/api/me/password', headers: await bearer(g.id), payload: { password: 'first-password-1' } });
    expect(first.statusCode).toBe(200);
  });
});
