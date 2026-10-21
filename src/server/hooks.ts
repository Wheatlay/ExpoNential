import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { activity, deploys, issueCommits, issues, projects } from '../db/schema.ts';
import { extractIssueRefs, identifier } from './rules.ts';
import { publish } from './service.ts';
import { z } from 'zod';
import { getProjectByKey, listAllProjects, type Project } from './projects.ts';
import { reportDeploy, type DeployStatus } from './deploys.ts';

type GhCommit = { id: string; message: string; url: string; timestamp: string; author: { name: string; username?: string } };

function safeEqual(a: string, b: string) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }

export function verifyGithubSignature(secret: string, raw: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/**
 * Zapisuje commity z identyfikatorami KEY-n w aktywności zadań. Projekt z ustawionym repo przyjmuje commity
 * tylko z niego (commit in another repo with "WEB-3" in its message nie trafi do WEB). Zwraca identyfikatory dotkniętych zadań.
 */
export async function recordCommits(commits: GhCommit[], repo: string | null) {
  const all = await db.select({ id: projects.id, key: projects.key, githubRepo: projects.githubRepo }).from(projects);
  const accepts = all.filter((p) => !p.githubRepo || (repo && p.githubRepo.toLowerCase() === repo.toLowerCase()));
  const idByKey = new Map(accepts.map((p) => [p.key, p.id]));
  const touched = new Map<string, { projectKey: string; number: number }>();
  for (const c of commits) {
    for (const ref of extractIssueRefs(c.message, [...idByKey.keys()])) {
      const [row] = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.projectId, idByKey.get(ref.key)!), eq(issues.number, ref.number)));
      if (!row) continue;
      const inserted = await db.insert(issueCommits).values({
        issueId: row.id, sha: c.id, message: c.message, url: c.url,
        author: c.author.username ?? c.author.name, committedAt: new Date(c.timestamp),
      }).onConflictDoNothing().returning();
      if (!inserted.length) continue; // ten sam commit po force-push/rebase innej gałęzi
      await db.insert(activity).values({
        issueId: row.id, actorId: null, createdAt: new Date(c.timestamp),
        payload: { kind: 'commit', sha: c.id, message: c.message.split('\n')[0], url: c.url, author: c.author.username ?? c.author.name },
      });
      touched.set(identifier(ref.key, ref.number), { projectKey: ref.key, number: ref.number });
    }
  }
  for (const t of touched.values()) await publish({ type: 'issue', ...t });
  return [...touched.keys()];
}

export async function github(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      'User-Agent': 'tracker', Accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_API_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_API_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
  return res.json();
}

/**
 * Udany deploy: commity od poprzedniego deployu dostają deployed_at, a ich zadania wpis "Deployed".
 * Status zadania się nie zmienia (decyzja zespołu).
 */
export async function recordDeploy(p: Project, sha: string) {
  if (!p.githubRepo) return [];
  const [prev] = await db.select().from(deploys).where(eq(deploys.projectId, p.id)).orderBy(desc(deploys.at)).limit(1);
  if (prev?.sha === sha) return [];
  let shas: string[] = [sha];
  if (prev) {
    try {
      const cmp = (await github(`/repos/${p.githubRepo}/compare/${prev.sha}...${sha}`)) as { commits: { sha: string }[]; total_commits?: number };
      // Compare zwraca najwyżej 250 commitów; ponad to oznaczamy tylko bieżący.
      if ((cmp.total_commits ?? cmp.commits.length) <= 250) shas = cmp.commits.map((c) => c.sha);
    } catch {
      // Poprzedni SHA zniknął (force-push): zapisujemy deploy mimo to, inaczej każdy kolejny też by padł.
    }
  }
  await db.insert(deploys).values({ projectId: p.id, sha });
  if (!shas.length) return [];

  const now = new Date();
  const rows = await db.update(issueCommits).set({ deployedAt: now })
    .where(and(inArray(issueCommits.sha, shas), isNull(issueCommits.deployedAt),
      inArray(issueCommits.issueId, db.select({ id: issues.id }).from(issues).where(eq(issues.projectId, p.id)))))
    .returning({ issueId: issueCommits.issueId });
  const issueIds = [...new Set(rows.map((r) => r.issueId))];
  const touched: string[] = [];
  for (const issueId of issueIds) {
    await db.insert(activity).values({ issueId, actorId: null, createdAt: now, payload: { kind: 'deploy', sha } });
    const [i] = await db.select({ number: issues.number, projectKey: projects.key }).from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId)).where(eq(issues.id, issueId));
    touched.push(identifier(i.projectKey, i.number));
    await publish({ type: 'issue', projectKey: i.projectKey, number: i.number });
  }
  return touched;
}

