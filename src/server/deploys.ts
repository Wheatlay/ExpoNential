import type { FastifyInstance } from 'fastify';
import { requireUser } from './auth.ts';
import { publish } from './service.ts';
import { recordDeploy } from './hooks.ts';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { deployEnvs } from '../db/schema.ts';
import { requireMember, canManage, type Project } from './projects.ts';
import { RuleError } from './rules.ts';
import { projectKeyOf } from './api.ts';
import { coolifyConfigured } from './coolify.ts';

/** Stan ostatniego deployu projektu, niezależnie od tego, skąd o nim wiemy (webhook, GitHub, Coolify). */
export type DeployStatus = {
  status: 'queued' | 'in_progress' | 'finished' | 'failed' | 'cancelled' | 'unknown';
  startedAt: string | null;
  finishedAt: string | null;
  commit: string | null;
  message: string | null;
  author: string | null;
} | null;

export type DeployEnvRow = typeof deployEnvs.$inferSelect;

/** Ostatni znany deploy każdego projektu i środowiska (klucz ${projectId}:${envId}). */
const current = new Map<string, DeployStatus>();

export function deployStatusOf(projectId: number, envId: number) {
  return current.get(`${projectId}:${envId}`) ?? null;
}

export async function listDeployEnvs(projectId: number) {
  return db.select().from(deployEnvs).where(eq(deployEnvs.projectId, projectId)).orderBy(asc(deployEnvs.position), asc(deployEnvs.id));
}

/**
 * Środowisko po nazwie (bez względu na wielkość liter). Bez nazwy: jedyne produkcyjne, a gdy takiego nie ma, jedyne w ogóle;
 * przy wielu kandydatach nazwa jest wymagana. Brak środowisk = undefined (deploy ignorujemy).
 */
export async function findDeployEnv(projectId: number, name?: string) {
  const envs = await listDeployEnvs(projectId);
  if (name) return envs.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const prod = envs.filter((e) => e.isProduction);
  if (prod.length === 1) return prod[0];
  if (envs.length === 1) return envs[0];
  if (envs.length) throw new RuleError(`Specify env: one of ${envs.map((e) => e.name).join(', ')}`, 'invalid');
  return undefined;
}

export type DeployEnvInput = { id?: number; name: string; sourceRef: string; isProduction: boolean };

/** Zastępuje listę środowisk projektu (kolejność = position): zmienia istniejące, dodaje nowe, kasuje brakujące. */
export async function saveDeployEnvs(p: Project, input: DeployEnvInput[]) {
  const envs = input.map((e) => ({ ...e, name: e.name.trim(), sourceRef: e.sourceRef.trim() }));
  if (envs.some((e) => !e.name || e.name.length > 30)) throw new RuleError('Environment name must be 1-30 characters', 'invalid');
  if (envs.length) {
    const prod = envs.filter((e) => e.isProduction).length;
    if (prod === 0) envs[0].isProduction = true;
    else if (prod > 1) throw new RuleError('Exactly one environment must be production', 'invalid');
  }
  if (new Set(envs.map((e) => e.name.toLowerCase())).size !== envs.length) throw new RuleError('Environment names must be unique', 'invalid');
  await db.transaction(async (tx) => {
    const old = await tx.select().from(deployEnvs).where(eq(deployEnvs.projectId, p.id));
    const oldIds = new Set(old.map((e) => e.id));
    if (envs.some((e) => e.id != null && !oldIds.has(e.id))) throw new RuleError('Unknown environment', 'invalid');
    const keep = new Set(envs.flatMap((e) => (e.id != null ? [e.id] : [])));
    for (const o of old) if (!keep.has(o.id)) await tx.delete(deployEnvs).where(eq(deployEnvs.id, o.id));
    // Najpierw nazwy tymczasowe, żeby zamiana nazw dwóch środowisk nie łamała unikalnego indeksu.
    for (const e of envs) if (e.id != null) await tx.update(deployEnvs).set({ name: `__${e.id}` }).where(eq(deployEnvs.id, e.id));
    for (const [position, e] of envs.entries()) {
      const v = { name: e.name, sourceRef: e.sourceRef, position, isProduction: e.isProduction };
      if (e.id != null) await tx.update(deployEnvs).set(v).where(and(eq(deployEnvs.id, e.id), eq(deployEnvs.projectId, p.id)));
      else await tx.insert(deployEnvs).values({ projectId: p.id, ...v });
    }
  });
  await publish({ type: 'deploy', projectKey: p.key });
  await publish({ type: 'projects' });
  return listDeployEnvs(p.id);
}

/** Każde źródło (webhook, GitHub, Coolify) zgłasza deploy tutaj: stan na pasku, zdarzenie SSE, a po sukcesie znacznik Deployed w zgłoszeniach. */
export async function reportDeploy(p: Project, next: NonNullable<DeployStatus>, log: { warn: (o: unknown, m: string) => void } | undefined, env: DeployEnvRow) {
  const key = `${p.id}:${env.id}`;
  const prev = current.get(key);
  current.set(key, next);
  if (JSON.stringify(prev ?? null) !== JSON.stringify(next)) await publish({ type: 'deploy', projectKey: p.key });
  // recordDeploy jest idempotentny po sha, więc powtórne zgłoszenie tego samego deployu niczego nie psuje.
  if (next.status === 'finished' && next.commit && (!prev || prev.status !== 'finished' || prev.commit !== next.commit)) {
    await recordDeploy(p, next.commit, env).catch((e) => log?.warn(e, 'recordDeploy failed'));
  }
}

export async function registerDeploys(app: FastifyInstance) {
  app.get('/api/deploy-status', { preHandler: requireUser }, async (req) => {
    const { project } = await requireMember(req.user!, projectKeyOf(req));
    const envs = await listDeployEnvs(project.id);
    return {
      enabled: !!project.deploySource && (project.deploySource !== 'coolify' || coolifyConfigured()),
      envs: envs.map((e) => ({ id: e.id, name: e.name, isProduction: e.isProduction, deploy: deployStatusOf(project.id, e.id) })),
    };
  });

  const envsBody = z.object({ envs: z.array(z.object({ id: z.number().int().optional(), name: z.string(), sourceRef: z.string().max(200), isProduction: z.boolean() })).max(20) });
  app.get('/api/deploy-envs', { preHandler: requireUser }, async (req) => {
    const { project, role } = await requireMember(req.user!, projectKeyOf(req));
    if (!canManage(req.user!, role)) throw new RuleError('Project admin only', 'forbidden');
    return listDeployEnvs(project.id);
  });
  app.put('/api/deploy-envs', { preHandler: requireUser }, async (req) => {
    const { project, role } = await requireMember(req.user!, projectKeyOf(req));
    if (!canManage(req.user!, role)) throw new RuleError('Project admin only', 'forbidden');
    return saveDeployEnvs(project, envsBody.parse(req.body).envs);
  });
}
