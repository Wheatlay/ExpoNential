import { and, eq, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { agents, issues } from '../db/schema.ts';
import { RuleError, identifier } from './rules.ts';
import { analysisModel } from './prompts.ts';
import { log, publish, type Actor, type Project } from './service.ts';

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
