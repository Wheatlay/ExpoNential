import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, notInArray, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { type AgentSetup, activity, agentJobs, agentRepos, agentRuns, agentTombstones, agents, apiTokens, issues, oauthClients, oauthGrants, projectMembers, projects, statuses, users } from '../db/schema.ts';
import { NOT_AGENT_CLIENT } from './oauth.ts';
import { RuleError, identifier, parseIdentifier } from './rules.ts';
import { sql } from '../db/index.ts';
import { analysisModel } from './prompts.ts';
import { log, markAnalysisFailed, publish, requireIssue, updateIssue, type Actor, type Project } from './service.ts';

// Agent na PC (Go) trzyma długie odpytanie; claim analizy wygasa po 30 min.
export const CLAIM_TTL_MIN = 30;
/** Zlecenie analizy, którego żaden komputer nie wziął w tym czasie, kończy się błędem. */
export const UNCLAIMED_TTL_H = 24;
export const UNCLAIMED_ERROR = 'No PC took the analysis within 24h';
export const ONLINE_MS = 90_000;
export const START_JOB_TTL_MIN = 60;
export const LOCAL_RESERVE_S = 60;

type User = { id: number };

/** Najstarszy agent z agent/ (exponential-agent.exe, wersja semver), który jeszcze dostaje pracę. */
export const MIN_EXE_AGENT = '0.4.4';
const semver = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
/** Najstarszy agent, który odpytuje /api/agent/open-requests (Start work przez agenta). */
export const MIN_OPEN_AGENT = '0.4.16';
/** Aktualny agent: agent .exe nie starszy niż MIN_EXE_AGENT (albo podanego minimum). */
export function agentUpToDate(version: string | null | undefined, minVersion = MIN_EXE_AGENT) {
  if (!version) return false;
  const v = semver(version), min = semver(minVersion)!;
  if (!v) return false;
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/** Urządzenie musi istnieć (agent zgłasza je pierwszym odpytaniem) i należeć do wołającego. */
export async function requireOwnAgent(user: User, deviceId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, deviceId));
  if (!row) throw new RuleError('Unknown PC: connect the agent again (Settings › My AI)', 'invalid');
  if (row.userId !== user.id) throw new RuleError('Device belongs to someone else', 'forbidden');
  return row;
}

/**
 * Tokeny przebiegu = wejście + wyjście + zapis cache. Odczyty cache są pominięte celowo: są tanie i zawyżałyby liczbę
 * wielokrotnie (każdy turn czyta cały kontekst od nowa).
 */
const RUN_TOKENS = dsql`(coalesce(${agentRuns.inputTokens}, 0) + coalesce(${agentRuns.outputTokens}, 0) + coalesce(${agentRuns.cacheWriteTokens}, 0))`;

/** Tokeny zleceń innych osób na tym komputerze w ostatnich 24 h. */
export async function tokensForOthers24h(agentId: string, ownerId: number) {
  const [r] = await db.select({ n: dsql<string>`coalesce(sum(${RUN_TOKENS}), 0)` }).from(agentRuns)
    .where(and(eq(agentRuns.agentId, agentId), dsql`${agentRuns.requesterId} <> ${ownerId}`, dsql`${agentRuns.createdAt} >= now() - interval '24 hours'`));
  return Number(r?.n ?? 0);
}

/** Czy komputer wyczerpał dobowy limit tokenów dla innych osób (własne zlecenia właściciela nie liczą się i nie są limitowane). */
export async function limitReached(agentId: string, ownerId: number, max: number | null | undefined) {
  if (max == null) return false;
  return (await tokensForOthers24h(agentId, ownerId)) >= max;
}
const LIMIT_MSG = 'Daily token limit for others reached on this PC';

/**
 * Przejęcie zlecenia analizy przed uruchomieniem. Jeden UPDATE z warunkami w WHERE daje wyłączność:
 * z dwóch równoczesnych wywołań wygra jedno, drugie dostaje 409. To samo urządzenie może przejąć ponownie (idempotentnie).
 */
