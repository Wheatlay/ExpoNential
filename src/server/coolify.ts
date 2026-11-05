import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { projects } from '../db/schema.ts';
import { github } from './hooks.ts';
import { listAllProjects } from './projects.ts';
import { reportDeploy, listDeployEnvs, ensureDeployEnv, type DeployEnvRow, type DeployStatus } from './deploys.ts';

/**
 * Opcjonalne źródło deployów: Coolify (środowiska ze źródłem 'coolify', uuid aplikacji w sourceRef; aplikacje budowane z repo projektu wykrywamy same).
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

/** Gałąź, z której Coolify buduje aplikację (git_branch); każde środowisko ma swoją aplikację, więc i swoją gałąź. */
async function appBranch(uuid: string) {
  const res = await fetch(`${API}/api/v1/applications/${encodeURIComponent(uuid)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`Coolify ${res.status}`);
  const { git_branch: branch } = (await res.json()) as { git_branch?: string };
  if (!branch) throw new Error('Coolify app has no git branch');
  return branch;
}

async function pollProject(p: typeof projects.$inferSelect, env: DeployEnvRow, log: FastifyInstance['log']) {
  try {
    const res = await fetch(`${API}/api/v1/deployments/applications/${encodeURIComponent(env.sourceRef)}?skip=0&take=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
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
    }, log, env);
  } catch (e) {
    log.warn({ err: (e as Error).message, project: p.key, env: env.name }, 'deploy status poll failed');
  }
}

async function poll(log: FastifyInstance['log']) {
  for (const p of await listAllProjects()) {
    for (const env of await listDeployEnvs(p.id)) if (env.source === 'coolify' && env.sourceRef) await pollProject(p, env, log);
  }
}

/** "https://github.com/Owner/Name.git" / "git@github.com:Owner/Name" -> "owner/name". */
export function normalizeRepo(r: string) {
  return r.trim().replace(/^(https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** Aplikacje Coolify zbudowane z repo projektu stają się jego środowiskami (uuid użyty już w innym projekcie pomijamy). */
export async function discoverCoolifyApps(log: FastifyInstance['log']) {
  if (!coolifyConfigured()) return;
  try {
    const res = await fetch(`${API}/api/v1/applications`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`Coolify ${res.status}`);
    const apps = (await res.json()) as { uuid?: string; name?: string; git_repository?: string; git_branch?: string }[];
    const projects = await listAllProjects();
    const owned = new Map<string, number>();
    for (const x of projects) for (const e of await listDeployEnvs(x.id)) if (e.source === 'coolify') owned.set(e.sourceRef.toLowerCase(), x.id);
    for (const a of apps) {
      if (!a.uuid || !a.git_repository) continue;
      const repo = normalizeRepo(a.git_repository);
      for (const p of projects) {
        if (!p.githubRepo || p.githubRepo.toLowerCase() !== repo) continue;
        const other = owned.get(a.uuid.toLowerCase());
        if (other != null && other !== p.id) continue;
        const env = await ensureDeployEnv(p, { source: 'coolify', ref: a.uuid, name: a.name || 'Production', production: a.git_branch === 'main' || a.git_branch === 'master' });
        if (env) owned.set(a.uuid.toLowerCase(), p.id);
      }
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, 'coolify app discovery failed');
  }
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
      let p: Awaited<ReturnType<typeof listAllProjects>>[number] | undefined;
      let env: DeployEnvRow | undefined;
      for (const x of await listAllProjects()) {
        if (!x.githubRepo) continue;
        env = (await listDeployEnvs(x.id)).find((e) => e.source === 'coolify' && e.sourceRef && text.includes(e.sourceRef.toLowerCase()));
        if (env) { p = x; break; }
      }
      if (!p || !env) return { ignored: true };
      // Coolify nie zawsze podaje SHA: bierzemy HEAD gałęzi, z której buduje się aplikacja TEGO środowiska (prod i stage mają różne).
      let sha: string | null = typeof body.commit === 'string' && /^[0-9a-f]{7,40}$/.test(body.commit) ? body.commit : null;
      if (!sha && coolifyConfigured()) {
        try { sha = ((await github(`/repos/${p.githubRepo}/commits/${encodeURIComponent(await appBranch(env.sourceRef))}`)) as { sha: string }).sha; }
        catch (e) { app.log.warn(e, 'coolify webhook: no sha'); }
      }
      const now = new Date().toISOString();
      await reportDeploy(p, { status: 'finished', startedAt: now, finishedAt: now, commit: sha, message: null, author: await authorOf(p.githubRepo, sha) }, app.log, env);
      return { sha };
    });
  });

  if (!coolifyConfigured()) return;
  await discoverCoolifyApps(app.log);
  await poll(app.log);
  const t = setInterval(() => void poll(app.log), 15_000);
  const d = setInterval(() => void discoverCoolifyApps(app.log), 10 * 60_000);
  app.addHook('onClose', async () => { clearInterval(t); clearInterval(d); });
}
