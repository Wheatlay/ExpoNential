import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { apiTokens, issues, projects, userViews, users } from '../db/schema.ts';
import { createApiToken, requireAdmin, requireUser } from './auth.ts';
import * as svc from './service.ts';
import * as sp from './sprints.ts';
import * as pr from './projects.ts';
import * as ag from './agents.ts';
import { addRelation, removeRelation } from './relations.ts';
import { RuleError, parseIdentifier } from './rules.ts';
import { DEFAULT_MODELS, DEFAULT_PROMPTS, MODELS, PROMPT_KINDS, analysisModel, renderPrompt } from './prompts.ts';

export const issueInputSchema = z.object({
  title: z.string().max(500).optional(),
  description: z.string().optional(),
  statusId: z.number().int().optional(),
  assigneeId: z.number().int().nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  labelIds: z.array(z.number().int()).optional(),
  parentNumber: z.number().int().nullable().optional(),
  sprintId: z.number().int().nullable().optional(),
  sortOrder: z.number().optional(),
  analysis: z.string().optional(),
  changeHuman: z.string().optional(),
  changeAi: z.string().optional(),
  infoFromId: z.number().int().nullable().optional(),
  infoQuestion: z.string().max(2000).optional(),
});

const intParam = (v: string) => z.coerce.number().int().positive().parse(v);

/** Bieżący projekt żądania: nagłówek X-Project (aplikacja) albo ?project=KEY; bez nich domyślny. */
export function projectKeyOf(req: FastifyRequest) {
  const h = req.headers['x-project'];
  const q = (req.query as { project?: string } | undefined)?.project;
  return (typeof h === 'string' && h) || q || null;
}

export async function ctx(req: FastifyRequest, key?: string | null) {
  return pr.requireMember(req.user!, key ?? projectKeyOf(req));
}

/** Zadanie z identyfikatora w URL: projekt z klucza (WEB-12), goły numer w bieżącym projekcie. */
async function issueRef(req: FastifyRequest, id: string) {
  const ref = parseIdentifier(id);
  if (!ref) throw new RuleError('Invalid issue id', 'invalid');
  const { project, role } = await ctx(req, ref.key);
  return { p: project, number: ref.number, role };
}

/** Drugie zadanie relacji: musi być z tego samego projektu. */
function sameProjectNumber(p: svc.Project, other: string | number) {
  const ref = parseIdentifier(other);
  if (!ref) throw new RuleError('Invalid issue id', 'invalid');
  if (ref.key && ref.key !== p.key) throw new RuleError('Relations between projects are not supported', 'invalid');
  return ref.number;
}

async function manage(req: FastifyRequest, key?: string | null) {
  const c = await ctx(req, key);
  if (!pr.canManage(req.user!, c.role)) throw new RuleError('Project admin only', 'forbidden');
  return c.project;
}