export async function claimAnalysis(p: Project, user: User & { name: string }, number: number, deviceId: string, version?: string, ownOnly = false) {
  // Kliknięcie w przeglądarce może odpalić handler, zanim agent w tle zdąży się pierwszy raz zgłosić: wtedy rejestrujemy
  // urządzenie tutaj (należy do właściciela tokenu), zamiast wywracać analizę na "Unknown device".
  if (await recentlyRemoved(deviceId)) throw new RuleError('This PC was removed', 'conflict');
  await db.insert(agents).values({ id: deviceId, userId: user.id }).onConflictDoNothing();
  const agent = await requireOwnAgent(user, deviceId);
  await expireUnclaimedAnalyses();
  // Agent podaje swoją wersję: świeżo zaktualizowany PC nie czeka na pierwszy sygnał.
  if (version !== undefined && version !== agent.version) {
    await db.update(agents).set({ version: version.slice(0, 40) }).where(eq(agents.id, deviceId));
    agent.version = version;
  }
  // Stary agent nie dostaje pracy: poprawki (np. blokada .env) działają dopiero po aktualizacji.
  if (!agentUpToDate(agent.version)) throw new RuleError('The agent on this PC is outdated: update it (Settings › My AI)', 'outdated');
  // Analizę bierze tylko komputer z działającym repo projektu (chyba że projekt pozwala agentom klonować).
  if (!p.agentsMayClone) {
    const [m] = await db.select({ s: agentRepos.status }).from(agentRepos).where(and(eq(agentRepos.agentId, deviceId), eq(agentRepos.projectId, p.id)));
    if (m?.s !== 'ok') throw new RuleError(`This PC has no repo for ${p.key}`, 'conflict');
  }
  const [cur] = await db.select().from(issues).where(and(eq(issues.projectId, p.id), eq(issues.number, number)));
  if (!cur) throw new RuleError(`Issue ${identifier(p.key, number)} not found`, 'not_found');
  const already = cur.analysisClaimedDevice === deviceId && cur.analysisClaimedAt != null;
  // Limit dla innych: zlecenie cudzej osoby nie przejdzie, gdy komputer wyczerpał dobowy limit. Własne zlecenia nigdy.
  if (!already && cur.analysisRequestedBy != null && cur.analysisRequestedBy !== user.id && await limitReached(deviceId, user.id, agent.maxOthersTokensPerDay)) throw new RuleError(LIMIT_MSG, 'conflict');
  const rows = await db.update(issues).set({ analysisClaimedAt: new Date(), analysisClaimedBy: user.id, analysisClaimedDevice: deviceId, analysisConsentPendingAt: null })
    .where(and(
      eq(issues.id, cur.id),
      dsql`${issues.analysisRequestedAt} is not null`,
      isNull(issues.analysisFailedAt),
      dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}) or ${issues.analysisClaimedDevice} = ${deviceId})`,
      dsql`(${issues.analysisRequestedBy} = ${user.id} or (${p.agentTeamQueue && !ownOnly}::boolean and ${agent.teamMode !== 'off'}::boolean and (${issues.analysisLocalUntil} is null or ${issues.analysisLocalUntil} < now())))`,
    ))
    .returning({ deep: issues.analysisDeep });
  if (!rows.length) throw new RuleError('Already taken or no longer requested', 'conflict');
  // Kto zlecił: zapisujemy na komputerze, bo analiza (set_analysis) kasuje claim na zgłoszeniu, zanim agent zgłosi przebieg.
  const requesterId = cur.analysisRequestedBy ?? null;
  await db.update(agents).set({ currentRequesterId: requesterId }).where(eq(agents.id, deviceId));
  const [rq] = requesterId != null ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, requesterId)) : [];
  if (!already) {
    // Zajęcie robi agent na PC, nie człowiek: w aktywności ze znacznikiem AI, jak inne akcje agenta.
    await db.transaction((tx) => log(tx, cur.id, { ...user, ai: true } as Actor, { kind: 'analysis_claimed', device: agent.label || agent.name || 'PC' }));
    await publish({ type: 'issue', projectKey: p.key, number });
  }
  return { ok: true, deep: rows[0].deep, model: analysisModel(p, rows[0].deep), requester: rq ? { id: rq.id, name: rq.name } : null };
}

/**
 * Oddanie zlecenia przez urządzenie, które je przejęło. Z błędem: zlecenie zostaje oznaczone jako nieudane i nie wraca
 * samo do kolejki (inaczej trwały błąd powtarzałby się co kilka sekund). Brak zmian to nie błąd.
 */
export async function releaseClaim(p: Project, user: User, number: number, deviceId: string, error?: string, requeue = false) {
  // requeue: agent oddaje zlecenie bez winy zlecenia (np. brak repo, limit): wraca do kolejki bez flagi błędu.
  const failed = error !== undefined && !requeue ? { analysisFailedAt: new Date(), analysisError: error.slice(0, 300) } : {};
  const rows = await db.update(issues).set({ analysisClaimedAt: null, analysisClaimedBy: null, analysisClaimedDevice: null, analysisConsentPendingAt: null, ...failed })
    .where(and(eq(issues.projectId, p.id), eq(issues.number, number), eq(issues.analysisClaimedDevice, deviceId), eq(issues.analysisClaimedBy, user.id)))
    .returning({ id: issues.id });
  if (rows.length && 'analysisError' in failed) await db.transaction((tx) => log(tx, rows[0].id, { ...user, ai: true } as Actor, { kind: 'analysis_failed', error: (error ?? '').slice(0, 300) }));
  if (rows.length) await publish({ type: 'issue', projectKey: p.key, number });
  return { ok: true };
}

/**
 * Zlecenia, których żaden komputer nie wziął od 24 h: kończą się błędem (flaga + wpis w aktywności), bo inaczej wiszą w nieskończoność.
 * Wołane leniwie z odpytania agenta i przy claimie oraz co 10 min z timera serwera. Zlecenie zostaje zaznaczone jako zlecone (UI pokazuje błąd i Analyze again).
 */
export async function expireUnclaimedAnalyses() {
  const rows = await db.select({ id: issues.id, number: issues.number, key: projects.key }).from(issues).innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(dsql`${issues.analysisRequestedAt} < now() - make_interval(hours => ${UNCLAIMED_TTL_H})`, isNull(issues.analysisClaimedAt), isNull(issues.analysisFailedAt)));
  for (const r of rows) {
    await markAnalysisFailed(r.id, UNCLAIMED_ERROR);
    await publish({ type: 'issue', projectKey: r.key, number: r.number });
  }
  return rows.length;
}

/** Agent czeka na zgodę właściciela PC na cudze zlecenie (pending=true) albo już nie czeka. Tylko dla członka projektu zgłoszenia. */
export async function setConsentPending(user: User, issueId: number, pending: boolean) {
  const [row] = await db.select({ number: issues.number, key: projects.key }).from(issues).innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
    .where(eq(issues.id, issueId));
  if (!row) throw new RuleError('Issue not found', 'not_found');
  await db.update(issues).set({ analysisConsentPendingAt: pending ? new Date() : null })
    .where(and(eq(issues.id, issueId), pending ? dsql`${issues.analysisRequestedAt} is not null` : undefined));
  await publish({ type: 'issue', projectKey: row.key, number: row.number });
  return { ok: true };
}

/** Prośby "Start work" dla agenta: w pamięci, per osoba (restart serwera je gubi, to w porządku: prośba żyje kilka sekund). */
export type OpenRequest = { editor: string; repo: string; prompt: string };
const OPEN_REQUEST_TTL_MS = 5 * 60_000;
const openRequests = new Map<number, (OpenRequest & { at: number })[]>();
export function queueOpenRequest(userId: number, req: OpenRequest) {
  openRequests.set(userId, [...(openRequests.get(userId) ?? []), { ...req, at: Date.now() }].slice(-10));
}
/** Zwraca i czyści kolejkę osoby (starsze niż 5 minut przepadają). */
export function takeOpenRequests(userId: number): OpenRequest[] {
  const list = openRequests.get(userId) ?? [];
  openRequests.delete(userId);
  return list.filter((q) => Date.now() - q.at < OPEN_REQUEST_TTL_MS).map(({ editor, repo, prompt }) => ({ editor, repo, prompt }));
}

export type WaitReason = 'queue_off' | 'no_pc_online' | 'no_repo_pc' | 'awaiting_consent';
type WaitRow = { analysisRequestedAt: Date | string | null; analysisClaimedAt: Date | string | null; analysisFailedAt: Date | string | null; analysisRequestedBy: number | null; analysisConsentPendingAt: Date | string | null };

/** Dlaczego zlecona analiza jeszcze nie ruszyła (tylko zlecona, nieprzejęta i niepadnięta; inaczej null). Jedno zapytanie o komputery na całą listę. */
export async function waitReasons(p: Project, rows: WaitRow[]): Promise<(WaitReason | null)[]> {
  const waiting = (r: WaitRow) => !!r.analysisRequestedAt && !r.analysisClaimedAt && !r.analysisFailedAt;
  if (!rows.some(waiting)) return rows.map(() => null);
  const online = await db.execute<{ user_id: number; version: string; team_mode: string; member: boolean; has_repo: boolean }>(dsql`
    select a.user_id, a.version, a.team_mode,
      exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id) as member,
      exists (select 1 from agent_repos r where r.agent_id = a.id and r.project_id = ${p.id} and r.status = 'ok') as has_repo
    from agents a where a.last_seen_at > now() - make_interval(secs => ${ONLINE_MS / 1000})`);
  return rows.map((r) => {
    if (!waiting(r)) return null;
    if (r.analysisConsentPendingAt) return 'awaiting_consent';
    const own = online.filter((a) => a.user_id === r.analysisRequestedBy);
    if (!p.agentTeamQueue && !own.length) return 'queue_off';
    const team = p.agentTeamQueue ? online.filter((a) => a.member && a.team_mode !== 'off') : [];
    const cands = [...own, ...team];
    if (!cands.length) return 'no_pc_online';
    if (!cands.some((a) => (p.agentsMayClone || a.has_repo) && agentUpToDate(a.version))) return 'no_repo_pc';
    return null;
  });
}

/** Dla szczegółu zgłoszenia: czy jakiś komputer online może to zlecenie wziąć i na którym ono biegnie. */
export async function analysisRunner(p: Project, issue: { analysisRequestedBy: number | null; analysisClaimedDevice: string | null; analysisRequestedAt?: Date | string | null; analysisClaimedAt?: Date | string | null }) {
  const [r] = await db.execute<{ can: boolean }>(dsql`
    select exists (
      select 1 from agents a
      where a.last_seen_at > now() - make_interval(secs => ${ONLINE_MS / 1000})
        and (a.user_id = ${issue.analysisRequestedBy}::int
          or (${p.agentTeamQueue}::boolean and exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id) and a.team_mode <> 'off'))
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
          or (${p.agentTeamQueue}::boolean and exists (select 1 from project_members m where m.project_id = ${p.id} and m.user_id = a.user_id) and a.team_mode <> 'off'))
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
/** ownOnly: agent z Codexem. Codex czyta cały dysk, więc nie dostaje zleceń innych osób z kolejki zespołu (prompt injection). */
type HeartbeatInfo = { name: string; busy: boolean; repoKeys: string[]; repos?: Record<string, RepoReport | string>; version?: string; error?: string; ownOnly?: boolean; setup?: AgentSetup; skip?: number[] };

