import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { projects } from '../db/schema.ts';
import { github } from './hooks.ts';
import { listAllProjects } from './projects.ts';
import { reportDeploy, type DeployStatus } from './deploys.ts';

/**
 * Opcjonalne źródło deployów: Coolify (projekt z deploySource = 'coolify', uuid aplikacji w deploySourceRef).
 * Coolify nie wysyła zdarzenia "deploy started", więc co kilkanaście sekund pytamy jego API. Token jest jeden na serwer.
 */
const API = process.env.COOLIFY_API_URL;
const TOKEN = process.env.COOLIFY_API_TOKEN;
export const coolifyConfigured = () => !!(process.env.COOLIFY_API_URL && process.env.COOLIFY_API_TOKEN);

function safeEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

/** Autor commita z GitHuba (Coolify go nie podaje); po SHA, bo commit się nie zmienia. */
const authors = new Map<string, string | null>();
async function authorOf(repo: string, sha: string | null) {
  if (!repo || !sha) return null;
  if (!authors.has(sha)) {
    const c = (await github(`/repos/${repo}/commits/${sha}`).catch(() => null)) as { author?: { login?: string } | null; commit?: { author?: { name?: string } } } | null;
    authors.set(sha, c?.author?.login ?? c?.commit?.author?.name ?? null);
  }
  return authors.get(sha) ?? null;
}

async function pollProject(p: typeof projects.$inferSelect, log: FastifyInstance['log']) {
  try {
    const res = await fetch(`${API}/api/v1/deployments/applications/${p.deploySourceRef}?skip=0&take=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`Coolify ${res.status}`);
    const { deployments } = (await res.json()) as { deployments: { status: string; created_at: string; updated_at: string; commit: string | null; commit_message: string | null }[] };
    const d = deployments[0];
    if (!d) return;
    const status = (['queued', 'in_progress', 'finished', 'failed', 'cancelled'].includes(d.status) ? d.status : d.status.startsWith('cancel') ? 'cancelled' : 'unknown') as NonNullable<DeployStatus>['status'];
    await reportDeploy(p, {
      status,
      startedAt: d.created_at,
      finishedAt: status === 'finished' || status === 'failed' ? d.updated_at : null,
      commit: d.commit,
      message: d.commit_message?.split('\n')[0] ?? null,
      author: await authorOf(p.githubRepo, d.commit),
    }, log);
  } catch (e) {
    log.warn({ err: (e as Error).message, project: p.key }, 'deploy status poll failed');
  }
}

async function poll(log: FastifyInstance['log']) {
  for (const p of await listAllProjects()) if (p.deploySource === 'coolify' && p.deploySourceRef) await pollProject(p, log);
}

export async function registerCoolify(app: FastifyInstance) {
  app.register(async (r) => {
    // Surowe body jako Buffer, jak w pozostałych webhookach.
    r.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    // Webhook z powiadomień Coolify. Sekret w query (?secret=), bo Coolify nie podpisuje żądań.
    r.post<{ Querystring: { secret?: string } }>('/hooks/coolify', async (req, reply) => {
      const secret = process.env.COOLIFY_WEBHOOK_SECRET;
      const given = (req.headers['x-webhook-secret'] as string | undefined) ?? req.query.secret ?? '';
      if (!secret || !safeEqual(given, secret)) return reply.code(401).send({ error: 'Bad secret' });
      const body = JSON.parse((req.body as Buffer).toString('utf8') || '{}') as Record<string, unknown>;
      const text = JSON.stringify(body).toLowerCase();
      if (!/success/.test(String(body.event ?? body.type ?? text))) return { ignored: true };
      // Powiadomienia Coolify przychodzą dla wszystkich aplikacji na serwerze (też trackera i innych stron).
      // Projekt rozpoznajemy po uuid jego aplikacji; bez dopasowania nic nie oznaczamy.
      const p = (await listAllProjects()).find((x) => x.deploySource === 'coolify' && x.githubRepo && x.deploySourceRef
        && text.includes(x.deploySourceRef.toLowerCase()));
      if (!p) return { ignored: true };
      // Coolify nie zawsze podaje SHA, więc bierzemy aktualny HEAD deployowanej gałęzi.
      const sha = typeof body.commit === 'string' && /^[0-9a-f]{7,40}$/.test(body.commit)
        ? body.commit
        : ((await github(`/repos/${p.githubRepo}/commits/${p.deployBranch}`)) as { sha: string }).sha;
      const now = new Date().toISOString();
      await reportDeploy(p, { status: 'finished', startedAt: now, finishedAt: now, commit: sha, message: null, author: await authorOf(p.githubRepo, sha) }, app.log);
      return { sha };
    });
  });

  if (!coolifyConfigured()) return;
  await poll(app.log);
  const t = setInterval(() => void poll(app.log), 15_000);
  app.addHook('onClose', async () => clearInterval(t));
}
