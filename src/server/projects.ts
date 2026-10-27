import { and, asc, eq, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { projectMembers, projects, statuses, users, type StatusType } from '../db/schema.ts';
import { RuleError, isProjectKey } from './rules.ts';

export type Project = typeof projects.$inferSelect;
export type ProjectUser = { id: number; isAdmin: boolean };

const DEFAULT_STATUSES: { name: string; type: StatusType; color: string; hidden?: boolean; role?: 'need_info' | 'testing' }[] = [
  { name: 'Backlog', type: 'backlog', color: '#8a8f98', hidden: true },
  { name: 'Todo', type: 'unstarted', color: '#d4d4d8' },
  { name: 'Paused', type: 'unstarted', color: '#ef4444' },
  { name: 'Need Info', type: 'started', color: '#4cb782', role: 'need_info' },
  { name: 'In Progress', type: 'started', color: '#f2c94c' },
  { name: 'Testing', type: 'started', color: '#5e6ad2', role: 'testing' },
  { name: 'Done', type: 'completed', color: '#5e6ad2' },
  { name: 'Canceled', type: 'canceled', color: '#8a8f98', hidden: true },
  { name: 'Duplicate', type: 'duplicate', color: '#8a8f98', hidden: true },
];

/** Domyślne statusy dla projektu bez statusów (nowy projekt, świeża baza). */
export async function seedProjectStatuses(projectId: number) {
  const [{ count }] = await db.select({ count: dsql<number>`count(*)::int` }).from(statuses).where(eq(statuses.projectId, projectId));
  if (count > 0) return;
  await db.insert(statuses).values(DEFAULT_STATUSES.map((s, i) => ({
    projectId, name: s.name, type: s.type, color: s.color, position: i, hiddenOnBoard: !!s.hidden, role: s.role ?? null,
  })));
}

export async function listAllProjects() {
  return db.select().from(projects).orderBy(asc(projects.id));
}

export async function getProjectByKey(key: string) {
  const [p] = await db.select().from(projects).where(eq(projects.key, key.toUpperCase()));
  return p ?? null;
}

/** Projekty użytkownika z jego rolą. Admin globalny widzi wszystkie (w cudzych ma rolę admina). */
export async function projectsOf(user: ProjectUser) {
  const rows = await db.select({
    project: projects, role: projectMembers.role,
    memberCount: dsql<number>`(select count(*)::int from project_members m where m.project_id = ${projects.id})`,
  })
    .from(projects).leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .where(user.isAdmin ? undefined : dsql`${projectMembers.userId} is not null`).orderBy(asc(projects.id));
  return rows.map((r) => ({ ...r, role: r.role ?? ('admin' as const) }));
}

export async function membership(userId: number, projectId: number) {
  const [m] = await db.select().from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return m ?? null;
}

/**
 * Projekt o danym kluczu, jeśli użytkownik do niego należy (admin globalny: każdy). Bez klucza: pierwszy projekt
 * użytkownika. Nie-członek dostaje "not found" (nie zdradzamy, że projekt istnieje).
 */
export async function requireMember(user: ProjectUser, key: string | null | undefined): Promise<{ project: Project; role: 'admin' | 'member' }> {
  if (key) {
    const p = await getProjectByKey(key);
    const m = p && (await membership(user.id, p.id));
    if (p && !m && user.isAdmin) return { project: p, role: 'admin' };
    if (!p || !m) throw new RuleError(`Project ${key.toUpperCase()} not found`, 'not_found');
    return { project: p, role: m.role };
  }
  const mine = await projectsOf(user);
  const pick = mine[0];
  if (!pick) throw new RuleError('You are not a member of any project', 'not_found');
  return { project: pick.project, role: pick.role };
}

/** Ustawienia projektu zmienia admin projektu albo admin globalny. */
export function canManage(user: ProjectUser, role: 'admin' | 'member') {
  return user.isAdmin || role === 'admin';
}

export async function createProject(creatorId: number, input: { key: string; name: string; color?: string }) {
  const key = input.key.trim().toUpperCase();
  if (!isProjectKey(key)) throw new RuleError('Project key must be 2-6 letters A-Z', 'invalid');
  if (!input.name.trim()) throw new RuleError('Project name cannot be empty', 'invalid');
  if (await getProjectByKey(key)) throw new RuleError(`Project ${key} already exists`, 'invalid');
  const [p] = await db.insert(projects).values({ key, name: input.name.trim(), ...(input.color ? { color: input.color } : {}) }).returning();
  await db.insert(projectMembers).values({ projectId: p.id, userId: creatorId, role: 'admin' });
  await seedProjectStatuses(p.id);
  return p;
}

export type ProjectPatch = Partial<{
  name: string; color: string; discordWebhookUrl: string | null; meetingLocationUrl: string; sprintLengthDays: number; reviewTime: string; reviewMinutes: number;
  promptStart: string; promptAnalyze: string; promptClose: string; promptDeep: string; analyzeModel: string; deepModel: string;
  githubRepo: string; deployBranch: string; deploySource: '' | 'webhook' | 'github' | 'coolify'; deploySourceRef: string; agentTeamQueue: boolean;
}>;

export async function updateProject(projectId: number, patch: ProjectPatch) {
  if (patch.name !== undefined && !patch.name.trim()) throw new RuleError('Project name cannot be empty', 'invalid');
  if (patch.sprintLengthDays !== undefined && (!Number.isInteger(patch.sprintLengthDays) || patch.sprintLengthDays < 1 || patch.sprintLengthDays > 90)) {
    throw new RuleError('Sprint length must be 1-90 days', 'invalid');
  }
  if (patch.reviewTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.reviewTime)) throw new RuleError('Review time must be HH:MM', 'invalid');
  if (patch.reviewMinutes !== undefined && (patch.reviewMinutes < 5 || patch.reviewMinutes > 480)) throw new RuleError('Review length must be 5-480 minutes', 'invalid');
  if (patch.discordWebhookUrl && !/^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com)\/api\/webhooks\//.test(patch.discordWebhookUrl)) {
    throw new RuleError('Discord webhook URL must start with https://discord.com/api/webhooks/', 'invalid');
  }
  if (patch.githubRepo !== undefined) {
    // Wklejony adres (https://github.com/owner/name.git) też przechodzi: zostawiamy samo owner/name.
    patch.githubRepo = patch.githubRepo.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$|\/+$/g, '');
    if (patch.githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(patch.githubRepo)) throw new RuleError('GitHub repo must look like owner/name', 'invalid');
  }
  if (patch.deployBranch !== undefined && !patch.deployBranch.trim()) throw new RuleError('Deploy branch cannot be empty', 'invalid');
  if (patch.deploySourceRef !== undefined) patch.deploySourceRef = patch.deploySourceRef.trim();
  const [p] = await db.update(projects).set({ ...patch, ...(patch.name ? { name: patch.name.trim() } : {}) }).where(eq(projects.id, projectId)).returning();
  return p;
}