/** Parametr skip=1,2,3 z odpytania agenta: tylko liczby całkowite dodatnie, bez powtórzeń, najwyżej 50. */
export function parseSkip(raw?: string): number[] {
  if (!raw) return [];
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => /^\d{1,9}$/.test(s)).map(Number).filter((n) => n > 0);
  return [...new Set(ids)].slice(0, 50);
}

const setupSchema = z.object({
  claude: z.array(z.object({ name: z.string().max(100), mcp: z.boolean(), plugin: z.boolean() })).max(20).default([]),
  codex: z.boolean().default(false), cursor: z.boolean().default(false),
});
/** Stan konfiguracji zgłoszony przez agenta (JSON w zapytaniu); zły albo brak = undefined (stary agent, zostaje poprzedni). */
export function parseSetup(raw?: string): AgentSetup | undefined {
  if (!raw) return undefined;
  try { return setupSchema.parse(JSON.parse(raw)); } catch { return undefined; }
}

/** Ręcznie usunięty komputer nie wraca z odpytania (agent kończący pracę przy odinstalowaniu), dopóki nie sparuje się na nowo. */
async function recentlyRemoved(deviceId: string) {
  const [t] = await db.select({ id: agentTombstones.id }).from(agentTombstones).where(eq(agentTombstones.id, deviceId));
  return !!t;
}

