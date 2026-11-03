/**
 * Profil: nazwa, zdjęcie (własne vs od dostawcy), logowanie nie nadpisuje własnego zdjęcia, usuwanie konta (anonimizacja).
 * Prawdziwa baza (osobna baza tracker_test_profile).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_profile';

let acc: typeof import('../src/server/account.ts');
let auth: typeof import('../src/server/auth.ts');
let svc: typeof import('../src/server/service.ts');
let pr: typeof import('../src/server/projects.ts');
let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let P: import('../src/server/projects.ts').Project;
let admin: { id: number; login: string; isAdmin: boolean };
let member: { id: number; login: string };

beforeAll(async () => {
  const root = postgres(ADMIN_URL, { onnotice: () => {} });
  await root.unsafe('drop database if exists tracker_test_profile with (force)');
  await root.unsafe('create database tracker_test_profile');
  await root.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  svc = await import('../src/server/service.ts');
  pr = await import('../src/server/projects.ts');
  acc = await import('../src/server/account.ts');
  auth = await import('../src/server/auth.ts');
  const { db } = dbmod;
  [admin] = await db.insert(schema.users).values({ login: 'boss', name: 'Boss', isAdmin: true }).returning();
  P = await pr.createProject(admin.id, { key: 'PRF', name: 'Profile' });
  await svc.seedDefaults();
  [member] = await db.insert(schema.users).values({
    githubId: 4242, login: 'gh-member', name: 'Gh Member', avatarUrl: 'https://avatars.example/gh.png', providerAvatarUrl: 'https://avatars.example/gh.png',
  }).returning();
  await pr.addMember(admin, P.id, member.login, 'member');
});
afterAll(async () => { await dbmod?.sql.end(); });

const row = async (id: number) => (await dbmod.db.select().from(schema.users).where(eq(schema.users.id, id)))[0];

describe('profile', () => {
  it('renames, trims and validates', async () => {
    await acc.updateProfile(member.id, { name: '  Nowa Nazwa ' });
    expect((await row(member.id)).name).toBe('Nowa Nazwa');
    await expect(acc.updateProfile(member.id, { name: '   ' })).rejects.toThrow();
    await expect(acc.updateProfile(member.id, { name: 'x'.repeat(61) })).rejects.toThrow();
  });

  it('custom avatar must be an upload, null falls back to the provider photo', async () => {
    await expect(acc.updateProfile(member.id, { avatar: 'https://evil.example/a.png' })).rejects.toThrow('Use an uploaded image');
    await expect(acc.updateProfile(member.id, { avatar: '/uploads/../x.png' })).rejects.toThrow('Use an uploaded image');
    await acc.updateProfile(member.id, { avatar: '/uploads/abc123.png' });
    let u = await row(member.id);
    expect([u.avatarUrl, u.avatarCustom]).toEqual(['/uploads/abc123.png', true]);
    await acc.updateProfile(member.id, { avatar: null });
    u = await row(member.id);
    expect([u.avatarUrl, u.avatarCustom]).toEqual(['https://avatars.example/gh.png', false]);
  });

  it('GitHub login refreshes the provider photo but keeps a custom one, and never renames', async () => {
    await acc.updateProfile(member.id, { avatar: '/uploads/mine.png' });
    await auth.upsertGithubUser({ id: 4242, login: 'gh-member', name: 'Other Name', avatar_url: 'https://avatars.example/new.png', email: null });
    let u = await row(member.id);
    expect([u.avatarUrl, u.providerAvatarUrl, u.name]).toEqual(['/uploads/mine.png', 'https://avatars.example/new.png', 'Nowa Nazwa']);
    await acc.updateProfile(member.id, { avatar: null });
    expect((await row(member.id)).avatarUrl).toBe('https://avatars.example/new.png');
    await auth.upsertGithubUser({ id: 4242, login: 'gh-member', name: 'x', avatar_url: 'https://avatars.example/newer.png', email: null });
    u = await row(member.id);
    expect(u.avatarUrl).toBe('https://avatars.example/newer.png');
  });
});

describe('project logo', () => {
  it('accepts only uploads or empty', async () => {
    await expect(pr.updateProject(P.id, { logoUrl: 'https://x.example/l.png' })).rejects.toThrow('Use an uploaded image');
    expect((await pr.updateProject(P.id, { logoUrl: '/uploads/logo.png' })).logoUrl).toBe('/uploads/logo.png');
    expect((await pr.updateProject(P.id, { logoUrl: '' })).logoUrl).toBe('');
  });
});

describe('delete account', () => {
  it('needs the login typed', async () => {
    await expect(acc.deleteAccount(member.id, 'nope')).rejects.toThrow('Type your login to confirm');
  });

  it('is refused for the only admin of a project with other members, and for the last workspace admin', async () => {
    await expect(acc.deleteAccount(admin.id, 'boss')).rejects.toThrow('Make someone else admin of Profile first');
    await pr.addMember(admin, P.id, member.login, 'admin');
    await expect(acc.deleteAccount(admin.id, 'boss')).rejects.toThrow('Make someone else a workspace admin first');
    await pr.addMember(admin, P.id, member.login, 'member');
  });

  it('anonymizes a member, kills access and keeps their comment', async () => {
    const { db } = dbmod;
    const issue = await svc.createIssue(P, null, { title: 'Mine' });
    const [iss] = await db.select().from(schema.issues).where(eq(schema.issues.number, issue.number));
    const [c] = await db.insert(schema.comments).values({ issueId: iss.id, authorId: member.id, body: 'hello' }).returning();
    await db.update(schema.issues).set({ assigneeId: member.id }).where(eq(schema.issues.id, iss.id));
    await db.insert(schema.sessions).values({ id: 'sess-del', userId: member.id, expiresAt: new Date(Date.now() + 1e7) });
    await db.insert(schema.apiTokens).values({ userId: member.id, name: 't', tokenHash: 'del-hash' });
    await acc.deleteAccount(member.id, 'gh-member');
    const u = await row(member.id);
    expect([u.name, u.login, u.email, u.githubId, u.avatarUrl, u.active, u.isAdmin]).toEqual(['Deleted user', `deleted-${member.id}`, null, null, null, false, false]);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, member.id))).toEqual([]);
    expect(await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, member.id))).toEqual([]);
    expect((await db.select().from(schema.comments).where(eq(schema.comments.id, c.id)))[0].authorId).toBe(member.id);
    expect((await db.select().from(schema.issues).where(eq(schema.issues.id, iss.id)))[0].assigneeId).toBeNull();
    // Wciąż w meta projektu, więc stare komentarze mają kogo pokazać jako "Deleted user".
    expect((await svc.getMeta(P)).users.find((x) => x.id === member.id)?.name).toBe('Deleted user');
    // GitHub nie wpuści już tego konta (githubId zwolniony, login zmieniony).
    expect(await auth.upsertGithubUser({ id: 4242, login: 'gh-member', name: 'x', avatar_url: 'a', email: null })).toBeNull();
  });
});