export const deployHookBody = z.object({
  project: z.string().min(1), sha: z.string().min(1).max(100),
  status: z.enum(['queued', 'in_progress', 'finished', 'failed']).default('finished'),
  message: z.string().max(500).optional(), author: z.string().max(200).optional(),
});

type Log = { warn: (o: unknown, m: string) => void };

/** Deploy zgłoszony ogólnym webhookiem: projekt musi mieć źródło "webhook". */
export async function reportDeployHook(body: z.infer<typeof deployHookBody>, log?: Log): Promise<{ code: number; body: Record<string, unknown> }> {
  const p = await getProjectByKey(body.project);
  if (!p) return { code: 404, body: { error: 'Project not found' } };
  if (p.deploySource !== 'webhook') return { code: 409, body: { error: 'Project deploy source is not webhook' } };
  const now = new Date().toISOString();
  const done = body.status === 'finished' || body.status === 'failed';
  await reportDeploy(p, { status: body.status, startedAt: now, finishedAt: done ? now : null, commit: body.sha, message: body.message ?? null, author: body.author ?? null }, log);
  return { code: 200, body: { ok: true } };
}

const GH_DEPLOY_STATES: Record<string, NonNullable<DeployStatus>['status']> = {
  success: 'finished', failure: 'failed', error: 'failed', in_progress: 'in_progress', queued: 'queued', pending: 'queued',
};

/** Zdarzenie GitHub deployment_status: projekty ze źródłem "github" i tym samym repo (oraz środowiskiem, jeśli podane). */
export async function reportGithubDeployment(
  body: { deployment_status?: { state?: string }; deployment?: { sha?: string; environment?: string }; repository?: { full_name?: string } },
  log?: Log,
) {
  const status = GH_DEPLOY_STATES[body.deployment_status?.state ?? ''];
  const sha = body.deployment?.sha;
  const repo = body.repository?.full_name?.toLowerCase();
  if (!status || !sha || !repo) return [];
  const touched: string[] = [];
  for (const p of await listAllProjects()) {
    if (p.deploySource !== 'github' || p.githubRepo.toLowerCase() !== repo) continue;
    if (p.deploySourceRef && p.deploySourceRef !== body.deployment?.environment) continue;
    const now = new Date().toISOString();
    const done = status === 'finished' || status === 'failed';
    await reportDeploy(p, { status, startedAt: now, finishedAt: done ? now : null, commit: sha, message: null, author: null }, log);
    touched.push(p.key);
  }
  return touched;
}

export async function registerHooks(app: FastifyInstance) {
  app.register(async (r) => {
    // Podpis GitHuba liczony jest z surowego body, więc parser zostawia Buffer.
    r.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    r.post('/hooks/github', async (req: FastifyRequest, reply) => {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      const raw = req.body as Buffer;
      if (!secret || !verifyGithubSignature(secret, raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        return reply.code(401).send({ error: 'Bad signature' });
      }
      const event = req.headers['x-github-event'];
      if (event === 'ping') return { ok: true };
      if (event === 'deployment_status') return { touched: await reportGithubDeployment(JSON.parse(raw.toString('utf8')), req.log) };
      if (event !== 'push') return { ignored: event };
      const body = JSON.parse(raw.toString('utf8')) as { commits?: GhCommit[]; repository?: { full_name?: string } };
      return { touched: await recordCommits(body.commits ?? [], body.repository?.full_name ?? null) };
    });

    // Ogólny webhook deployu (projekt z deploySource = 'webhook'): dowolny CI woła go po wdrożeniu.
    r.post('/hooks/deploy', async (req, reply) => {
      const secret = process.env.DEPLOY_WEBHOOK_SECRET;
      const given = (req.headers['x-webhook-secret'] as string | undefined) ?? '';
      if (!secret || !safeEqual(given, secret)) return reply.code(401).send({ error: 'Bad secret' });
      const parsed = deployHookBody.safeParse(JSON.parse((req.body as Buffer).toString('utf8') || '{}'));
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid body' });
      const res = await reportDeployHook(parsed.data, req.log);
      return reply.code(res.code).send(res.body);
    });
  });
}
