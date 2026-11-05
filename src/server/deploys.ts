import type { FastifyInstance } from 'fastify';
import { requireUser } from './auth.ts';
import { publish } from './service.ts';
import { recordDeploy } from './hooks.ts';
import { and, asc, eq, ne, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { deployEnvs, projects as projectsTable } from '../db/schema.ts';
import { requireMember, canManage, type Project } from './projects.ts';
import { RuleError } from './rules.ts';
import { projectKeyOf } from './api.ts';
import { sendDiscord } from './notify.ts';
import { st } from './i18n.ts';

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

/** Uuid aplikacji Coolify (cuid2 w nowszych wersjach: litery i cyfry, 8-40 znaków; starsze: UUID z myślnikami). */
const COOLIFY_UUID = /^[a-z0-9][a-z0-9-]{7,39}$/i;

export type DeployEnvInput = { id?: number; name: string; sourceRef: string; isProduction: boolean; source?: string };

/** Zastępuje listę środowisk projektu (kolejność = position): zmienia istniejące, dodaje nowe, kasuje brakujące. */
export async function saveDeployEnvs(p: Project, input: DeployEnvInput[]) {
  const before = await listDeployEnvs(p.id);
  // Źródło należy do istniejącego wiersza (klient go nie ustawia); nowe ręczne wiersze mają ''.
  const envs = input.map((e) => ({ ...e, name: e.name.trim(), sourceRef: e.sourceRef.trim(), source: before.find((o) => o.id === e.id)?.source ?? '' }));
  if (envs.some((e) => !e.name || e.name.length > 30)) throw new RuleError('Environment name must be 1-30 characters', 'invalid');
  if (envs.length) {
    const prod = envs.filter((e) => e.isProduction).length;
    if (prod === 0) envs[0].isProduction = true;
    else if (prod > 1) throw new RuleError('Exactly one environment must be production', 'invalid');
  }
  if (new Set(envs.map((e) => e.name.toLowerCase())).size !== envs.length) throw new RuleError('Environment names must be unique', 'invalid');
  {
    // sourceRef to uuid aplikacji Coolify: bez formatu i unikalności dałoby się podpiąć cudzą aplikację z tego samego serwera.
    const cool = envs.filter((e) => e.source === 'coolify');
    if (cool.some((e) => e.sourceRef && !COOLIFY_UUID.test(e.sourceRef))) throw new RuleError('Coolify application UUID expected', 'invalid');
    const refs = cool.map((e) => e.sourceRef.toLowerCase()).filter(Boolean);
    if (new Set(refs).size !== refs.length) throw new RuleError('Coolify application is used twice', 'invalid');
    for (const ref of refs) {
      const [dup] = await db.select({ id: deployEnvs.id }).from(deployEnvs)
        .where(and(ne(deployEnvs.projectId, p.id), dsql`lower(${deployEnvs.sourceRef}) = ${ref} and ${deployEnvs.source} = 'coolify'`)).limit(1);
      if (dup) throw new RuleError('This Coolify application is already used by another project', 'invalid');
    }
  }
  await db.transaction(async (tx) => {
    const old = await tx.select().from(deployEnvs).where(eq(deployEnvs.projectId, p.id));
    const oldIds = new Set(old.map((e) => e.id));
    if (envs.some((e) => e.id != null && !oldIds.has(e.id))) throw new RuleError('Unknown environment', 'invalid');
    const keep = new Set(envs.flatMap((e) => (e.id != null ? [e.id] : [])));
    const ignored: string[] = [];
    for (const o of old) if (!keep.has(o.id)) {
      await tx.delete(deployEnvs).where(eq(deployEnvs.id, o.id));
      // Usunięte środowisko z automatu nie wraca przy kolejnym zdarzeniu.
      if (o.source) ignored.push(`${o.source}:${o.sourceRef}`.toLowerCase());
    }
    if (ignored.length) {
      const [cur] = await tx.select({ ignored: projectsTable.deployIgnored }).from(projectsTable).where(eq(projectsTable.id, p.id));
      await tx.update(projectsTable).set({ deployIgnored: [...new Set([...(cur?.ignored ?? []), ...ignored])] }).where(eq(projectsTable.id, p.id));
    }
    // Najpierw nazwy tymczasowe, żeby zamiana nazw dwóch środowisk nie łamała unikalnego indeksu.
    for (const e of envs) if (e.id != null) await tx.update(deployEnvs).set({ name: `__${e.id}` }).where(eq(deployEnvs.id, e.id));
    for (const [position, e] of envs.entries()) {
      const v = { name: e.name, sourceRef: e.sourceRef, source: e.source, position, isProduction: e.isProduction };
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
  // Nieudany deploy: jedna wiadomość na kanał Discord projektu na przejście (to samo zgłoszenie 'failed' drugi raz niczego nie wysyła).
  if (next.status === 'failed' && (!prev || prev.status !== 'failed' || prev.commit !== next.commit)) {
    await sendDiscord(p, { title: st('Deploy failed: {env} {commit}', { env: env.name, commit: (next.commit ?? '').slice(0, 7) }).trim(), description: next.message?.split('\n')[0] || p.name, color: 0xeb5757 }, log as { warn: (o: object, m: string) => void } | undefined)
      .catch((e) => log?.warn(e, 'discord deploy failed message failed'));
  }
  // recordDeploy jest idempotentny po sha, więc powtórne zgłoszenie tego samego deployu niczego nie psuje.
  if (next.status === 'finished' && next.commit && (!prev || prev.status !== 'finished' || prev.commit !== next.commit)) {
    await recordDeploy(p, next.commit, env).catch((e) => log?.warn(e, 'recordDeploy failed'));
  }
}

/**
 * Środowisko z automatu (pierwsze zdarzenie ze źródła): znajduje po źródle i ref, albo po nazwie (ręczne dostaje źródło),
 * albo tworzy nowe. Źródła usunięte przez admina (deployIgnored) nie wracają: undefined.
 */
export async function ensureDeployEnv(p: Project, o: { source: string; ref: string; name: string; production?: boolean }) {
  const envs = await listDeployEnvs(p.id);
  const ref = o.ref.trim();
  const byRef = envs.find((e) => e.source === o.source && e.sourceRef.toLowerCase() === ref.toLowerCase());
  if (byRef) return byRef;
  // Środowisko sprzed 1.3.24 z tym źródłem, ale bez ref (dawniej "jedyne produkcyjne"): jedno takie przejmuje ref, zamiast dublować.
  const blank = envs.filter((e) => e.source === o.source && !e.sourceRef);
  const byName = envs.find((e) => e.name.toLowerCase() === o.name.trim().toLowerCase() && (e.source === '' || e.source === o.source))
    ?? (blank.length === 1 ? blank[0] : undefined);
  if (byName) {
    const [row] = await db.update(deployEnvs).set({ source: o.source, sourceRef: ref }).where(eq(deployEnvs.id, byName.id)).returning();
    await publish({ type: 'deploy', projectKey: p.key });
    await publish({ type: 'projects' });
    return row;
  }
  // Projekt z pamięci podręcznej może mieć stare deployIgnored, więc czytamy świeże.
  const [fresh] = await db.select({ ignored: projectsTable.deployIgnored }).from(projectsTable).where(eq(projectsTable.id, p.id));
  if ((fresh?.ignored ?? p.deployIgnored).includes(`${o.source}:${ref}`.toLowerCase())) return undefined;
  if (envs.length >= 20) return undefined; // jak limit ręcznego zapisu: webhook z sekretem nie namnoży środowisk
  const base = o.name.trim().slice(0, 26) || 'Env';
  const taken = new Set(envs.map((e) => e.name.toLowerCase()));
  let name = base.slice(0, 30);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  const [row] = await db.insert(deployEnvs).values({
    projectId: p.id, name, source: o.source, sourceRef: ref, position: envs.reduce((m, e) => Math.max(m, e.position), -1) + 1,
    isProduction: envs.length === 0 || (o.production === true && !envs.some((e) => e.isProduction)),
  }).returning();
  await publish({ type: 'deploy', projectKey: p.key });
  await publish({ type: 'projects' });
  return row;
}

export async function registerDeploys(app: FastifyInstance) {
  app.get('/api/deploy-status', { preHandler: requireUser }, async (req) => {
    const { project } = await requireMember(req.user!, projectKeyOf(req));
    const envs = await listDeployEnvs(project.id);
    return {
      enabled: envs.length > 0,
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