export async function heartbeat(user: User, deviceId: string, info: HeartbeatInfo) {
  const [existing] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, deviceId));
  if (!existing && await recentlyRemoved(deviceId)) throw new RuleError('This PC was removed', 'conflict');
  if (existing && existing.userId !== user.id) throw new RuleError('Device belongs to someone else', 'forbidden');
  const repoKeys = [...new Set(info.repoKeys.map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z]{2,10}$/.test(k)))].slice(0, 50);
  // Bez podanej wersji zostaje zapisana poprzednia.
  const values = { name: info.name.trim().slice(0, 100), busy: info.busy, repoKeys, lastSeenAt: new Date(), ...(info.version !== undefined ? { version: info.version.slice(0, 40) } : {}), ...(info.setup ? { setup: info.setup } : {}) };
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
 * albo same klucze (bez ścieżki, ścieżka zostaje jak była). Tylko projekty, w których użytkownik jest członkiem.
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
  const [me] = await db.select({ teamMode: agents.teamMode, limit: agents.maxOthersTokensPerDay }).from(agents).where(eq(agents.id, deviceId));
  return { repos, cloneAllowed: clone.map((c) => c.key), teamMode: me?.teamMode ?? 'ask', maxOthersTokensPerDay: me?.limit ?? null };
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

/** requestedBy: kto zlecił analizę, żeby agent mógł zapytać właściciela komputera o zgodę, zanim przejmie cudze zlecenie. */
export type AgentJob = { kind: 'analyze'; id: number; key: string; deep: boolean; requestedAt?: string | null; requestedBy?: { id: number; name: string } | null } | { kind: 'start'; id: number; key: string };

/** Co ten agent może teraz wziąć: moje zlecenia (i kolejka zespołu w projektach z włączonym przełącznikiem) oraz zlecenia Start. */
export async function pendingWork(user: User, agent: { id?: string; busy: boolean; repoKeys: string[]; version: string; ownOnly?: boolean; maxOthersTokensPerDay?: number | null },
  opts: { limited?: boolean; skip?: number[] } = {}): Promise<AgentJob[]> {
  // Stara wersja agenta: nic nie dostaje (Ustawienia i pasek analizy pokazują "Update needed").
  if (agent.busy || !agentUpToDate(agent.version)) return [];
  const jobs: AgentJob[] = [];
  // Wyczerpany limit dla innych: oferujemy tylko zlecenia właściciela.
  const limited = opts.limited ?? (!!agent.id && await limitReached(agent.id, user.id, agent.maxOthersTokensPerDay));
  const skip = opts.skip?.length ? opts.skip.slice(0, 50) : [];
  {
    const rows = await db.select({ id: issues.id, key: projects.key, number: issues.number, deep: issues.analysisDeep, requestedAt: issues.analysisRequestedAt, byId: issues.analysisRequestedBy, byName: users.name })
      .from(issues).innerJoin(projects, eq(projects.id, issues.projectId))
      .leftJoin(users, eq(users.id, issues.analysisRequestedBy))
      .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
      .where(and(
        dsql`${issues.analysisRequestedAt} is not null`,
        isNull(issues.analysisFailedAt),
        skip.length ? notInArray(issues.id, skip) : undefined,
        dsql`(${issues.analysisClaimedAt} is null or ${issues.analysisClaimedAt} < now() - make_interval(mins => ${CLAIM_TTL_MIN}))`,
        dsql`(${projects.agentsMayClone} or exists (select 1 from agent_repos r where r.agent_id = ${agent.id ?? ''} and r.project_id = ${projects.id} and r.status = 'ok'))`,
        dsql`(${issues.analysisRequestedBy} = ${user.id} or (${projects.agentTeamQueue} and ${!agent.ownOnly && !limited}::boolean and exists (select 1 from agents ta where ta.id = ${agent.id ?? ''} and ta.team_mode <> 'off') and (${issues.analysisLocalUntil} is null or ${issues.analysisLocalUntil} < now())))`,
      ))
      .orderBy(dsql`(${issues.analysisRequestedBy} = ${user.id}) desc nulls last`, asc(issues.analysisRequestedAt)).limit(5);
    for (const r of rows) jobs.push({ kind: 'analyze', id: r.id, key: identifier(r.key, r.number), deep: r.deep,
      requestedAt: r.requestedAt ? new Date(r.requestedAt).toISOString() : null, requestedBy: r.byId != null ? { id: r.byId, name: r.byName ?? '' } : null });
  }
  const starts = await db.select({ id: agentJobs.id, key: projects.key, number: issues.number })
    .from(agentJobs).innerJoin(issues, eq(issues.id, agentJobs.issueId)).innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(eq(agentJobs.userId, user.id), eq(agentJobs.kind, 'start'), isNull(agentJobs.claimedAt), gt(agentJobs.createdAt, ago(START_JOB_TTL_MIN * 60_000))))
    .orderBy(asc(agentJobs.createdAt));
  for (const s of starts) jobs.push({ kind: 'start', id: s.id, key: identifier(s.key, s.number) });
  return jobs;
}

