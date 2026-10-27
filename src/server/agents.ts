import { and, asc, eq, gt, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agentJobs, agents, issues, projectMembers, projects, statuses, users } from '../db/schema.ts';
import { RuleError, identifier } from './rules.ts';
import { analysisModel } from './prompts.ts';
import { log, publish, requireIssue, updateIssue, type Actor, type Project } from './service.ts';

// Agent na PC zgłasza się co kilkanaście sekund; claim analizy wygasa po 30 min (tyle co lock w tracker-handler.ps1).
export const CLAIM_TTL_MIN = 30;
export const ONLINE_MS = 90_000;
export const START_JOB_TTL_MIN = 60;
export const LOCAL_RESERVE_S = 60;

type User = { id: number };

/** Urządzenie musi istnieć (install.ps1 zgłasza je pierwszym heartbeatem) i należeć do wołającego. */
export async function requireOwnAgent(user: User, deviceId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, deviceId));
  if (!row) throw new RuleError('Unknown device, run the install command again', 'invalid');
  if (row.userId !== user.id) throw new RuleError('Device belongs to someone else', 'forbidden');
  return row;
}

/**
 * Przejęcie zlecenia analizy przed uruchomieniem. Jeden UPDATE z warunkami w WHERE daje wyłączność:
 * z dwóch równoczesnych wywołań wygra jedno, drugie dostaje 409. To samo urządzenie może przejąć ponownie (idempotentnie).
 */
