import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, gt, inArray, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { activity, agentJobs, agentRepos, agents, apiTokens, issues, oauthClients, oauthGrants, projectMembers, projects, statuses, users } from '../db/schema.ts';
import { RuleError, identifier } from './rules.ts';
import { analysisModel } from './prompts.ts';
import { log, publish, requireIssue, updateIssue, type Actor, type Project } from './service.ts';

// Agent na PC zgłasza się co kilkanaście sekund; claim analizy wygasa po 30 min (tyle co lock w tracker-handler.ps1).
export const CLAIM_TTL_MIN = 30;
export const ONLINE_MS = 90_000;
export const START_JOB_TTL_MIN = 60;
export const LOCAL_RESERVE_S = 60;

type User = { id: number };

/**
 * Wersja skryptów PC = skrót ich treści na serwerze. Bez samoaktualizacji (kod z serwera nie podmienia się po cichu na PC
 * całego zespołu): agent zgłasza swoją wersję, a Ustawienia pokazują, że trzeba ponownie uruchomić instalację.
 */
export const AGENT_SCRIPTS = ['tracker-agent.ps1', 'tracker-handler.ps1'];
let scriptsVersion: string | null = null;
export function agentScriptsVersion() {
  scriptsVersion ??= createHash('sha256')
    .update(AGENT_SCRIPTS.map((f) => readFileSync(path.join(process.cwd(), 'scripts/local-agent', f), 'utf8')).join('\n'))
    .digest('hex').slice(0, 12);
  return scriptsVersion;
}