/** Czekanie na sygnał pracy (zlecenie analizy, Start, zmiana członkostwa) albo na timeout/abort. */
const waiters = new Set<() => void>();
let listening = false;
/** Budzi wszystkie oczekujące długie odpytania (też z testów). */
export function notifyWork() { for (const w of [...waiters]) w(); }
function ensureListener() {
  if (listening) return;
  listening = true;
  // Własny nasłuch tego samego kanału co strumień SSE: po zdarzeniu zlecenia odpytanie sprawdza pracę od razu.
  sql.listen('tracker_events', (payload) => {
    try { const e = JSON.parse(payload) as { type?: string }; if (e.type === 'issue' || e.type === 'projects') notifyWork(); } catch { /* obce zdarzenie */ }
  }).catch(() => { listening = false; });
}
const FALLBACK_MS = 10_000;
const waitSignal = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(t); waiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  waiters.add(done);
  signal.addEventListener('abort', done);
});

/** Long poll agenta: jeden heartbeat na żądanie, potem do 25 s czekamy na zdarzenie (awaryjnie co 10 s sprawdzamy bazę). */
export async function waitForWork(user: User, deviceId: string, info: HeartbeatInfo, signal: AbortSignal) {
  const agent = await heartbeat(user, deviceId, info);
  await expireUnclaimedAnalyses().catch(() => undefined);
  const until = Date.now() + 25_000;
  ensureListener();
  // Limit dla innych liczymy raz na odpytanie.
  const limited = await limitReached(deviceId, user.id, agent.maxOthersTokensPerDay);
  for (;;) {
    const jobs = await pendingWork(user, { ...agent, ownOnly: info.ownOnly }, { limited, skip: info.skip });
    if (jobs.length || signal.aborted || Date.now() >= until) return { jobs, ...(await repoState(user, deviceId)) };
    await waitSignal(Math.min(FALLBACK_MS, until - Date.now()), signal);
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
  await db.update(agents).set({ currentRequesterId: user.id }).where(eq(agents.id, deviceId));
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id));
  return { key: identifier(r.key, r.number), requester: { id: user.id, name: u?.name ?? '' } };
}

export type Usage = { runs: number; forOthers: number; costUsd: number; tokens: number; byRequester: { name: string; runs: number; costUsd: number; tokens: number }[] };
const emptyUsage = (): Usage => ({ runs: 0, forOthers: 0, costUsd: 0, tokens: 0, byRequester: [] });
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Statystyki z ostatnich 30 dni per komputer (opcjonalnie tylko jeden projekt); najczęstsi zlecający (top 5). */
async function usageByAgent(agentIds: string[], projectId?: number) {
  const out = new Map<string, Usage>(agentIds.map((id) => [id, emptyUsage()]));
  if (!agentIds.length) return out;
  const rows = await db.select({ agentId: agentRuns.agentId, ownerId: agentRuns.ownerId, requesterId: agentRuns.requesterId, name: users.name, runs: dsql<number>`count(*)::int`, cost: dsql<string>`coalesce(sum(${agentRuns.costUsd}), 0)`, tokens: dsql<string>`coalesce(sum(${RUN_TOKENS}), 0)` })
    .from(agentRuns).leftJoin(users, eq(users.id, agentRuns.requesterId))
    .where(and(inArray(agentRuns.agentId, agentIds), dsql`${agentRuns.createdAt} >= now() - interval '30 days'`, projectId != null ? eq(agentRuns.projectId, projectId) : undefined))
    .groupBy(agentRuns.agentId, agentRuns.ownerId, agentRuns.requesterId, users.name);
  for (const r of rows) {
    const u = out.get(r.agentId)!, cost = Number(r.cost), tokens = Number(r.tokens);
    u.runs += r.runs; u.costUsd += cost; u.tokens += tokens;
    if (r.requesterId != null && r.requesterId !== r.ownerId) u.forOthers += r.runs;
    if (r.requesterId != null && r.name) u.byRequester.push({ name: r.name, runs: r.runs, costUsd: cost, tokens });
  }
  for (const u of out.values()) {
    u.costUsd = round4(u.costUsd);
    u.byRequester = u.byRequester.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)).slice(0, 5).map((b) => ({ ...b, costUsd: round4(b.costUsd) }));
  }
  return out;
}

const inRange = (v: unknown, max: number, min = 0): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export type RunReport = { deviceId: string; key: string; kind: 'analyze' | 'start'; engine: string; model: string; startedAt?: string; durationMs: number; exitCode: number;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number } };

/**
 * Przebieg zgłoszony przez agenta po zakończeniu. Zlecający: dla analizy ten, kogo zapisał claim (agents.currentRequesterId),
 * dla Start właściciel. Liczby muszą być nieujemne i w rozsądnych granicach.
 */