export async function claimAnalysis(p: Project, user: User & { name: string }, number: number, deviceId: string) {
  const agent = await requireOwnAgent(user, deviceId);
  const [cur] = await db.select().from(issues).where(and(eq(issues.projectId, p.id), eq(issues.number, number)));
  if (!cur) throw new RuleError(`Issue ${identifier(p.key, number)} not found`, 'not_found');
  const already = cur.analysisClaimedDevice === deviceId && cur.analysisClaimedAt != null;
  const rows = await db.update(issues).set({ analysisClaimedAt: new Date(), analysisClaimedBy: user.id, analysisClaimedDevice: deviceId })
    .where(and(
      eq(issues.id, cur.id),
      dsql`${issues.analysisRequestedAt} is not null`,
      dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}) or ${issues.analysisClaimedDevice} = ${deviceId})`,
      dsql`(${issues.analysisRequestedBy} = ${user.id} or (${p.agentTeamQueue}::boolean and (${issues.analysisLocalUntil} is null or ${issues.analysisLocalUntil} < now())))`,
    ))
    .returning({ deep: issues.analysisDeep });
  if (!rows.length) throw new RuleError('Already taken or no longer requested', 'conflict');
  if (!already) {
    await db.transaction((tx) => log(tx, cur.id, user as Actor, { kind: 'analysis_claimed', device: agent.name }));
    await publish({ type: 'issue', projectKey: p.key, number });
  }
  return { ok: true, deep: rows[0].deep, model: analysisModel(p, rows[0].deep) };
}

/** Oddanie zlecenia po nieudanym uruchomieniu: tylko to urządzenie, które je przejęło. Brak zmian to nie błąd. */
export async function releaseClaim(p: Project, user: User, number: number, deviceId: string) {
  const rows = await db.update(issues).set({ analysisClaimedAt: null, analysisClaimedBy: null, analysisClaimedDevice: null })
    .where(and(eq(issues.projectId, p.id), eq(issues.number, number), eq(issues.analysisClaimedDevice, deviceId), eq(issues.analysisClaimedBy, user.id)))
    .returning({ id: issues.id });
  if (rows.length) await publish({ type: 'issue', projectKey: p.key, number });
  return { ok: true };
}

/** Dla szczegółu zgłoszenia: czy jakiś komputer online może to zlecenie wziąć i na którym ono biegnie. */
export async function analysisRunner(p: Project, issue: { analysisRequestedBy: number | null; analysisClaimedDevice: string | null }) {
  const [r] = await db.execute<{ can: boolean }>(dsql`
    select exists (
      select 1 from agents a
      where a.last_seen_at > now() - make_interval(secs => ${ONLINE_MS / 1000})
        and (a.user_id = ${issue.analysisRequestedBy}::int
          or (${p.agentTeamQueue}::boolean and exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id)))
    ) as can`);
  let claimedDeviceName: string | null = null;
  if (issue.analysisClaimedDevice) {
    const [a] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, issue.analysisClaimedDevice));
    claimedDeviceName = a?.name || null;
  }
  return { canRun: !!r?.can, claimedDeviceName };
}

const ago = (ms: number) => new Date(Date.now() - ms);
const isOnline = (lastSeenAt: Date | null) => !!lastSeenAt && lastSeenAt.getTime() > Date.now() - ONLINE_MS;

/**
 * Sygnał życia agenta (też rejestracja nowego urządzenia). Urządzenie jednego użytkownika nie może przejąć cudze id.
 * Gdy agent jest zajęty, odświeżamy claim jego analizy: długi przebieg Deep nie wraca do kolejki ani nie wygląda na zawieszony.
 */
export async function heartbeat(user: User, deviceId: string, info: { name: string; busy: boolean; repoKeys: string[] }) {
  const [existing] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, deviceId));
  if (existing && existing.userId !== user.id) throw new RuleError('Device belongs to someone else', 'forbidden');
  const repoKeys = [...new Set(info.repoKeys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z]{2,10}$/.test(k)))].slice(0, 50);
  const values = { name: info.name.trim().slice(0, 100), busy: info.busy, repoKeys, lastSeenAt: new Date() };
  const [row] = await db.insert(agents).values({ id: deviceId, userId: user.id, ...values })
    .onConflictDoUpdate({ target: agents.id, set: values }).returning();
  if (info.busy) {
    await db.update(issues).set({ analysisClaimedAt: new Date() })
      .where(and(eq(issues.analysisClaimedDevice, deviceId), dsql`${issues.analysisRequestedAt} is not null`));
  }
  return row;
}

export type AgentJob = { kind: 'analyze'; key: string; deep: boolean } | { kind: 'start'; id: number; key: string };

/** Co ten agent może teraz wziąć: moje zlecenia (i kolejka zespołu w projektach z włączonym przełącznikiem) oraz zlecenia Start. */
export async function pendingWork(user: User, agent: { busy: boolean; repoKeys: string[] }): Promise<AgentJob[]> {
  if (agent.busy) return [];
  const jobs: AgentJob[] = [];
  if (agent.repoKeys.length) {
    const rows = await db.select({ key: projects.key, number: issues.number, deep: issues.analysisDeep })
      .from(issues).innerJoin(projects, eq(projects.id, issues.projectId))
      .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
      .where(and(
        dsql`${issues.analysisRequestedAt} is not null`,
        dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}))`,
        inArray(projects.key, agent.repoKeys),
        dsql`(${issues.analysisRequestedBy} = ${user.id} or (${projects.agentTeamQueue} and (${issues.analysisLocalUntil} is null or ${issues.analysisLocalUntil} < now())))`,
      ))
      .orderBy(asc(issues.analysisRequestedAt)).limit(5);
    for (const r of rows) jobs.push({ kind: 'analyze', key: identifier(r.key, r.number), deep: r.deep });
  }
  const starts = await db.select({ id: agentJobs.id, key: projects.key, number: issues.number })
    .from(agentJobs).innerJoin(issues, eq(issues.id, agentJobs.issueId)).innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(agentJobs.userId, user.id), eq(agentJobs.kind, 'start'), isNull(agentJobs.claimedAt), gt(agentJobs.createdAt, ago(START_JOB_TTL_MIN * 60_000))))
    .orderBy(asc(agentJobs.createdAt));
  for (const s of starts) jobs.push({ kind: 'start', id: s.id, key: identifier(s.key, s.number) });
  return jobs;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done);
});

