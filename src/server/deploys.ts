import type { FastifyInstance } from 'fastify';
import { requireUser } from './auth.ts';
import { publish } from './service.ts';
import { recordDeploy } from './hooks.ts';
import { requireMember, type Project } from './projects.ts';
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

/** Ostatni znany deploy każdego projektu (po id projektu). */
const current = new Map<number, DeployStatus>();

export function deployStatusOf(projectId: number) {
  return current.get(projectId) ?? null;
}

/** Każde źródło (webhook, GitHub, Coolify) zgłasza deploy tutaj: stan na pasku, zdarzenie SSE, a po sukcesie znacznik Deployed w zgłoszeniach. */
export async function reportDeploy(p: Project, next: NonNullable<DeployStatus>, log?: { warn: (o: unknown, m: string) => void }) {
  const prev = current.get(p.id);
  current.set(p.id, next);
  if (JSON.stringify(prev ?? null) !== JSON.stringify(next)) await publish({ type: 'deploy', projectKey: p.key });
  // recordDeploy jest idempotentny po sha, więc powtórne zgłoszenie tego samego deployu niczego nie psuje.
  if (next.status === 'finished' && next.commit && (!prev || prev.status !== 'finished' || prev.commit !== next.commit)) {
    await recordDeploy(p, next.commit).catch((e) => log?.warn(e, 'recordDeploy failed'));
  }
}

export async function registerDeploys(app: FastifyInstance) {
  app.get('/api/deploy-status', { preHandler: requireUser }, async (req) => {
    const { project } = await requireMember(req.user!, projectKeyOf(req));
    return { enabled: !!project.deploySource && (project.deploySource !== 'coolify' || coolifyConfigured()), deploy: deployStatusOf(project.id) };
  });
}