export async function recordRun(user: User, r: RunReport) {
  const agent = await requireOwnAgent(user, r.deviceId);
  if (r.kind !== 'analyze' && r.kind !== 'start') throw new RuleError('Invalid run kind', 'invalid');
  const u = r.usage ?? {};
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (u[k] !== undefined && !(inRange(u[k], 2_000_000_000) && Number.isInteger(u[k]))) throw new RuleError(`Invalid ${k}`, 'invalid');
  }
  if (u.costUsd !== undefined && !inRange(u.costUsd, 100_000)) throw new RuleError('Invalid costUsd', 'invalid');
  if (!inRange(r.durationMs, 7 * 86_400_000) || !Number.isInteger(r.durationMs)) throw new RuleError('Invalid durationMs', 'invalid');
  if (!inRange(r.exitCode, 1_000_000, -1_000_000) || !Number.isInteger(r.exitCode)) throw new RuleError('Invalid exitCode', 'invalid');
  const started = r.startedAt ? new Date(r.startedAt) : null;
  if (started && Number.isNaN(started.getTime())) throw new RuleError('Invalid startedAt', 'invalid');
  const id = parseIdentifier(r.key);
  const [pr] = id?.key ? await db.select({ id: projects.id }).from(projects).where(eq(projects.key, id.key.toUpperCase())) : [];
  const requesterId = r.kind === 'start' ? user.id : agent.currentRequesterId;
  const [row] = await db.insert(agentRuns).values({
    agentId: agent.id, ownerId: user.id, requesterId, projectId: pr?.id ?? null, issueNumber: id?.number ?? null, kind: r.kind,
    engine: (r.engine ?? '').slice(0, 20), model: (r.model ?? '').slice(0, 80), startedAt: started, durationMs: r.durationMs, exitCode: r.exitCode,
    inputTokens: u.inputTokens ?? null, outputTokens: u.outputTokens ?? null, cacheReadTokens: u.cacheReadTokens ?? null, cacheWriteTokens: u.cacheWriteTokens ?? null,
    costUsd: u.costUsd !== undefined ? u.costUsd.toFixed(4) : null,
  }).returning({ id: agentRuns.id });
  if (r.exitCode === 0) await db.update(agents).set({ lastOkAt: new Date() }).where(eq(agents.id, agent.id));
  return { ok: true, id: row.id };
}

/** Moje komputery do Ustawień. */
/** Błędy połączenia, które mijają same: 5xx, brak odpowiedzi, brak połączenia z serwerem. */
const CLAUDE_LIMIT = /^(Limit Claude do|Claude limit until) \d{1,2}:\d{2}/;
const TRANSIENT_ERROR = /HTTP 5\d\d|did not answer|cannot reach|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout/i;

type AgentRow = typeof agents.$inferSelect;
/** Błąd agenta wart pokazania: świeży (24 h), nie limit Claude, nie chwilowy błąd połączenia online'owego PC i nie błąd, po którym PC skończył zlecenie poprawnie. */
function shownError(a: AgentRow) {
  if (!a.lastErrorAt || a.lastErrorAt.getTime() <= Date.now() - 24 * 3600_000) return '';
  if (CLAUDE_LIMIT.test(a.lastError ?? '')) return '';
  if (isOnline(a.lastSeenAt) && (TRANSIENT_ERROR.test(a.lastError ?? '') || (a.lastOkAt && a.lastOkAt > a.lastErrorAt))) return '';
  return a.lastError;
}
/** Pola komputera wspólne dla listy w Ustawieniach i lekkiego odczytu (bez zużycia z 30 dni, repo i zleceń). */
const agentCore = (a: AgentRow, others24: number, othersTokens24: number) => ({ id: a.id, maxOthersTokensPerDay: a.maxOthersTokensPerDay,
  forOthers24h: others24, forOthersTokens24h: othersTokens24, limitReached24h: a.maxOthersTokensPerDay != null && othersTokens24 >= a.maxOthersTokensPerDay,
  lastSeenAt: a.lastSeenAt, busy: a.busy, online: isOnline(a.lastSeenAt), inactive: !!a.lastSeenAt && a.lastSeenAt.getTime() < Date.now() - 3 * 864e5,
  outdated: !agentUpToDate(a.version), opensEditor: agentUpToDate(a.version, MIN_OPEN_AGENT), legacy: !!a.version && !semver(a.version), setup: a.setup ?? null,
  lastError: shownError(a) });
export type AgentLite = ReturnType<typeof agentCore>;

/** Lekki odczyt komputerów do /api/me i createStartJob: online, wersja, konfiguracja i (opcjonalnie) tokeny z doby, bez zużycia z 30 dni. */
export async function agentsLite(user: User, withDay = false): Promise<AgentLite[]> {
  const rows = await db.select().from(agents).where(and(eq(agents.userId, user.id), dsql`(${agents.lastSeenAt} is null or ${agents.lastSeenAt} > now() - interval '14 days')`));
  const day = withDay && rows.length ? await db.select({ agentId: agentRuns.agentId, n: dsql<number>`count(*)::int`, tokens: dsql<string>`coalesce(sum(${RUN_TOKENS}), 0)` }).from(agentRuns)
    .where(and(inArray(agentRuns.agentId, rows.map((a) => a.id)), dsql`${agentRuns.requesterId} <> ${agentRuns.ownerId}`, dsql`${agentRuns.createdAt} >= now() - interval '24 hours'`))
    .groupBy(agentRuns.agentId) : [];
  const byId = new Map(day.map((d) => [d.agentId, d]));
  return rows.map((a) => agentCore(a, byId.get(a.id)?.n ?? 0, Number(byId.get(a.id)?.tokens ?? 0)));
}