export async function listMembers(projectId: number) {
  return db.select({ id: users.id, login: users.login, name: users.name, avatarUrl: users.avatarUrl, active: users.active, role: projectMembers.role })
    .from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId)).orderBy(asc(users.name));
}

/**
 * Dodaje członka po loginie GitHub. Nowe konto (= prawo wejścia do trackera) zakłada tylko admin globalny;
 * admin projektu dodaje osoby, które już mają konto.
 */
export async function addMember(actor: ProjectUser, projectId: number, login: string, role?: 'admin' | 'member') {
  const clean = login.trim().replace(/^@/, '');
  if (!clean) throw new RuleError('Login cannot be empty', 'invalid');
  const [existing] = await db.select().from(users).where(dsql`lower(${users.login}) = lower(${clean})`);
  if (!existing && !actor.isAdmin) throw new RuleError(`${clean} has no tracker account yet; a workspace admin has to allow them first`, 'forbidden');
  const user = existing ?? (await db.insert(users).values({ login: clean, name: clean }).returning())[0];
  const current = await membership(user.id, projectId);
  if (current && role === undefined) return user;
  if (current && current.role === 'admin' && role === 'member') {
    const admins = (await listMembers(projectId)).filter((m) => m.role === 'admin');
    if (admins.length === 1 && admins[0].id === user.id) throw new RuleError('A project needs at least one admin', 'invalid');
  }
  const finalRole = role ?? 'member';
  await db.insert(projectMembers).values({ projectId, userId: user.id, role: finalRole })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: finalRole } });
  return user;
}

export async function removeMember(projectId: number, userId: number) {
  const admins = (await listMembers(projectId)).filter((m) => m.role === 'admin');
  if (admins.length === 1 && admins[0].id === userId) throw new RuleError('A project needs at least one admin', 'invalid');
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
}

/** Konto bez żadnego projektu (nowy admin z ADMIN_LOGINS, logowanie dev) dołącza do najstarszego projektu. */
export async function ensureSomeMembership(userId: number) {
  if ((await projectsOf({ id: userId, isAdmin: false })).length) return;
  const p = (await listAllProjects())[0];
  if (p) await db.insert(projectMembers).values({ projectId: p.id, userId, role: 'member' }).onConflictDoNothing();
}