export async function registerApi(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof RuleError) {
      const code = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : err.code === 'conflict' ? 409 : err.code === 'outdated' ? 426 : 422;
      return reply.code(code).send({ error: err.message, code: err.code });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', issues: err.issues });
    app.log.error(err);
    return reply.code(500).send({ error: 'Server error' });
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    r.get('/api/me', async (req) => {
      const [u] = await db.select({ localAgentAt: users.localAgentAt }).from(users).where(eq(users.id, req.user!.id));
      const mine = await ag.myAgents(req.user!);
      const lastSeen = mine.map((a) => a.lastSeenAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      return { ...req.user, localAgentAt: u?.localAgentAt ?? null, agentOnline: mine.some((a) => a.online), agentLastSeen: lastSeen,
        // Stara wersja skryptów na którymś PC, albo instalacja sprzed agenta w tle (jest znacznik, nie ma żadnego komputera).
        agentOutdated: !!u?.localAgentAt && (!mine.length || mine.some((a) => a.outdated)), demo: process.env.DEMO_MODE === '1' };
    });

    // Agent na PC (tracker-agent.ps1): long poll po pracę, przejęcie zlecenia Start, lista i usuwanie komputerów.
    r.get<{ Querystring: Record<string, string> }>('/api/agent/work', async (req) => {
      const q = z.object({
        deviceId: z.string().uuid(), name: z.string().max(200).default(''), busy: z.enum(['0', '1']).default('0'), repos: z.string().max(1000).default(''), version: z.string().max(40).default(''), error: z.string().max(300).default(''),
      }).parse(req.query);
      // Zamknięte połączenie przerywa czekanie, żeby pętla nie trzymała zapytań do bazy po odejściu agenta.
      const ac = new AbortController();
      req.raw.on('close', () => ac.abort());
      return ag.waitForWork(req.user!, q.deviceId, { name: q.name, busy: q.busy === '1', repoKeys: q.repos.split(',').filter(Boolean), version: q.version, error: q.error }, ac.signal);
    });
    r.post<{ Params: { id: string } }>('/api/agent/start-jobs/:id/claim', async (req) => {
      const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.body);
      return ag.claimStartJob(req.user!, intParam(req.params.id), deviceId);
    });
    // Telefon zleca otwarcie Claude Code na moim komputerze (agent odbierze w kilka sekund).
    r.post<{ Params: { id: string } }>('/api/issues/:id/start-on-pc', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      return ag.createStartJob(p, req.user!, number);
    });
    r.get('/api/agents', async (req) => ag.myAgents(req.user!));
    r.delete<{ Params: { id: string } }>('/api/agents/:id', async (req) => ag.removeAgent(req.user!, req.params.id));
    r.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) =>
      ag.renameAgent(req.user!, req.params.id, z.object({ label: z.string().max(60) }).parse(req.body).label));
    // Instalator lokalnej analizy zgłasza się tu tokenem MCP, deinstalator kasuje znacznik.
    r.post('/api/me/local-agent', async (req) => { await db.update(users).set({ localAgentAt: new Date() }).where(eq(users.id, req.user!.id)); return { ok: true }; });
    r.delete('/api/me/local-agent', async (req) => { await db.update(users).set({ localAgentAt: null }).where(eq(users.id, req.user!.id)); return { ok: true }; });

    // projekty
    r.get('/api/projects', async (req) => {
      const me = req.user!.id;
      // Pytania czekające na mnie w każdym projekcie (ta sama reguła co isAskedTo w aplikacji): widać je bez przełączania.
      const asked = await db.select({ projectId: issues.projectId, n: dsql<number>`count(*)::int` }).from(issues)
        .where(dsql`${issues.infoQuestion} <> '' and (${issues.infoFromId} = ${me} or (${issues.infoFromId} is null and ${issues.infoById} is distinct from ${me}))`)
        .groupBy(issues.projectId);
      const askedBy = new Map(asked.map((a) => [a.projectId, a.n]));
      return (await pr.projectsOf(req.user!)).map(({ project, role, memberCount }) => ({
        id: project.id, key: project.key, name: project.name, color: project.color, role, memberCount, githubRepo: project.githubRepo,
        askedMe: askedBy.get(project.id) ?? 0,
      }));
    });
    r.post('/api/projects', async (req, reply) => {
      if (!req.user!.isAdmin) return reply.code(403).send({ error: 'Admin only' });
      const body = z.object({ key: z.string(), name: z.string(), color: z.string().optional() }).parse(req.body);
      const p = await pr.createProject(req.user!.id, body);
      await sp.ensureProjectSprints(p);
      await svc.publish({ type: 'projects' });
      return p;
    });
    r.get<{ Params: { key: string } }>('/api/projects/:key', async (req) => {
      const { project, role } = await ctx(req, req.params.key);
      const canEdit = pr.canManage(req.user!, role);
      // Webhook to sekret: widzi go tylko admin projektu.
      return { ...project, discordWebhookUrl: canEdit ? project.discordWebhookUrl : null, role, canEdit, members: await pr.listMembers(project.id), defaultModels: DEFAULT_MODELS };
    });
    r.patch<{ Params: { key: string } }>('/api/projects/:key', async (req) => {
      const p = await manage(req, req.params.key);
      const body = z.object({
        name: z.string().optional(), color: z.string().optional(), discordWebhookUrl: z.string().nullable().optional(), meetingLocationUrl: z.string().max(500).optional(),
        sprintLengthDays: z.number().int().optional(), reviewTime: z.string().optional(), reviewMinutes: z.number().int().optional(),
                analyzeModel: z.enum(['', ...MODELS]).optional(), deepModel: z.enum(['', ...MODELS]).optional(),
        githubRepo: z.string().max(200).optional(), deployBranch: z.string().max(200).optional(), deploySource: z.enum(['', 'webhook', 'github', 'coolify']).optional(), deploySourceRef: z.string().max(200).optional(),
        agentTeamQueue: z.boolean().optional(),
      }).parse(req.body);
      if (body.discordWebhookUrl === '') body.discordWebhookUrl = null;
      const next = await pr.updateProject(p.id, body);
      // Długość sprintu albo godzina review mogły się zmienić: przeliczamy sprinty i ich review.
      await sp.ensureProjectSprints(next);
      await svc.publish({ type: 'projects' });
      await svc.publish({ type: 'sprints', projectKey: p.key });
      return next;
    });
    // Komputery z agentem online u członków projektu (kolejka zespołu).
    r.get<{ Params: { key: string } }>('/api/projects/:key/agents', async (req) => ag.projectAgents((await ctx(req, req.params.key)).project));
    r.post<{ Params: { key: string } }>('/api/projects/:key/members', async (req) => {
      const p = await manage(req, req.params.key);
      const body = z.object({ login: z.string().min(1), role: z.enum(['admin', 'member']).optional() }).parse(req.body);
      const u = await pr.addMember(req.user!, p.id, body.login, body.role);
      await svc.publish({ type: 'meta', projectKey: p.key });
      await svc.publish({ type: 'projects' });
      return { id: u.id };
    });
    r.delete<{ Params: { key: string; userId: string } }>('/api/projects/:key/members/:userId', async (req) => {
      const p = await manage(req, req.params.key);
      await pr.removeMember(p.id, intParam(req.params.userId));
      await svc.publish({ type: 'meta', projectKey: p.key });
      await svc.publish({ type: 'projects' });
      return { ok: true };
    });

    r.get('/api/meta', async (req) => svc.getMeta((await ctx(req)).project));
    r.get('/api/issues', async (req) => svc.listIssues((await ctx(req)).project, { viewerId: req.user!.id }));
    // Widok boardu: domyślny projektu + mój (nadpisuje). Treść widoku to dane aplikacji, serwer jej nie interpretuje.
    const viewBody = z.object({ view: z.record(z.string(), z.unknown()) }).refine((b) => JSON.stringify(b.view).length < 20_000, 'View too large');
    r.get('/api/view', async (req) => {
      const { project, role } = await ctx(req);
      const [mine] = await db.select().from(userViews).where(and(eq(userViews.userId, req.user!.id), eq(userViews.projectId, project.id)));
      return { projectDefault: project.defaultView ?? null, mine: mine?.view ?? null, canSetDefault: pr.canManage(req.user!, role) };
    });
    r.put('/api/view', async (req) => {
      const { project } = await ctx(req);
      const { view } = viewBody.parse(req.body);
      await db.insert(userViews).values({ userId: req.user!.id, projectId: project.id, view })
        .onConflictDoUpdate({ target: [userViews.userId, userViews.projectId], set: { view, updatedAt: new Date() } });
      return { ok: true };
    });
    r.delete('/api/view', async (req) => {
      const { project } = await ctx(req);
      await db.delete(userViews).where(and(eq(userViews.userId, req.user!.id), eq(userViews.projectId, project.id)));
      return { ok: true };
    });
    r.put('/api/view/default', async (req) => {
      const p = await manage(req);
      const { view } = viewBody.parse(req.body);
      await db.update(projects).set({ defaultView: view }).where(eq(projects.id, p.id));
      await svc.publish({ type: 'view', projectKey: p.key });
      return { ok: true };
    });

    r.post('/api/issues/mark-read', async (req) => {
      const { numbers } = z.object({ numbers: z.array(z.number().int()).max(1000).optional() }).parse(req.body ?? {});
      return { marked: await svc.markSeenMany((await ctx(req)).project, req.user!.id, numbers) };
    });
    r.get<{ Params: { id: string } }>('/api/issues/:id', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const d = await svc.getIssueDetail(p, number);
      // Poprzednia wizyta: komentarze innych po niej podświetlamy jako nowe.
      const lastSeenAt = await svc.lastSeen(req.user!.id, d.id);
      await svc.markSeen(req.user!.id, d.id);
      const runner = await ag.analysisRunner(p, d);
      return { ...d, projectKey: p.key, lastSeenAt, analysisCanRun: runner.canRun, analysisClaimedDeviceName: runner.claimedDeviceName, teamQueue: p.agentTeamQueue };
    });

    r.post('/api/issues', async (req) => {
      const body = issueInputSchema.extend({ title: z.string().min(1).max(500) }).parse(req.body);
      const { project } = await ctx(req);
      return { ...(await svc.createIssue(project, req.user, body)), projectKey: project.key };
    });
    r.patch<{ Params: { id: string } }>('/api/issues/:id', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      return svc.updateIssue(p, req.user, number, issueInputSchema.parse(req.body));
    });
    r.delete<{ Params: { id: string } }>('/api/issues/:id', async (req) => {
      const { p, number, role } = await issueRef(req, req.params.id);
      const cur = await svc.requireIssue(p, number);
      if (!pr.canManage(req.user!, role) && cur.creatorId !== req.user!.id) throw new RuleError('Only the author or a project admin can delete an issue', 'forbidden');
      await svc.deleteIssue(p, number);
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/issues/:id/analyze', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = z.object({ deep: z.boolean().default(false), local: z.boolean().default(false) }).parse(req.body ?? {});
      await svc.requestAnalysis(p, req.user, number, b.deep, b.local);
      return { ok: true };
    });
    // Agent na PC przejmuje zlecenie przed uruchomieniem (409, gdy zajęte albo nieaktualne) i oddaje je po błędzie.
    const deviceBody = z.object({ deviceId: z.string().uuid() });
    r.post<{ Params: { id: string } }>('/api/issues/:id/analyze/claim', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = deviceBody.extend({ version: z.string().max(40).optional() }).parse(req.body);
      return ag.claimAnalysis(p, req.user!, number, b.deviceId, b.version);
    });
    r.delete<{ Params: { id: string } }>('/api/issues/:id/analyze/claim', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = deviceBody.extend({ error: z.string().max(2000).optional() }).parse(req.body);
      return ag.releaseClaim(p, req.user!, number, b.deviceId, b.error);
    });
    r.delete<{ Params: { id: string } }>('/api/issues/:id/analyze', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      await svc.cancelAnalysis(p, number);
      return { ok: true };
    });

    // Wybór w decyzji z analizy AI: opcja albo własna odpowiedź; oba puste cofają wybór.
    r.post<{ Params: { id: string } }>('/api/issues/:id/analysis/decision', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = z.object({ index: z.number().int().min(0), option: z.number().int().min(0).nullable(), other: z.string().max(500).default('') }).parse(req.body);
      return svc.chooseDecision(p, req.user, number, b.index, b.option, b.other);
    });

    // Gotowe polecenie dla Claude Code z szablonu projektu (guziki, lokalny skrypt analizy).
    r.get<{ Params: { id: string; kind: string }; Querystring: { compact?: string; deep?: string } }>('/api/issues/:id/prompt/:kind', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const kind = z.enum(PROMPT_KINDS).parse(req.params.kind);
      const deep = req.query.deep === '1';
      // Model tylko dla analizy: lokalny skrypt odpala z nim claude -p.
      return { prompt: await renderPrompt(p, number, kind, req.query.compact === '1', deep), ...(kind === 'analyze' ? { model: analysisModel(p, deep) } : {}) };
    });

    // Ślad pracy z sesji Claude Code, wysyłany przez hooki dewelopera (token API).
    r.post<{ Params: { id: string } }>('/api/issues/:id/worklog', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = z.object({
        session: z.string().min(1).max(100),
        repo: z.string().max(100).default(''),
        files: z.array(z.string().max(300)).max(200).default([]),
        commits: z.array(z.object({ sha: z.string().max(64), message: z.string().max(300) })).max(50).default([]),
        prompts: z.array(z.string().max(400)).max(10).default([]),
      }).parse(req.body);
      await svc.upsertWorklog(p, req.user, number, b);
      return { ok: true };
    });

    // Podgląd na żywo: kto przeciąga które zadanie i nad którą komórką jest (bez zapisu do bazy).
    r.post('/api/presence', async (req) => {
      const b = z.object({ number: z.number().int(), statusId: z.number().int().optional(), rowKey: z.string().max(40).optional(), fx: z.number().min(0).max(1).optional(), fy: z.number().min(0).max(1).optional(), end: z.boolean().optional() }).parse(req.body);
      const { project } = await ctx(req);
      await svc.publish({ type: 'presence', projectKey: project.key, userId: req.user!.id, name: req.user!.name, ...b });
      return { ok: true };
    });
    const relationBody = z.object({ kind: z.enum(['waits_on', 'blocks', 'related']), other: z.union([z.string(), z.number()]) });
    r.post<{ Params: { id: string } }>('/api/issues/:id/relations', async (req) => {
      const b = relationBody.parse(req.body);
      const { p, number } = await issueRef(req, req.params.id);
      await addRelation(p, req.user, number, b.kind, sameProjectNumber(p, b.other));
      return { ok: true };
    });
    r.delete<{ Params: { id: string } }>('/api/issues/:id/relations', async (req) => {
      const b = relationBody.parse(req.body);
      const { p, number } = await issueRef(req, req.params.id);
      await removeRelation(p, req.user, number, b.kind, sameProjectNumber(p, b.other));
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/issues/:id/comments', async (req) => {
      const { body } = z.object({ body: z.string().min(1) }).parse(req.body);
      const { p, number } = await issueRef(req, req.params.id);
      return svc.addComment(p, req.user, number, body);
    });
    // Komentarz po id: projekt bierzemy z komentarza, członkostwo sprawdza ctx.
    const commentProject = async (req: FastifyRequest, id: number) => {
      const projectId = await svc.projectIdOfComment(id);
      const all = await pr.projectsOf(req.user!);
      const p = all.find((x) => x.project.id === projectId)?.project;
      if (!p) throw new RuleError('Comment not found', 'not_found');
      return p;
    };
    r.patch<{ Params: { id: string } }>('/api/comments/:id', async (req) => {
      const { body } = z.object({ body: z.string().min(1) }).parse(req.body);
      const id = intParam(req.params.id);
      await svc.updateComment(await commentProject(req, id), req.user, id, body);
      return { ok: true };
    });
    r.delete<{ Params: { id: string } }>('/api/comments/:id', async (req) => {
      const id = intParam(req.params.id);
      await svc.deleteComment(await commentProject(req, id), req.user, id);
      return { ok: true };
    });

    // sprinty
    r.get('/api/sprints', async (req) => {
      const { project } = await ctx(req);
      return { sprints: await sp.listSprints(project), lengthDays: project.sprintLengthDays };
    });
    r.post<{ Params: { id: string } }>('/api/sprints/:id/carry-over', async (req) => {
      const { numbers } = z.object({ numbers: z.array(z.number().int()).optional() }).parse(req.body ?? {});
      return sp.carryOver((await ctx(req)).project, intParam(req.params.id), numbers);
    });
    r.patch<{ Params: { id: string } }>('/api/sprints/:id', async (req) => {
      const body = z.object({ reviewNotes: z.string().optional(), name: z.string().min(1).optional() }).parse(req.body);
      const { project } = await ctx(req);
      if (body.reviewNotes !== undefined) await sp.saveReviewNotes(project, intParam(req.params.id), body.reviewNotes);
      if (body.name) await sp.updateSprint(project, intParam(req.params.id), { name: body.name });
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/sprints/:id/close-review', async (req) => {
      const { project } = await ctx(req);
      await sp.closeReview(project, intParam(req.params.id));
      await sp.ensureProjectSprints(project);
      return { ok: true };
    });

    // słowniki projektu: admin projektu albo admin globalny
    r.post('/api/admin/labels', async (req) =>
      svc.saveLabel(await manage(req), z.object({ id: z.number().int().optional(), name: z.string().min(1), color: z.string().min(4) }).parse(req.body)));
    r.delete<{ Params: { id: string } }>('/api/admin/labels/:id', async (req) => {
      await svc.deleteLabel(await manage(req), intParam(req.params.id));
      return { ok: true };
    });
    r.patch('/api/admin/statuses', async (req) => {
      const body = z.object({
        id: z.number().int(), name: z.string().min(1).optional(), color: z.string().optional(),
        position: z.number().int().optional(), hiddenOnBoard: z.boolean().optional(), role: z.enum(['need_info', 'testing']).nullable().optional(),
      }).parse(req.body);
      await svc.saveStatus(await manage(req), body);
      return { ok: true };
    });
    r.put('/api/admin/sprint-length', async (req) => {
      const { days } = z.object({ days: z.number().int() }).parse(req.body);
      await sp.setSprintLength(await manage(req), days);
      return { ok: true };
    });

    // tokeny API do MCP
    r.get('/api/tokens', async (req) =>
      db.select({ id: apiTokens.id, name: apiTokens.name, createdAt: apiTokens.createdAt, lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens).where(eq(apiTokens.userId, req.user!.id)).orderBy(desc(apiTokens.createdAt)));
    r.post('/api/tokens', async (req) => {
      const { name } = z.object({ name: z.string().min(1).max(100) }).parse(req.body);
      return { token: await createApiToken(req.user!.id, name) };
    });
    r.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req) => {
      const [t] = await db.select().from(apiTokens).where(eq(apiTokens.id, intParam(req.params.id)));
      if (t?.userId === req.user!.id) await db.delete(apiTokens).where(eq(apiTokens.id, t.id));
      return { ok: true };
    });
  });

  // admin globalny: konta (allowlista logowania)
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);
    r.addHook('preHandler', requireAdmin);
    r.get('/api/admin/users', async () => db.select({
      id: users.id, login: users.login, name: users.name, avatarUrl: users.avatarUrl, isAdmin: users.isAdmin, active: users.active,
    }).from(users).orderBy(asc(users.name)));
    r.post('/api/admin/users', async (req) => {
      const body = z.object({
        id: z.number().int().optional(), login: z.string().min(1), name: z.string().optional(),
        isAdmin: z.boolean().optional(), active: z.boolean().optional(),
      }).parse(req.body);
      const p = body.id ? null : (await ctx(req).catch(() => null))?.project ?? null;
      await svc.saveUser(p, body);
      return { ok: true };
    });
  });
}