export async function myAgents(user: User) {
  // Komputer niewidziany od 14 dni znika z listy (np. odinstalowany, gdy serwer był niedostępny); dane zużycia zostają.
  const rows = await db.select().from(agents).where(and(eq(agents.userId, user.id),
    dsql`(${agents.lastSeenAt} is null or ${agents.lastSeenAt} > now() - interval '14 days')`)).orderBy(dsql`${agents.lastSeenAt} desc nulls last`);
  const repos = rows.length ? await db.select({ agentId: agentRepos.agentId, project: projects.key, path: agentRepos.path, source: agentRepos.source, status: agentRepos.status, error: agentRepos.error })
    .from(agentRepos).innerJoin(projects, eq(projects.id, agentRepos.projectId))
    .where(inArray(agentRepos.agentId, rows.map((a) => a.id))).orderBy(asc(projects.key)) : [];
  const usage = await usageByAgent(rows.map((a) => a.id));
  const day = rows.length ? await db.select({ agentId: agentRuns.agentId, n: dsql<number>`count(*)::int`, tokens: dsql<string>`coalesce(sum(${RUN_TOKENS}), 0)` }).from(agentRuns)
    .where(and(inArray(agentRuns.agentId, rows.map((a) => a.id)), dsql`${agentRuns.requesterId} <> ${agentRuns.ownerId}`, dsql`${agentRuns.createdAt} >= now() - interval '24 hours'`))
    .groupBy(agentRuns.agentId) : [];
  const others24 = new Map(day.map((d) => [d.agentId, d.n]));
  const othersTokens24 = new Map(day.map((d) => [d.agentId, Number(d.tokens)]));
  return rows.map((a) => ({ id: a.id, maxOthersTokensPerDay: a.maxOthersTokensPerDay, usage30d: usage.get(a.id)!,
    forOthers24h: others24.get(a.id) ?? 0, forOthersTokens24h: othersTokens24.get(a.id) ?? 0, limitReached24h: a.maxOthersTokensPerDay != null && (othersTokens24.get(a.id) ?? 0) >= a.maxOthersTokensPerDay, name: a.label || a.name, version: a.version, computerName: a.name, label: a.label, lastSeenAt: a.lastSeenAt, busy: a.busy, online: isOnline(a.lastSeenAt), inactive: !!a.lastSeenAt && a.lastSeenAt.getTime() < Date.now() - 3 * 864e5, outdated: !agentUpToDate(a.version), legacy: !!a.version && !semver(a.version),
    repos: repos.filter((r) => r.agentId === a.id).map(({ agentId: _, ...r }) => r),
    teamMode: a.teamMode,
    setup: a.setup ?? null,
    // Błąd starszy niż 24 h już nie jest istotny.
    // Błąd starszy niż 24 h już nie jest istotny, a chwilowy błąd połączenia (np. restart serwera przy wdrożeniu) znika, gdy komputer znów jest online.
    // Limit Claude użytkownika to stan, nie błąd: pokazujemy go osobno, tylko przez 6 godzin.
    lastError: shownError(a), lastErrorAt: a.lastErrorAt,
    claudeLimit: a.lastErrorAt && a.lastErrorAt.getTime() > Date.now() - 6 * 3600_000 && CLAUDE_LIMIT.test(a.lastError ?? '') ? a.lastError : '' }));
}


/** Tryb zleceń zespołu na komputerze: 'ask' (agent pyta właściciela), 'auto' (bierze bez pytania), 'off' (tylko własne). Tylko właściciel. */
export const TEAM_MODES = ['ask', 'auto', 'off'] as const;
export async function setTeamMode(user: User, id: string, mode: (typeof TEAM_MODES)[number]) {
  const rows = await db.update(agents).set({ teamMode: mode }).where(and(eq(agents.id, id), eq(agents.userId, user.id))).returning({ id: agents.id });
  if (!rows.length) throw new RuleError('Computer not found', 'not_found');
  return { ok: true };
}

/** Własna nazwa komputera (pusta = nazwa z Windowsa). Tylko właściciel. */
export async function renameAgent(user: User, id: string, label: string) {
  const rows = await db.update(agents).set({ label: label.trim().slice(0, 60) }).where(and(eq(agents.id, id), eq(agents.userId, user.id))).returning({ id: agents.id });
  if (!rows.length) throw new RuleError('Computer not found', 'not_found');
  return { ok: true };
}

/** Limit tokenów dla innych na dobę (null = brak). Tylko właściciel. */
export async function setAgentLimit(user: User, id: string, max: number | null) {
  const rows = await db.update(agents).set({ maxOthersTokensPerDay: max }).where(and(eq(agents.id, id), eq(agents.userId, user.id))).returning({ id: agents.id });
  if (!rows.length) throw new RuleError('Computer not found', 'not_found');
  return { ok: true };
}

export async function removeAgent(user: User, id: string) {
  const gone = await db.delete(agents).where(and(eq(agents.id, id), eq(agents.userId, user.id))).returning({ id: agents.id });
  if (gone.length) {
    // Agent traci dostęp: odwołujemy jego grant OAuth i kasujemy klucz trk_ wystawiony przy parowaniu dla tego komputera.
    await db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.agentId, id), eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt)));
    await db.delete(apiTokens).where(and(eq(apiTokens.agentId, id), eq(apiTokens.userId, user.id)));
  }
  if (gone.length) await db.insert(agentTombstones).values({ id, userId: user.id }).onConflictDoUpdate({ target: agentTombstones.id, set: { deletedAt: new Date() } });
  return { ok: true };
}

/**
 * Komputery członków projektu z działającym repo (kolejka zespołu) albo online. `teamMode`: 'ask' | 'auto' | 'off', czyli
 * czy właściciel bierze zlecenia kolegów (z pytaniem, bez pytania, wcale).
 */
export async function projectAgents(p: Project) {
  const rows = await db.select({ id: agents.id, name: dsql<string>`coalesce(nullif(${agents.label}, ''), ${agents.name})`, owner: users.name, busy: agents.busy,
    teamMode: agents.teamMode, online: dsql<boolean>`${agents.lastSeenAt} > now() - make_interval(secs => ${ONLINE_MS / 1000})` })
    .from(agents).innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(projectMembers, and(eq(projectMembers.userId, agents.userId), eq(projectMembers.projectId, p.id)))
    .where(dsql`(${agents.lastSeenAt} > now() - make_interval(secs => ${ONLINE_MS / 1000}) or exists (select 1 from agent_repos r where r.agent_id = ${agents.id} and r.project_id = ${p.id} and r.status = 'ok'))`).orderBy(asc(agents.name));
  const usage = await usageByAgent(rows.map((r) => r.id), p.id);
  return rows.map(({ id, online, ...r }) => ({ ...r, busy: r.busy && online, usage30d: usage.get(id)! }));
}