/** Long poll agenta: jeden heartbeat na żądanie, potem do 25 s sprawdzamy co 2 s, czy jest praca. */
export async function waitForWork(user: User, deviceId: string, info: { name: string; busy: boolean; repoKeys: string[] }, signal: AbortSignal) {
  const agent = await heartbeat(user, deviceId, info);
  const until = Date.now() + 25_000;
  for (;;) {
    const jobs = await pendingWork(user, agent);
    if (jobs.length || signal.aborted || Date.now() >= until) return { jobs };
    await sleep(2000, signal);
  }
}

/** Przejęcie zlecenia Start przez urządzenie; zlecenie wygasa po godzinie (PC włączony rano nie otwiera wczorajszego zadania). */
export async function claimStartJob(user: User, jobId: number, deviceId: string) {
  await requireOwnAgent(user, deviceId);
  const [job] = await db.update(agentJobs).set({ claimedAt: new Date(), claimedDevice: deviceId })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.userId, user.id), isNull(agentJobs.claimedAt), gt(agentJobs.createdAt, ago(START_JOB_TTL_MIN * 60_000))))
    .returning({ issueId: agentJobs.issueId });
  if (!job) throw new RuleError('Already taken or expired', 'conflict');
  const [r] = await db.select({ key: projects.key, number: issues.number }).from(issues).innerJoin(projects, eq(projects.id, issues.projectId)).where(eq(issues.id, job.issueId));
  return { key: identifier(r.key, r.number) };
}

/** Moje komputery do Ustawień. */
export async function myAgents(user: User) {
  const rows = await db.select().from(agents).where(eq(agents.userId, user.id)).orderBy(dsql`${agents.lastSeenAt} desc nulls last`);
  return rows.map((a) => ({ id: a.id, name: a.name, lastSeenAt: a.lastSeenAt, busy: a.busy, online: isOnline(a.lastSeenAt) }));
}

export async function removeAgent(user: User, id: string) {
  await db.delete(agents).where(and(eq(agents.id, id), eq(agents.userId, user.id)));
  return { ok: true };
}

/** Komputery online należące do członków projektu (kolejka zespołu). */
export async function projectAgents(p: Project) {
  const rows = await db.select({ name: agents.name, owner: users.name, busy: agents.busy })
    .from(agents).innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(projectMembers, and(eq(projectMembers.userId, agents.userId), eq(projectMembers.projectId, p.id)))
    .where(gt(agents.lastSeenAt, ago(ONLINE_MS))).orderBy(asc(agents.name));
  return rows;
}

/**
 * "Start on my PC" z telefonu: zlecenie dla agenta (otworzy VS Code z poleceniem) plus to samo przypisanie i przesunięcie
 * do In Progress, co robi startWork() w aplikacji, bo na telefonie nikt tego nie zrobi po stronie przeglądarki.
 */
export async function createStartJob(p: Project, user: NonNullable<Actor>, number: number) {
  const mine = await myAgents(user);
  if (!mine.some((a) => a.online)) throw new RuleError('Your PC is offline', 'invalid');
  const cur = await requireIssue(p, number);
  const [job] = await db.insert(agentJobs).values({ userId: user.id, issueId: cur.id, kind: 'start' }).returning({ id: agentJobs.id });
  const sts = await db.select().from(statuses).where(eq(statuses.projectId, p.id)).orderBy(asc(statuses.position));
  const now = sts.find((s) => s.id === cur.statusId);
  const inProgress = sts.find((s) => s.type === 'started' && /progress/i.test(s.name)) ?? sts.find((s) => s.type === 'started');
  const patch: { statusId?: number; assigneeId?: number } = {};
  if (inProgress && now && (now.type === 'backlog' || now.type === 'unstarted')) patch.statusId = inProgress.id;
  if (cur.assigneeId == null) patch.assigneeId = user.id;
  if (Object.keys(patch).length) await updateIssue(p, user, number, patch);
  return { ok: true, id: job.id };
}