/** Najstarszy agent z agent/ (exponential-agent.exe, wersja semver), który jeszcze dostaje pracę. */
export const MIN_EXE_AGENT = '0.1.0';
const semver = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
/** Aktualny agent: skrypty PS w wersji z serwera albo agent .exe nie starszy niż MIN_EXE_AGENT. */
export function agentUpToDate(version: string | null | undefined) {
  if (!version) return false;
  if (version === agentScriptsVersion()) return true;
  const v = semver(version), min = semver(MIN_EXE_AGENT)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

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
export async function claimAnalysis(p: Project, user: User & { name: string }, number: number, deviceId: string, version?: string) {
  // Kliknięcie w przeglądarce może odpalić handler, zanim agent w tle zdąży się pierwszy raz zgłosić: wtedy rejestrujemy
  // urządzenie tutaj (należy do właściciela tokenu), zamiast wywracać analizę na "Unknown device".
  await db.insert(agents).values({ id: deviceId, userId: user.id }).onConflictDoNothing();
  const agent = await requireOwnAgent(user, deviceId);
  // Handler podaje swoją wersję: świeżo zaktualizowany PC nie czeka na pierwszy sygnał agenta.
  if (version !== undefined && version !== agent.version) {
    await db.update(agents).set({ version: version.slice(0, 40) }).where(eq(agents.id, deviceId));
    agent.version = version;
  }
  // Stare skrypty nie dostają pracy: poprawki (np. blokada .env) działają dopiero po aktualizacji, więc nie puszczamy ich bez niej.
  if (!agentUpToDate(agent.version)) throw new RuleError('PC scripts are outdated: run the install command again (Settings > Claude Code)', 'outdated');
  // Analizę bierze tylko komputer z działającym repo projektu (chyba że projekt pozwala agentom klonować).
  if (!p.agentsMayClone) {
    const [m] = await db.select({ s: agentRepos.status }).from(agentRepos).where(and(eq(agentRepos.agentId, deviceId), eq(agentRepos.projectId, p.id)));
    if (m?.s !== 'ok') throw new RuleError(`This PC has no repo for ${p.key}`, 'conflict');
  }
  const [cur] = await db.select().from(issues).where(and(eq(issues.projectId, p.id), eq(issues.number, number)));
  if (!cur) throw new RuleError(`Issue ${identifier(p.key, number)} not found`, 'not_found');
  const already = cur.analysisClaimedDevice === deviceId && cur.analysisClaimedAt != null;
  const rows = await db.update(issues).set({ analysisClaimedAt: new Date(), analysisClaimedBy: user.id, analysisClaimedDevice: deviceId })
    .where(and(
      eq(issues.id, cur.id),
      dsql`${issues.analysisRequestedAt} is not null`,
      isNull(issues.analysisFailedAt),
      dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}) or ${issues.analysisClaimedDevice} = ${deviceId})`,
      dsql`(${issues.analysisRequestedBy} = ${user.id} or (${p.agentTeamQueue}::boolean and (${issues.analysisLocalUntil} is null or ${issues.analysisLocalUntil} < now())))`,
    ))
    .returning({ deep: issues.analysisDeep });
  if (!rows.length) throw new RuleError('Already taken or no longer requested', 'conflict');
  if (!already) {
    // Zajęcie robi skrypt na PC, nie człowiek: w aktywności ze znacznikiem AI, jak inne akcje agenta.
    await db.transaction((tx) => log(tx, cur.id, { ...user, ai: true } as Actor, { kind: 'analysis_claimed', device: agent.label || agent.name || 'PC' }));
    await publish({ type: 'issue', projectKey: p.key, number });
  }
  return { ok: true, deep: rows[0].deep, model: analysisModel(p, rows[0].deep) };
}

/**
 * Oddanie zlecenia przez urządzenie, które je przejęło. Z błędem: zlecenie zostaje oznaczone jako nieudane i nie wraca
 * samo do kolejki (inaczej trwały błąd powtarzałby się co kilka sekund). Brak zmian to nie błąd.
 */
export async function releaseClaim(p: Project, user: User, number: number, deviceId: string, error?: string) {
  const failed = error !== undefined ? { analysisFailedAt: new Date(), analysisError: error.slice(0, 300) } : {};
  const rows = await db.update(issues).set({ analysisClaimedAt: null, analysisClaimedBy: null, analysisClaimedDevice: null, ...failed })
    .where(and(eq(issues.projectId, p.id), eq(issues.number, number), eq(issues.analysisClaimedDevice, deviceId), eq(issues.analysisClaimedBy, user.id)))
    .returning({ id: issues.id });
  if (rows.length) await publish({ type: 'issue', projectKey: p.key, number });
  return { ok: true };
}

/** Dla szczegółu zgłoszenia: czy jakiś komputer online może to zlecenie wziąć i na którym ono biegnie. */
export async function analysisRunner(p: Project, issue: { analysisRequestedBy: number | null; analysisClaimedDevice: string | null; analysisRequestedAt?: Date | string | null; analysisClaimedAt?: Date | string | null }) {
  const [r] = await db.execute<{ can: boolean }>(dsql`
    select exists (
      select 1 from agents a
      where a.last_seen_at > now() - make_interval(secs => ${ONLINE_MS / 1000})
        and (a.user_id = ${issue.analysisRequestedBy}::int
          or (${p.agentTeamQueue}::boolean and exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id)))
    ) as can`);
  let claimedDeviceName: string | null = null;
  if (issue.analysisClaimedDevice) {
    const [a] = await db.select({ name: agents.name, label: agents.label }).from(agents).where(eq(agents.id, issue.analysisClaimedDevice));
    claimedDeviceName = a?.label || a?.name || null;
  }
  // Czeka zlecenie, nikt go nie wziął i żaden komputer online (aktualny, z repo albo z prawem klonowania) nie może go wziąć.
  let noCapablePc = false;
  if (issue.analysisRequestedAt && !issue.analysisClaimedAt) {
    const cands = await db.execute<{ version: string }>(dsql`
      select a.version from agents a
      where a.last_seen_at > now() - make_interval(secs => ${ONLINE_MS / 1000})
        and (a.user_id = ${issue.analysisRequestedBy}::int
          or (${p.agentTeamQueue}::boolean and exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id)))
        and (${p.agentsMayClone}::boolean or exists (select 1 from agent_repos r where r.agent_id = a.id and r.project_id = ${p.id} and r.status = 'ok'))`);
    noCapablePc = !cands.some((c) => agentUpToDate(c.version));
  }
  return { canRun: !!r?.can, claimedDeviceName, noCapablePc };
}

const ago = (ms: number) => new Date(Date.now() - ms);
const isOnline = (lastSeenAt: Date | null) => !!lastSeenAt && lastSeenAt.getTime() > Date.now() - ONLINE_MS;

/**
 * Sygnał życia agenta (też rejestracja nowego urządzenia). Urządzenie jednego użytkownika nie może przejąć cudze id.
 * Gdy agent jest zajęty, odświeżamy claim jego analizy: długi przebieg Deep nie wraca do kolejki ani nie wygląda na zawieszony.
 */
export type RepoReport = { path?: string; source?: string; status?: string; error?: string | null };
type HeartbeatInfo = { name: string; busy: boolean; repoKeys: string[]; repos?: Record<string, RepoReport | string>; version?: string; error?: string };

export async function heartbeat(user: User, deviceId: string, info: HeartbeatInfo) {
  const [existing] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, deviceId));
  if (existing && existing.userId !== user.id) throw new RuleError('Device belongs to someone else', 'forbidden');
  const repoKeys = [...new Set(info.repoKeys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z]{2,10}$/.test(k)))].slice(0, 50);
  // Bez podanej wersji zostaje zapisana (wersję podaje tracker-agent.ps1 z config.json).
  const values = { name: info.name.trim().slice(0, 100), busy: info.busy, repoKeys, lastSeenAt: new Date(), ...(info.version !== undefined ? { version: info.version.slice(0, 40) } : {}) };
  // Pusty błąd nie kasuje poprzedniego: zostaje widoczny do kolejnego błędu albo 24 h.
  const err = (info.error ?? '').trim().slice(0, 300);
  const errValues = err ? { lastError: err, lastErrorAt: new Date() } : {};
  const [row] = await db.insert(agents).values({ id: deviceId, userId: user.id, ...values, ...errValues })
    .onConflictDoUpdate({ target: agents.id, set: { ...values, ...errValues } }).returning();
  if (info.busy) {
    await db.update(issues).set({ analysisClaimedAt: new Date() })
      .where(and(eq(issues.analysisClaimedDevice, deviceId), dsql`${issues.analysisRequestedAt} is not null`));
  }
  await syncRepos(user, deviceId, info.repos ?? {}, repoKeys);
  return row;
}

const SOURCES = ['hook', 'manual', 'clone', 'install'] as const;

/**
 * Mapowanie repo na urządzeniu z tego, co zgłasza agent: {KEY: ścieżka} (stary format), {KEY: {path, source, status, error}}
 * albo same klucze (skrypty PS: bez ścieżki, ścieżka zostaje jak była). Tylko projekty, w których użytkownik jest członkiem.
 * Wiersze, których agent już nie zgłasza, znikają, poza ręcznymi (te ustawia człowiek w Ustawieniach, agent ich nie zna).
 */
async function syncRepos(user: User, deviceId: string, repos: Record<string, RepoReport | string>, legacyKeys: string[]) {
  const norm = new Map<string, RepoReport>();
  for (const [k, v] of Object.entries(repos)) {
    const key = k.trim().toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(key) || norm.size >= 50) continue;
    norm.set(key, typeof v === 'string' ? { path: v } : v ?? {});
  }
  for (const k of legacyKeys) if (!norm.has(k)) norm.set(k, {});
  const mine = await db.select({ id: projects.id, key: projects.key }).from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)));
  const sent = new Set<number>();
  for (const pr of mine) {
    const r = norm.get(pr.key);
    if (!r) continue;
    sent.add(pr.id);
    const status = r.status === 'error' ? 'error' : 'ok';
    const source = (SOURCES as readonly string[]).includes(r.source ?? '') ? (r.source as (typeof SOURCES)[number]) : 'hook';
    const error = status === 'error' ? (r.error ?? '').slice(0, 300) || null : null;
    const hasPath = typeof r.path === 'string';
    await db.insert(agentRepos).values({ agentId: deviceId, projectId: pr.id, path: hasPath ? r.path!.slice(0, 500) : '', source, status, error })
      .onConflictDoUpdate({ target: [agentRepos.agentId, agentRepos.projectId], set: { ...(hasPath ? { path: r.path!.slice(0, 500), source } : {}), status, error, updatedAt: new Date() } });
  }
  const existing = await db.select({ projectId: agentRepos.projectId, source: agentRepos.source }).from(agentRepos).where(eq(agentRepos.agentId, deviceId));
  const stale = existing.filter((e) => e.source !== 'manual' && !sent.has(e.projectId)).map((e) => e.projectId);
  if (stale.length) await db.delete(agentRepos).where(and(eq(agentRepos.agentId, deviceId), inArray(agentRepos.projectId, stale)));
}

/** Mapowanie tego urządzenia i projekty, w których agent może klonować repo. */
export async function repoState(user: User, deviceId: string) {
  const repos = await db.select({ project: projects.key, path: agentRepos.path, source: agentRepos.source, status: agentRepos.status, error: agentRepos.error })
    .from(agentRepos).innerJoin(projects, eq(projects.id, agentRepos.projectId)).where(eq(agentRepos.agentId, deviceId)).orderBy(asc(projects.key));
  const clone = await db.select({ key: projects.key }).from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .where(eq(projects.agentsMayClone, true)).orderBy(asc(projects.key));
  return { repos, cloneAllowed: clone.map((c) => c.key) };
}

/** Ręczne ustawienie ścieżki repo na moim komputerze (z Ustawień). */
export async function setAgentRepo(user: User, deviceId: string, projectKey: string, repoPath: string) {
  await requireOwnAgent(user, deviceId);
  const clean = repoPath.trim();
  if (!clean || clean.length > 500) throw new RuleError('Path cannot be empty', 'invalid');
  const [pr] = await db.select({ id: projects.id }).from(projects)
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .where(eq(projects.key, projectKey.toUpperCase()));
  if (!pr) throw new RuleError('Project not found', 'not_found');
  await db.insert(agentRepos).values({ agentId: deviceId, projectId: pr.id, path: clean, source: 'manual', status: 'ok', error: null })
    .onConflictDoUpdate({ target: [agentRepos.agentId, agentRepos.projectId], set: { path: clean, source: 'manual', status: 'ok', error: null, updatedAt: new Date() } });
  return { ok: true };
}

export async function removeAgentRepo(user: User, deviceId: string, projectKey: string) {
  await requireOwnAgent(user, deviceId);
  const [pr] = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, projectKey.toUpperCase()));
  if (pr) await db.delete(agentRepos).where(and(eq(agentRepos.agentId, deviceId), eq(agentRepos.projectId, pr.id)));
  return { ok: true };
}

export type AgentJob = { kind: 'analyze'; key: string; deep: boolean } | { kind: 'start'; id: number; key: string };

/** Co ten agent może teraz wziąć: moje zlecenia (i kolejka zespołu w projektach z włączonym przełącznikiem) oraz zlecenia Start. */
export async function pendingWork(user: User, agent: { id?: string; busy: boolean; repoKeys: string[]; version: string }): Promise<AgentJob[]> {
  // Stara wersja skryptów: nic nie dostaje (Ustawienia i pasek analizy pokazują "Update needed").
  if (agent.busy || !agentUpToDate(agent.version)) return [];
  const jobs: AgentJob[] = [];
  {
    const rows = await db.select({ key: projects.key, number: issues.number, deep: issues.analysisDeep })
      .from(issues).innerJoin(projects, eq(projects.id, issues.projectId))
      .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
      .where(and(
        dsql`${issues.analysisRequestedAt} is not null`,
        isNull(issues.analysisFailedAt),
        dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}))`,
        dsql`(${projects.agentsMayClone} or exists (select 1 from agent_repos r where r.agent_id = ${agent.id ?? ''} and r.project_id = ${projects.id} and r.status = 'ok'))`,
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
export async function waitForWork(user: User, deviceId: string, info: HeartbeatInfo, signal: AbortSignal) {
  const agent = await heartbeat(user, deviceId, info);
  const until = Date.now() + 25_000;
  for (;;) {
    const jobs = await pendingWork(user, agent);
    if (jobs.length || signal.aborted || Date.now() >= until) return { jobs, ...(await repoState(user, deviceId)) };
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
  const repos = rows.length ? await db.select({ agentId: agentRepos.agentId, project: projects.key, path: agentRepos.path, source: agentRepos.source, status: agentRepos.status, error: agentRepos.error })
    .from(agentRepos).innerJoin(projects, eq(projects.id, agentRepos.projectId))
    .where(inArray(agentRepos.agentId, rows.map((a) => a.id))).orderBy(asc(projects.key)) : [];
  return rows.map((a) => ({ id: a.id, name: a.label || a.name, computerName: a.name, label: a.label, lastSeenAt: a.lastSeenAt, busy: a.busy, online: isOnline(a.lastSeenAt), outdated: !agentUpToDate(a.version),
    repos: repos.filter((r) => r.agentId === a.id).map(({ agentId: _, ...r }) => r),
    // Błąd starszy niż 24 h już nie jest istotny.
    lastError: a.lastErrorAt && a.lastErrorAt.getTime() > Date.now() - 24 * 3600_000 ? a.lastError : '', lastErrorAt: a.lastErrorAt }));
}

/** Własna nazwa komputera (pusta = nazwa z Windowsa). Tylko właściciel. */
export async function renameAgent(user: User, id: string, label: string) {
  const rows = await db.update(agents).set({ label: label.trim().slice(0, 60) }).where(and(eq(agents.id, id), eq(agents.userId, user.id))).returning({ id: agents.id });
  if (!rows.length) throw new RuleError('Computer not found', 'not_found');
  return { ok: true };
}

export async function removeAgent(user: User, id: string) {
  await db.delete(agents).where(and(eq(agents.id, id), eq(agents.userId, user.id)));
  return { ok: true };
}

/** Komputery online należące do członków projektu (kolejka zespołu). */
export async function projectAgents(p: Project) {
  const rows = await db.select({ name: dsql<string>`coalesce(nullif(${agents.label}, ''), ${agents.name})`, owner: users.name, busy: agents.busy })
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
  // Agent ze starymi skryptami nie dostaje pracy, więc zlecenie by tylko wisiało.
  if (!mine.some((a) => a.online && !a.outdated)) throw new RuleError('PC scripts are outdated: run the install command again (Settings > Claude Code)', 'outdated');
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

/**
 * Stan podłączenia AI dla kreatora: klient (pierwsze wywołanie MCP przez OAuth albo użyty token), ślad pracy (jakikolwiek
 * worklog tego użytkownika) i agent (któryś własny komputer online ze świeżą wersją). Kilka tanich zapytań z LIMIT 1.
 */
export async function aiStatus(user: User, mine?: Awaited<ReturnType<typeof myAgents>>) {
  const [grant] = await db.select({ name: oauthClients.name, at: oauthGrants.firstMcpAt }).from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt), dsql`${oauthGrants.firstMcpAt} is not null`))
    .orderBy(dsql`${oauthGrants.firstMcpAt} desc`).limit(1);
  const [token] = grant ? [] : await db.select({ at: apiTokens.lastUsedAt }).from(apiTokens)
    .where(and(eq(apiTokens.userId, user.id), dsql`${apiTokens.lastUsedAt} is not null`)).orderBy(dsql`${apiTokens.lastUsedAt} desc`).limit(1);
  const [wl] = await db.select({ id: activity.id }).from(activity)
    .where(and(eq(activity.actorId, user.id), dsql`${activity.payload}->>'kind' = 'worklog'`)).limit(1);
  const computers = mine ?? await myAgents(user);
  return {
    client: !!grant || !!token,
    clientName: grant ? grant.name : token ? 'Claude Code' : null,
    clientAt: grant?.at ?? token?.at ?? null,
    workTrace: !!wl,
    agent: computers.some((a) => a.online && !a.outdated),
  };
}
