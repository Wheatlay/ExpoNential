import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull, sql as dsql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.ts';
import { projectInvites, projectMembers, projects, users } from '../db/schema.ts';
import { RuleError } from './rules.ts';

type Exec = typeof db | Tx;

const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const baseUrl = () => (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

/** Zaproszenie do projektu. Token zwracamy tylko tutaj (w bazie jest sam hash). */
export async function createInvite(actorId: number, projectId: number, role: 'admin' | 'member') {
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5);
  const [row] = await db.insert(projectInvites).values({ kind: 'invite', tokenHash: hashToken(token), projectId, role, createdBy: actorId, expiresAt }).returning();
  return { id: row.id, url: `${baseUrl()}/invite/${token}`, role, expiresAt };
}

const HISTORY_DAYS = 30;
const usedBy = alias(users, 'used_by');

/**
 * Zaproszenia projektu z ostatnich 30 dni (bez tokenu) ze stanem: oczekujące, wygasłe, przyjęte (kto i kiedy).
 * Cofnięte nie są pokazywane: admin cofa je świadomie albo zastępuje nowym linkiem.
 */
export async function listInvites(projectId: number) {
  const rows = await db.select({
    id: projectInvites.id, role: projectInvites.role, createdAt: projectInvites.createdAt, expiresAt: projectInvites.expiresAt,
    usedAt: projectInvites.usedAt, createdByName: users.name, usedByName: usedBy.name,
  })
    .from(projectInvites).leftJoin(users, eq(users.id, projectInvites.createdBy)).leftJoin(usedBy, eq(usedBy.id, projectInvites.usedBy))
    .where(and(eq(projectInvites.projectId, projectId), eq(projectInvites.kind, 'invite'), isNull(projectInvites.revokedAt),
      gt(projectInvites.createdAt, new Date(Date.now() - HISTORY_DAYS * 864e5))))
    .orderBy(desc(projectInvites.createdAt));
  const now = Date.now();
  return rows.map((r) => ({ ...r, status: r.usedAt ? 'accepted' as const : r.expiresAt.getTime() <= now ? 'expired' as const : 'pending' as const }));
}

/** Nowy link w miejsce nieprzyjętego (oczekującego albo wygasłego): ta sama rola, stary cofnięty. */
export async function renewInvite(actorId: number, projectId: number, id: number) {
  const [old] = await db.update(projectInvites).set({ revokedAt: new Date() })
    .where(and(eq(projectInvites.id, id), eq(projectInvites.projectId, projectId), eq(projectInvites.kind, 'invite'), isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt)))
    .returning();
  if (!old) throw new RuleError('Invite not found', 'not_found');
  return createInvite(actorId, projectId, old.role);
}

export async function revokeInvite(projectId: number, id: number) {
  const rows = await db.update(projectInvites).set({ revokedAt: new Date() })
    .where(and(eq(projectInvites.id, id), eq(projectInvites.projectId, projectId), isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt))).returning({ id: projectInvites.id });
  if (!rows.length) throw new RuleError('Invite not found', 'not_found');
}

/** Ważne zaproszenie (nieużyte, nie cofnięte, nie wygasłe): dane do ekranu zaproszenia. Inaczej null. */
export async function inviteInfo(token: string, exec: Exec = db) {
  const [row] = await exec.select({ projectName: projects.name, projectKey: projects.key, role: projectInvites.role })
    .from(projectInvites).innerJoin(projects, eq(projects.id, projectInvites.projectId))
    .where(and(eq(projectInvites.tokenHash, hashToken(token)), eq(projectInvites.kind, 'invite'), isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt), gt(projectInvites.expiresAt, new Date())));
  return row ?? null;
}

/**
 * Zużywa zaproszenie atomowo (jeden UPDATE z warunkami) i dodaje członkostwo; przy równoległych próbach
 * wygrywa jedna. Istniejący admin projektu nie traci roli. Zwraca projekt albo null, gdy zaproszenie nieważne.
 */
export async function consumeInvite(token: string, userId: number, exec: Exec = db) {
  const [inv] = await exec.update(projectInvites).set({ usedAt: new Date(), usedBy: userId })
    .where(and(eq(projectInvites.tokenHash, hashToken(token)), eq(projectInvites.kind, 'invite'), isNotNull(projectInvites.projectId),
      isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt), gt(projectInvites.expiresAt, new Date()))).returning();
  if (!inv?.projectId) return null;
  await exec.insert(projectMembers).values({ projectId: inv.projectId, userId, role: inv.role })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: dsql`case when ${projectMembers.role} = 'admin' then 'admin' else excluded.role end` } });
  const [p] = await exec.select({ key: projects.key, name: projects.name }).from(projects).where(eq(projects.id, inv.projectId));
  return { projectId: inv.projectId, projectKey: p.key, projectName: p.name, role: inv.role };
}

/** Jednorazowy link do zmiany hasła (24 h), tworzy admin globalny. */
export async function createResetLink(actorId: number, userId: number) {
  const [u] = await db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u) throw new RuleError('Account not found', 'not_found');
  // Reset ma sens tylko dla konta z hasłem; konto z GitHubem albo Google loguje się bez niego.
  if (!u.passwordHash) throw new RuleError('This account has no password to reset', 'invalid');
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_HOURS * 36e5);
  await db.insert(projectInvites).values({ kind: 'password_reset', tokenHash: hashToken(token), userId, createdBy: actorId, expiresAt });
  return { url: `${baseUrl()}/reset/${token}`, expiresAt };
}

export async function resetInfo(token: string, exec: Exec = db) {
  const [row] = await exec.select({ userId: users.id, name: users.name }).from(projectInvites).innerJoin(users, eq(users.id, projectInvites.userId))
    .where(and(eq(projectInvites.tokenHash, hashToken(token)), eq(projectInvites.kind, 'password_reset'), eq(users.active, true),
      isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt), gt(projectInvites.expiresAt, new Date())));
  return row ?? null;
}

/** Zużywa link resetu atomowo. Zwraca id konta albo null. */
export async function consumeReset(token: string, exec: Exec = db) {
  const [row] = await exec.update(projectInvites).set({ usedAt: new Date() })
    .where(and(eq(projectInvites.tokenHash, hashToken(token)), eq(projectInvites.kind, 'password_reset'), isNotNull(projectInvites.userId),
      isNull(projectInvites.usedAt), isNull(projectInvites.revokedAt), gt(projectInvites.expiresAt, new Date()))).returning();
  return row?.userId ?? null;
}