/**
 * "Start on my PC" z telefonu: zlecenie dla agenta (otworzy VS Code z poleceniem) plus to samo przypisanie i przesunięcie
 * do In Progress, co robi startWork() w aplikacji, bo na telefonie nikt tego nie zrobi po stronie przeglądarki.
 */
export async function createStartJob(p: Project, user: NonNullable<Actor>, number: number) {
  const mine = await agentsLite(user);
  if (!mine.some((a) => a.online)) throw new RuleError('Your PC is offline', 'invalid');
  // Stary agent nie dostaje pracy, więc zlecenie by tylko wisiało.
  if (!mine.some((a) => a.online && !a.outdated)) throw new RuleError('The agent on this PC is outdated: update it (Settings › My AI)', 'outdated');
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
const CLIENT_FRESH_MS = 14 * 864e5;
export async function aiStatus(user: User, mine?: AgentLite[]) {
  // Klient liczy się, gdy był używany w ostatnich 14 dniach (nieużywany token albo grant nie dowodzi działającego połączenia).
  const recent = new Date(Date.now() - CLIENT_FRESH_MS).toISOString();
  const [grant] = await db.select({ name: oauthClients.name, at: oauthGrants.firstMcpAt }).from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt), NOT_AGENT_CLIENT, dsql`${oauthGrants.firstMcpAt} is not null`,
      dsql`greatest(${oauthGrants.lastUsedAt}, ${oauthGrants.firstMcpAt}) > ${recent}::timestamptz`))
    .orderBy(dsql`${oauthGrants.firstMcpAt} desc`).limit(1);
  const [token] = grant ? [] : await db.select({ at: apiTokens.lastUsedAt }).from(apiTokens)
    .where(and(eq(apiTokens.userId, user.id), dsql`${apiTokens.lastUsedAt} > ${recent}::timestamptz`)).orderBy(dsql`${apiTokens.lastUsedAt} desc`).limit(1);
  const [wl] = await db.select({ id: activity.id }).from(activity)
    .where(and(eq(activity.actorId, user.id), dsql`${activity.payload}->>'kind' = 'worklog'`, dsql`${activity.createdAt} > ${recent}::timestamptz`)).limit(1);
  const computers = mine ?? await agentsLite(user, true);
  // Stan z plików konfiguracji, zgłoszony przez agenta (aktywne komputery): pewniejszy niż ślady użycia i widoczny od razu
  // po instalacji. Bez agenta (np. tylko Cursor) zostają ślady użycia z 14 dni.
  const reported = computers.filter((a) => !a.inactive && a.setup).map((a) => a.setup!);
  const setupMcp = reported.some((s) => s.claude.some((c) => c.mcp));
  const setupClient = setupMcp ? 'Claude Code' : reported.some((s) => s.codex) ? 'Codex' : reported.some((s) => s.cursor) ? 'Cursor' : null;
  const client = !!grant || !!token || !!setupClient;
  // Stan osobno dla każdego klienta (kreator pokazuje stan wybranego, nie "jakiegokolwiek").
  const grants = await db.select({ name: oauthClients.name, at: oauthGrants.firstMcpAt }).from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .where(and(eq(oauthGrants.userId, user.id), isNull(oauthGrants.revokedAt), NOT_AGENT_CLIENT, dsql`${oauthGrants.firstMcpAt} is not null`,
      dsql`greatest(${oauthGrants.lastUsedAt}, ${oauthGrants.firstMcpAt}) > ${recent}::timestamptz`));
  const tokens = await db.select({ name: apiTokens.name, at: apiTokens.lastUsedAt }).from(apiTokens)
    .where(and(eq(apiTokens.userId, user.id), dsql`${apiTokens.lastUsedAt} > ${recent}::timestamptz`));
  const kind = (name: string) => /cursor/i.test(name) ? 'Cursor' : /codex/i.test(name) ? 'Codex' : 'Claude Code';
  const clients: Record<'Claude Code' | 'Codex' | 'Cursor', { connected: boolean; at: Date | null }> = {
    'Claude Code': { connected: setupMcp, at: null }, Codex: { connected: reported.some((s) => s.codex), at: null }, Cursor: { connected: reported.some((s) => s.cursor), at: null },
  };
  for (const r of [...grants, ...tokens]) {
    const c = clients[kind(r.name)];
    c.connected = true;
    if (r.at && (!c.at || r.at > c.at)) c.at = r.at;
  }
  const workTrace = reported.length ? reported.some((s) => s.claude.some((c) => c.plugin)) : !!wl;
  // Co wymaga sprawdzenia (kółko przy Settings, AI i konkretnym komputerze).
  const attention: string[] = [];
  if (!client) attention.push('connect');
  if (computers.some((a) => a.limitReached24h)) attention.push('limit');
  if (computers.some((a) => a.maxOthersTokensPerDay == null && a.forOthersTokens24h >= 2_000_000)) attention.push('busy-for-others');
  if (computers.some((a) => a.lastError)) attention.push('agent-error');
  if (computers.some((a) => a.legacy)) attention.push('legacy');
  return {
    attention,
    client,
    clientName: grant ? grant.name : token ? 'Claude Code' : setupClient,
    clientAt: grant?.at ?? token?.at ?? null,
    workTrace,
    clients,
    agent: computers.some((a) => a.online && !a.outdated),
  };
}
