import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.ts';
import { users } from '../../db/schema.ts';
import { createSession, requireUser } from '../auth.ts';
import { onlineUserIds } from '../events.ts';
import { getProjectByKey, requireMember } from '../projects.ts';
import { RuleError, parseIdentifier } from '../rules.ts';
import * as svc from '../service.ts';
import { seedDemo } from './seed.ts';
import { isBusy, simulate } from './simulate.ts';

const isDemo = () => process.env.DEMO_MODE === '1';

// Całe API poza GET-ami jest w demo ograniczone; blokady zwracają 403 { code: 'demo' }.
const BLOCKED_ALL = [/^\/api\/tokens(\/|$)/, /^\/mcp(\/|$)/, /^\/agent\//, /^\/hooks\//, /^\/api\/admin\/users(\/|$)/, /^\/api\/me\/local-agent$/, /^\/api\/push\//, /^\/api\/calendar-link$/];
const BLOCKED_WRITE: [string, RegExp][] = [['POST', /^\/api\/projects$/], ['POST', /^\/api\/projects\/[^/]+\/members$/], ['DELETE', /^\/api\/projects\/[^/]+\/members\//]];
const LOCKED_PROJECT_FIELDS = ['discordWebhookUrl', 'githubRepo', 'deployBranch', 'deploySource', 'deploySourceRef', 'promptStart', 'promptAnalyze', 'promptClose'];
const MAX_UPLOAD = 1024 * 1024;
const WRITES_PER_MIN = 120;

const LIVE_COMMENTS = [
  'Picked this up, will post an update later today.',
  'Looks good on my side, moving on to the next one.',
  'Can someone double-check this on staging?',
  'Added a few notes to the description, the edge cases are the tricky part.',
  'Synced with design, we are fine with the current approach.',
  'Reproduced it locally, working on a fix.',
  'This one is blocked on copy from marketing, pinging them.',
  'Tests are green, waiting for a review.',
];

export async function registerDemo(app: FastifyInstance) {
  // Publiczna konfiguracja dla frontu (także poza demo).
  app.get('/api/config', async () => ({ demo: isDemo(), repoUrl: process.env.PUBLIC_REPO_URL ?? null }));
  if (!isDemo()) return;

  const forbidden = { error: 'Disabled in the demo', code: 'demo' };
  const writes = new Map<string, { start: number; count: number }>();
  const sweep = setInterval(() => { const now = Date.now(); for (const [ip, w] of writes) if (now - w.start > 60_000) writes.delete(ip); }, 60_000);
  app.addHook('onClose', async () => clearInterval(sweep));

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (BLOCKED_ALL.some((re) => re.test(path)) || BLOCKED_WRITE.some(([m, re]) => m === req.method && re.test(path))) return reply.code(403).send(forbidden);
    if (path === '/api/uploads' && Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD) return reply.code(403).send(forbidden);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const now = Date.now();
      const w = writes.get(req.ip);
      if (!w || now - w.start > 60_000) writes.set(req.ip, { start: now, count: 1 });
      else if (++w.count > WRITES_PER_MIN) return reply.code(429).send({ error: 'Too many requests, slow down', code: 'rate' });
    }
  });
  // Ustawienia projektu z sekretami/integracjami: body jest sparsowane dopiero w preHandler.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method !== 'PATCH' || req.routeOptions.url !== '/api/projects/:key') return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (LOCKED_PROJECT_FIELDS.some((f) => f in body)) return reply.code(403).send(forbidden);
  });

  app.get<{ Querystring: { tour?: string } }>('/auth/demo', async (req, reply) => {
    const [u] = await db.select().from(users).where(eq(users.login, 'demo'));
    if (!u) return reply.code(503).send({ error: 'Demo is starting, try again in a moment' });
    await createSession(reply, u.id);
    return reply.redirect(req.query.tour === '1' ? '/issue/ACME-12' : '/');
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.post<{ Params: { id: string } }>('/api/demo/simulate/:id', async (req, reply) => {
      const { kind } = z.object({ kind: z.enum(['analyze', 'work']) }).parse(req.body);
      const ref = parseIdentifier(req.params.id);
      if (!ref) throw new RuleError('Invalid issue identifier', 'invalid');
      const { project } = await requireMember(req.user!, ref.key);
      await svc.requireIssue(project, ref.number);
      if (isBusy(project, ref.number)) return reply.code(409).send({ error: 'Agent is already working on this issue', code: 'busy' });
      simulate(project, ref.number, kind, req.user!, app.log);
      return reply.code(202).send({ ok: true });
    });
  });

  // Reset danych: przy starcie i co DEMO_RESET_MINUTES.
  let liveActions = 0;
  await seedDemo();
  const minutes = Number(process.env.DEMO_RESET_MINUTES ?? 60) || 60;
  const reset = setInterval(() => {
    void seedDemo().then(() => { liveActions = 0; return svc.publish({ type: 'projects' }); }).catch((e) => app.log.error(e, 'demo reset'));
  }, minutes * 60_000);
  app.addHook('onClose', async () => clearInterval(reset));

  // "Żywy zespół": gdy ktoś ogląda, co 45 s jedna drobna akcja kogoś z zespołu.
  const live = setInterval(() => {
    if (liveActions >= 30 || !onlineUserIds().length) return;
    liveActions++;
    void liveAction().catch((e) => app.log.warn(e, 'demo live action'));
  }, 45_000);
  app.addHook('onClose', async () => clearInterval(live));
}

const pick = <T,>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

async function liveAction() {
  const p = await getProjectByKey('ACME');
  if (!p) return;
  const [meta, list] = await Promise.all([svc.getMeta(p), svc.listIssues(p, {})]);
  const people = meta.users.filter((u) => ['maya', 'leo', 'sara'].includes(u.login));
  if (!people.length) return;
  const who = pick(people);
  const actor = { id: who.id, name: who.name };
  const st = (name: string) => meta.statuses.find((s) => s.name === name)!;
  const open = list.filter((i) => i.number !== 12 && !(i as { infoQuestion?: string }).infoQuestion);
  const kind = pick(['todo', 'progress', 'comment']);
  if (kind === 'comment') {
    const c = pick(open.filter((i) => [st('Todo').id, st('In Progress').id, st('Testing').id].includes(i.statusId)));
    if (c) await svc.addComment(p, actor, c.number, pick(LIVE_COMMENTS));
    return;
  }
  const from = kind === 'todo' ? st('Todo') : st('In Progress');
  const to = kind === 'todo' ? st('In Progress') : st('Testing');
  const c = pick(open.filter((i) => i.statusId === from.id));
  if (c) await svc.updateIssue(p, actor, c.number, { statusId: to.id, ...(c.assigneeId == null ? { assigneeId: who.id } : {}) });
}
