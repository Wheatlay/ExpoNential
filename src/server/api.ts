import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql as dsql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/index.ts';
import { TAG_COLORS, apiTokens, inboxItems, issues, labels, meetings, projectMembers, projects, userTagMembers, userTags, userViews, users } from '../db/schema.ts';
import { clearSessionCookie, createApiToken, requireAdmin, requireUser } from './auth.ts';
import * as inv from './invites.ts';
import { hashPassword, loginLimiter, passwordProblem, verifyPassword } from './password.ts';
import * as svc from './service.ts';
import * as acc from './account.ts';
import * as sp from './sprints.ts';
import * as pr from './projects.ts';
import { listProjectLog, logProject } from './projectLog.ts';
import * as ag from './agents.ts';
import { addRelation, removeRelation } from './relations.ts';
import { RuleError, normGithubRepo, parseIdentifier } from './rules.ts';
import { sendDiscord } from './notify.ts';
import { st } from './i18n.ts';
import { validTagName } from './mentions.ts';
import { deployWebhookSecret, githubRepoExists } from './hooks.ts';
import { DEFAULT_MODELS, DEFAULT_PROMPTS, MODELS, PROMPT_KINDS, analysisModel, renderPrompt } from './prompts.ts';
import { TYPE_LABEL_COLORS } from './analysis.ts';

export const EDITORS = ['vscode', 'cursor', 'windsurf', 'terminal'] as const;

export const issueInputSchema = z.object({
  title: z.string().max(500).optional(),
  description: z.string().max(100_000).optional(),
  statusId: z.number().int().optional(),
  assigneeId: z.number().int().nullable().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  labelIds: z.array(z.number().int()).optional(),
  parentNumber: z.number().int().nullable().optional(),
  sprintId: z.number().int().nullable().optional(),
  sortOrder: z.number().optional(),
  analysis: z.string().max(50_000).optional(),
  changeHuman: z.string().max(50_000).optional(),
  changeAi: z.string().max(50_000).optional(),
  infoFromId: z.number().int().nullable().optional(),
  infoTagId: z.number().int().nullable().optional(),
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
    // Naruszenie unikalności w bazie (np. dwie etykiety o tej samej nazwie): czytelny 409 zamiast "Server error".
    const pg = (err as { code?: string; cause?: { code?: string } });
    if (pg.code === '23505' || pg.cause?.code === '23505') return reply.code(409).send({ error: 'This name is already taken', code: 'conflict' });
    app.log.error(err);
    return reply.code(500).send({ error: 'Server error' });
  });

  // Publiczne: dane ekranu zaproszenia i resetu hasła (tylko dla ważnych linków).
  app.get<{ Params: { token: string } }>('/api/invites/:token', async (req) => {
    const info = await inv.inviteInfo(req.params.token);
    if (!info) throw new RuleError('This invite is no longer valid', 'not_found');
    return { projectName: info.projectName, role: info.role };
  });
  app.get<{ Params: { token: string } }>('/api/reset/:token', async (req) => {
    const info = await inv.resetInfo(req.params.token);
    if (!info) throw new RuleError('This link is no longer valid', 'not_found');
    return { name: info.name };
  });

  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    const meShape = async (req: FastifyRequest) => {
      const [u] = await db.select({
        setupDoneAt: users.setupDoneAt, lang: users.lang, passwordHash: users.passwordHash,
        avatarUrl: users.avatarUrl, avatarCustom: users.avatarCustom, providerAvatarUrl: users.providerAvatarUrl, githubId: users.githubId, editor: users.editor,
      }).from(users).where(eq(users.id, req.user!.id));
      const mine = await ag.agentsLite(req.user!, true);
      const lastSeen = mine.map((a) => a.lastSeenAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      // provider: skąd wraca zdjęcie po "Use … photo"; null = konto bez zdjęcia od dostawcy (zostają inicjały).
      return { ...req.user, avatarUrl: u?.avatarUrl ?? null, avatarCustom: !!u?.avatarCustom, provider: u?.providerAvatarUrl ? (u.githubId ? 'github' : 'google') : null,
        hasPassword: !!u?.passwordHash, hasAgent: mine.length > 0, agentOnline: mine.some((a) => a.online), agentLastSeen: lastSeen,
        setupDoneAt: u?.setupDoneAt ?? null, lang: u?.lang ?? null, editor: u?.editor ?? 'vscode', aiStatus: await ag.aiStatus(req.user!, mine),
        // Któryś komputer ma agenta starszego niż MIN_EXE_AGENT.
        agentOutdated: mine.some((a) => a.outdated), demo: process.env.DEMO_MODE === '1' };
    };
    r.get('/api/me', meShape);

    // Własny profil: nazwa i zdjęcie (avatar: ścieżka z /api/uploads albo null = zdjęcie od dostawcy). Bez projectKey, żeby odświeżyli się wszyscy.
    r.put('/api/me', async (req) => {
      const body = z.object({ name: z.string().max(200).optional(), avatar: z.string().max(300).nullable().optional(), lang: z.enum(['en', 'pl']).nullable().optional(), editor: z.enum(EDITORS).optional() }).parse(req.body);
      await acc.updateProfile(req.user!.id, body);
      await svc.publish({ type: 'meta' });
      return meShape(req);
    });
    // Usunięcie własnego konta (anonimizacja, patrz account.ts).
    r.delete('/api/me', async (req, reply) => {
      const body = z.object({ confirm: z.string().max(200) }).parse(req.body ?? {});
      await acc.deleteAccount(req.user!.id, body.confirm);
      clearSessionCookie(reply);
      await svc.publish({ type: 'meta' });
      await svc.publish({ type: 'projects' });
      return { ok: true };
    });

    // Zmiana własnego hasła; jeśli konto ma już hasło, wymaga obecnego.
    r.post('/api/me/password', async (req) => {
      const body = z.object({ current: z.string().max(1000).optional(), password: z.string().max(1000) }).parse(req.body);
      const problem = passwordProblem(body.password);
      if (problem) throw new RuleError(problem, 'invalid');
      const [u] = await db.select({ passwordHash: users.passwordHash, email: users.email }).from(users).where(eq(users.id, req.user!.id));
      if (!u?.email) throw new RuleError('Your account has no e-mail address, so a password cannot be used to log in', 'invalid');
      if (u.passwordHash) {
        const key = `me|${req.user!.id}`;
        if (loginLimiter.blocked(key)) throw new RuleError('Too many failed attempts, try again in 15 minutes', 'invalid');
        if (!body.current || !(await verifyPassword(body.current, u.passwordHash))) {
          loginLimiter.fail(key);
          throw new RuleError('Current password is wrong', 'invalid');
        }
        loginLimiter.reset(key);
      }
      await db.update(users).set({ passwordHash: await hashPassword(body.password) }).where(eq(users.id, req.user!.id));
      return { ok: true };
    });

    // Agent na PC (Go): long poll po pracę, przejęcie zlecenia Start, lista i usuwanie komputerów.
    r.get<{ Querystring: Record<string, string> }>('/api/agent/work', async (req) => {
      const q = z.object({
        deviceId: z.string().uuid(), name: z.string().max(200).default(''), busy: z.enum(['0', '1']).default('0'), repos: z.string().max(8000).default(''), version: z.string().max(40).default(''), error: z.string().max(1200).default('').transform((s) => s.slice(0, 300)), engine: z.enum(['claude', 'codex']).optional(), setup: z.string().max(4000).optional(), found: z.string().max(8000).optional(), skip: z.string().max(1000).optional(),
      }).parse(req.query);
      // Zamknięte połączenie przerywa czekanie, żeby pętla nie trzymała zapytań do bazy po odejściu agenta.
      const ac = new AbortController();
      req.raw.on('close', () => ac.abort());
      // repos: JSON {KEY: {path, source, status: 'ok'|'error', error?}} (stare formaty: {KEY: ścieżka} i wpis bez statusu = ok).
      let repos: Record<string, ag.RepoReport | string> | undefined;
      try { repos = z.record(z.string(), z.union([z.string(), z.object({ path: z.string().optional(), source: z.string().optional(), status: z.string().optional(), error: z.string().nullable().optional().transform((e) => e?.slice(0, 300)) })])).parse(JSON.parse(q.repos || '{}')); } catch { repos = {}; }
      const repoKeys = Object.keys(repos);
      return ag.waitForWork(req.user!, q.deviceId, { name: q.name, busy: q.busy === '1', repoKeys, repos, version: q.version, error: q.error, ownOnly: q.engine === 'codex', setup: ag.parseSetup(q.setup), found: ag.parseFound(q.found), skip: ag.parseSkip(q.skip) }, ac.signal);
    });
    r.post<{ Params: { id: string } }>('/api/agent/start-jobs/:id/claim', async (req) => {
      const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.body);
      return ag.claimStartJob(req.user!, intParam(req.params.id), deviceId);
    });
    // Agent czeka na zgodę właściciela PC na cudze zlecenie (albo już nie czeka): pasek analizy pokazuje "awaiting_consent".
    r.post('/api/agent/consent-pending', async (req) => {
      const b = z.object({ issueId: z.number().int().positive(), pending: z.boolean() }).parse(req.body);
      return ag.setConsentPending(req.user!, b.issueId, b.pending);
    });
    // Prośby o otwarcie edytora ("Start" z przeglądarki): agent odpytuje, odpowiedź czyści kolejkę tej osoby.
    r.get('/api/agent/open-requests', async (req) => ag.takeOpenRequests(req.user!.id));
    // Polecenia dla PC (wybierz folder, klonuj, skanuj): agent odpytuje, odpowiedź czyści kolejkę tego PC.
    r.get<{ Querystring: Record<string, string> }>('/api/agent/repo-actions', async (req) => {
      const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(req.query);
      await ag.requireOwnAgent(req.user!, deviceId);
      return ag.takeRepoActions(deviceId);
    });
    r.post<{ Params: { id: string } }>('/api/agents/:id/repo-action', async (req) => {
      const b = z.object({ kind: z.enum(ag.REPO_ACTION_KINDS), project: z.string().max(10).default('') }).parse(req.body);
      return ag.requestRepoAction(req.user!, req.params.id, b);
    });
    // "Start work": gdy mam komputer online, agent otwiera edytor z poleceniem; inaczej przeglądarka dostaje polecenie do skopiowania.
    r.post('/api/start-work', async (req) => {
      const b = z.object({ issueId: z.union([z.string(), z.number()]).optional(), issueNumber: z.union([z.string(), z.number()]).optional() }).parse(req.body);
      const ref = b.issueId ?? b.issueNumber;
      if (ref === undefined) throw new RuleError('issueId required', 'invalid');
      const { p, number } = await issueRef(req, String(ref));
      const prompt = await renderPrompt(p, number, 'start');
      const mine = await ag.agentsLite(req.user!);
      // Kolejka jest per osoba, nie per PC: przy dwóch PC online edytor mógłby się otworzyć na złym, więc wtedy link w przeglądarce.
      if (mine.filter((a) => a.online && a.opensEditor).length !== 1) return { viaAgent: false, prompt };
      const [u] = await db.select({ editor: users.editor }).from(users).where(eq(users.id, req.user!.id));
      ag.queueOpenRequest(req.user!.id, { editor: u?.editor ?? 'vscode', repo: p.githubRepo, prompt });
      return { viaAgent: true };
    });
    // Telefon zleca otwarcie Claude Code na moim komputerze (agent odbierze w kilka sekund).
    r.post<{ Params: { id: string } }>('/api/issues/:id/start-on-pc', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      return ag.createStartJob(p, req.user!, number);
    });
    r.get('/api/agents', async (req) => ag.myAgents(req.user!));
    r.put<{ Params: { id: string } }>('/api/agents/:id/repos', async (req) => {
      const body = z.object({ project: z.string().min(1).max(10), path: z.string().min(1).max(500) }).parse(req.body);
      return ag.setAgentRepo(req.user!, req.params.id, body.project, body.path);
    });
    r.delete<{ Params: { id: string } }>('/api/agents/:id', async (req) => ag.removeAgent(req.user!, req.params.id));
    r.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
      const b = z.object({ teamMode: z.enum(ag.TEAM_MODES).optional(), label: z.string().max(60).optional(), maxOthersTokensPerDay: z.number().int().min(0).max(10_000_000_000).nullable().optional() }).parse(req.body);
      // Token agenta może zmienić tylko teamMode (własnego komputera: setTeamMode sprawdza właściciela).
      // The agent's own token may also set the limit (the owner's PC); other tokens only teamMode, nobody's token the label.
      if (req.authVia === 'token' && (b.label !== undefined || (b.maxOthersTokensPerDay !== undefined && !req.tokenAgent))) throw new RuleError('This token can only change teamMode', 'forbidden');
      if (b.teamMode !== undefined) await ag.setTeamMode(req.user!, req.params.id, b.teamMode);
      if (b.label !== undefined) await ag.renameAgent(req.user!, req.params.id, b.label);
      if (b.maxOthersTokensPerDay !== undefined) await ag.setAgentLimit(req.user!, req.params.id, b.maxOthersTokensPerDay);
      // Open pages of this user refresh Settings without a reload (only the owner gets it).
      await svc.publish({ type: 'agents', userIds: [req.user!.id] });
      return { ok: true };
    });
    // Przebieg agenta po zakończeniu (zużycie tokenów, zlecający).
    r.post('/api/agent/runs', async (req) => {
      const n = z.number().finite().optional();
      const b = z.object({
        deviceId: z.string().uuid(), key: z.string().max(40), kind: z.enum(['analyze', 'start']), engine: z.string().max(20).default(''), model: z.string().max(80).default(''),
        startedAt: z.string().max(40).optional(), durationMs: z.number(), exitCode: z.number(),
        usage: z.object({ inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheWriteTokens: n, costUsd: n }).optional(),
      }).parse(req.body);
      return ag.recordRun(req.user!, b);
    });
    r.put('/api/me/setup-done', async (req) => { await db.update(users).set({ setupDoneAt: new Date() }).where(eq(users.id, req.user!.id)); return { ok: true }; });

    // projekty
    r.get('/api/projects', async (req) => {
      const me = req.user!.id;
      return (await pr.projectsOf(req.user!)).map(({ project, role, memberCount }) => ({
        id: project.id, key: project.key, name: project.name, color: project.color, logoUrl: project.logoUrl, role, memberCount, githubRepo: project.githubRepo,
      }));
    });
    r.post('/api/projects', async (req) => {
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
    r.patch<{ Params: { key: string } }>('/api/projects/:key', async (req, reply) => {
      const p = await manage(req, req.params.key);
      const body = z.object({
        name: z.string().optional(), color: z.string().optional(), logoUrl: z.string().max(300).optional(), discordWebhookUrl: z.string().nullable().optional(), meetingLocationUrl: z.string().max(500).refine((u) => u === '' || /^https?:\/\/\S+$/i.test(u), 'Meeting location must be empty or an http(s) URL').optional(),
        sprintLengthDays: z.number().int().optional(), reviewMeeting: z.boolean().optional(), reviewTime: z.string().optional(), reviewMinutes: z.number().int().optional(),
                analyzeModel: z.enum(['', ...MODELS]).optional(), deepModel: z.enum(['', ...MODELS]).optional(),
        githubRepo: z.string().max(200).optional(), deploySource: z.enum(['', 'webhook', 'github', 'coolify']).optional(),
        agentTeamQueue: z.boolean().optional(), agentsMayClone: z.boolean().optional(),
      }).parse(req.body);
      if (body.githubRepo !== undefined) {
        const repo = normGithubRepo(body.githubRepo);
        if (repo === null) return reply.code(400).send({ error: 'Not a GitHub repo. Use owner/name or the repo URL.', code: 'invalid' });
        body.githubRepo = repo;
      }
      if (body.discordWebhookUrl === '') body.discordWebhookUrl = null;
      const next = await pr.updateProject(p.id, body, req.user!.id);
      // Długość sprintu albo godzina review mogły się zmienić: przeliczamy sprinty i ich review.
      await sp.ensureProjectSprints(next);
      await svc.publish({ type: 'projects' });
      await svc.publish({ type: 'sprints', projectKey: p.key });
      return next;
    });
    // Podpowiedzi repo: repozytoria znalezione na własnych PC pytającego (bez ścieżek); trasa projektu sprawdza członkostwo.
    r.get<{ Params: { key: string } }>('/api/projects/:key/repo-suggestions', async (req) => {
      await ctx(req, req.params.key);
      return ag.repoSuggestions(req.user!.id);
    });
    // Czy repo istnieje na GitHubie (cache 10 min).
    r.get<{ Querystring: { name?: string } }>('/api/github/repo-check', async (req) => {
      const name = normGithubRepo(z.string().max(200).parse(req.query.name ?? ''));
      if (!name) throw new RuleError('Not a GitHub repo. Use owner/name or the repo URL.', 'invalid');
      return { exists: await githubRepoExists(name) };
    });
    // Wiadomość próbna na kanał Discord projektu (admin projektu).
    r.post<{ Params: { key: string } }>('/api/projects/:key/discord-test', async (req) => {
      const p = await manage(req, req.params.key);
      if (!p.discordWebhookUrl) throw new RuleError('Discord webhook is not set', 'invalid');
      const ok = await sendDiscord(p, { title: st('Test message from Exponential'), description: p.name }, req.log as { warn: (o: object, m: string) => void });
      if (ok) return { ok: true };
      const [fresh] = await db.select({ e: projects.discordLastError }).from(projects).where(eq(projects.id, p.id));
      return { ok: false, error: fresh?.e || 'Request failed' };
    });
    // Ostatnie miejsca spotkań projektu (90 dni, tylko http/https) do szybkiego wyboru.
    r.get<{ Params: { key: string } }>('/api/projects/:key/recent-places', async (req) => {
      const { project } = await ctx(req, req.params.key);
      const rows = await db.select({ url: meetings.locationUrl, last: dsql<Date>`max(${meetings.createdAt})` }).from(meetings)
        .where(and(eq(meetings.projectId, project.id), dsql`${meetings.locationUrl} ~* '^https?://'`, dsql`${meetings.createdAt} > now() - interval '90 days'`))
        .groupBy(meetings.locationUrl).orderBy(desc(dsql`max(${meetings.createdAt})`)).limit(5);
      return rows.map((x) => x.url).filter((u) => u !== project.meetingLocationUrl).slice(0, 4);
    });
    // Sekret webhooka deployu: tylko admin projektu.
    r.get<{ Params: { key: string } }>('/api/projects/:key/deploy-webhook-secret', async (req) => {
      const p = await manage(req, req.params.key);
      return { secret: await deployWebhookSecret(p.key) };
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
      await pr.removeMember(p.id, intParam(req.params.userId), req.user!.id);
      await svc.publish({ type: 'meta', projectKey: p.key });
      await svc.publish({ type: 'projects' });
      return { ok: true };
    });

    // Zaproszenia do projektu (admin projektu): link widać tylko raz, w odpowiedzi na utworzenie.
    r.post<{ Params: { key: string } }>('/api/projects/:key/invites', async (req) => {
      const p = await manage(req, req.params.key);
      const body = z.object({ role: z.enum(['admin', 'member']).default('member') }).parse(req.body ?? {});
      return inv.createInvite(req.user!.id, p.id, body.role);
    });
    r.get<{ Params: { key: string }; Querystring: { before?: string } }>('/api/projects/:key/log', async (req) => {
      const p = await manage(req, req.params.key);
      const before = req.query.before ? intParam(req.query.before) : undefined;
      return listProjectLog(p.id, 100, before);
    });
    r.get<{ Params: { key: string } }>('/api/projects/:key/invites', async (req) => inv.listInvites((await manage(req, req.params.key)).id));
    r.delete<{ Params: { key: string; id: string } }>('/api/projects/:key/invites/:id', async (req) => {
      const p = await manage(req, req.params.key);
      await inv.revokeInvite(p.id, intParam(req.params.id), req.user!.id);
      return { ok: true };
    });
    r.post<{ Params: { key: string; id: string } }>('/api/projects/:key/invites/:id/renew', async (req) => {
      const p = await manage(req, req.params.key);
      return inv.renewInvite(req.user!.id, p.id, intParam(req.params.id));
    });
    // Zalogowany przyjmuje zaproszenie na swoje konto.
    r.post<{ Params: { token: string } }>('/api/invites/:token/accept', async (req) => {
      const joined = await inv.consumeInvite(req.params.token, req.user!.id);
      if (!joined) throw new RuleError('This invite is no longer valid', 'not_found');
      await svc.publish({ type: 'projects' });
      return { projectKey: joined.projectKey };
    });

    r.get('/api/meta', async (req) => svc.getMeta((await ctx(req)).project));
    // Tagi osób (#tag): każdy członek projektu może je zakładać i zmieniać; pusty tag znika.
    const tagName = z.string().transform((v) => v.trim().toLowerCase()).refine(validTagName, 'Tag names use letters, digits, - and _ (max 30) and need a letter');
    const tagInput = z.object({ name: tagName, color: z.enum(TAG_COLORS) });
    const tagTaken = async (projectId: number, name: string, exceptId?: number) => {
      const [t] = await db.select({ id: userTags.id }).from(userTags).where(and(eq(userTags.projectId, projectId), eq(userTags.name, name)));
      if (t && t.id !== exceptId) throw new RuleError('That tag already exists', 'invalid');
    };
    const parseTag = <T extends z.ZodType>(schema: T, body: unknown): z.infer<T> => {
      const res = schema.safeParse(body);
      if (!res.success) throw new RuleError(res.error.issues[0]?.message ?? 'Invalid tag', 'invalid');
      return res.data;
    };
    r.post('/api/tags', async (req) => {
      const { project } = await ctx(req);
      const b = parseTag(tagInput, req.body);
      await tagTaken(project.id, b.name);
      const tag = await db.transaction(async (tx) => {
        const [t] = await tx.insert(userTags).values({ projectId: project.id, name: b.name, color: b.color, createdBy: req.user!.id }).returning();
        await tx.insert(userTagMembers).values({ tagId: t.id, userId: req.user!.id });
        return t;
      });
      await svc.publish({ type: 'meta', projectKey: project.key });
      return tag;
    });
    r.patch<{ Params: { id: string } }>('/api/tags/:id', async (req) => {
      const { project } = await ctx(req);
      const id = intParam(req.params.id);
      const b = parseTag(tagInput.partial(), req.body);
      if (b.name !== undefined) await tagTaken(project.id, b.name, id);
      const [t] = Object.keys(b).length
        ? await db.update(userTags).set(b).where(and(eq(userTags.id, id), eq(userTags.projectId, project.id))).returning()
        : await db.select().from(userTags).where(and(eq(userTags.id, id), eq(userTags.projectId, project.id)));
      if (!t) throw new RuleError('Tag not found', 'not_found');
      await svc.publish({ type: 'meta', projectKey: project.key });
      return t;
    });
    // Członkowie taga: admin projektu dodaje i usuwa każdego, pozostali tylko siebie (to samo robi PUT /api/me/tags).
    const tagMemberScope = async (req: FastifyRequest, tagId: number, userId: number) => {
      const { project, role } = await ctx(req);
      const [t] = await db.select().from(userTags).where(and(eq(userTags.id, tagId), eq(userTags.projectId, project.id)));
      if (!t) throw new RuleError('Tag not found', 'not_found');
      if (!pr.canManage(req.user!, role) && userId !== req.user!.id) throw new RuleError('Only a project admin can change other people’s tags', 'forbidden');
      const [m] = await db.select({ id: projectMembers.userId }).from(projectMembers).where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, userId)));
      return { project, isMember: !!m };
    };
    r.post<{ Params: { id: string } }>('/api/tags/:id/members', async (req) => {
      const { userId } = z.object({ userId: z.number().int() }).parse(req.body);
      const id = intParam(req.params.id);
      const { project, isMember } = await tagMemberScope(req, id, userId);
      if (!isMember) throw new RuleError('This person is not a member of the project', 'invalid');
      await db.insert(userTagMembers).values({ tagId: id, userId }).onConflictDoNothing();
      await svc.publish({ type: 'meta', projectKey: project.key });
      return { ok: true };
    });
    r.delete<{ Params: { id: string; userId: string } }>('/api/tags/:id/members/:userId', async (req) => {
      const id = intParam(req.params.id), userId = intParam(req.params.userId);
      const { project } = await tagMemberScope(req, id, userId);
      await db.delete(userTagMembers).where(and(eq(userTagMembers.tagId, id), eq(userTagMembers.userId, userId)));
      await svc.publish({ type: 'meta', projectKey: project.key });
      return { ok: true };
    });
    // Usuwanie: admin projektu albo twórca taga. Członkowie znikają kaskadą, pytania do taga tracą adresata (set null).
    r.delete<{ Params: { id: string } }>('/api/tags/:id', async (req) => {
      const { project, role } = await ctx(req);
      const id = intParam(req.params.id);
      const [t] = await db.select().from(userTags).where(and(eq(userTags.id, id), eq(userTags.projectId, project.id)));
      if (!t) throw new RuleError('Tag not found', 'not_found');
      if (!pr.canManage(req.user!, role) && t.createdBy !== req.user!.id) throw new RuleError('Only the tag creator or a project admin can delete a tag', 'forbidden');
      await db.delete(userTags).where(eq(userTags.id, id));
      await svc.publish({ type: 'meta', projectKey: project.key });
      return { ok: true };
    });
    // Moje tagi w bieżącym projekcie: lista zastępuje dotychczasową, tag bez członków znika.
    r.put('/api/me/tags', async (req) => {
      const { project } = await ctx(req);
      const { tagIds } = z.object({ tagIds: z.array(z.number().int()).max(200) }).parse(req.body);
      const userId = req.user!.id;
      await db.transaction(async (tx) => {
        const own = (await tx.select({ id: userTags.id }).from(userTags).where(eq(userTags.projectId, project.id))).map((t) => t.id);
        const want = [...new Set(tagIds)].filter((id) => own.includes(id));
        if (own.length) await tx.delete(userTagMembers).where(and(eq(userTagMembers.userId, userId), inArray(userTagMembers.tagId, own), ...(want.length ? [notInArray(userTagMembers.tagId, want)] : [])));
        if (want.length) await tx.insert(userTagMembers).values(want.map((tagId) => ({ tagId, userId }))).onConflictDoNothing();
        // Tag należy do projektu (Ustawienia › Tagi), więc zostaje także bez członków; usuwa się go jawnie.
      });
      await svc.publish({ type: 'meta', projectKey: project.key });
      return { ok: true };
    });

    // Skrzynka: wzmianki i pytania do mnie ze wszystkich moich projektów.
    r.get('/api/inbox', async (req) => {
      const actor = alias(users, 'actor');
      return db.select({
        id: inboxItems.id, kind: inboxItems.kind, projectKey: projects.key, issueNumber: issues.number, issueTitle: issues.title,
        actorId: inboxItems.actorId, actorName: actor.name, tagName: inboxItems.tagName, excerpt: inboxItems.excerpt,
        createdAt: inboxItems.createdAt, readAt: inboxItems.readAt,
      }).from(inboxItems)
        .innerJoin(projects, eq(projects.id, inboxItems.projectId))
        .innerJoin(issues, eq(issues.id, inboxItems.issueId))
        .leftJoin(actor, eq(actor.id, inboxItems.actorId))
        .where(eq(inboxItems.userId, req.user!.id))
        .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id)).limit(50);
    });
    r.post('/api/inbox/read', async (req) => {
      const { ids } = z.object({ ids: z.array(z.number().int()).max(500).optional() }).parse(req.body ?? {});
      const userId = req.user!.id;
      await db.update(inboxItems).set({ readAt: new Date() })
        .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt), ...(ids ? [inArray(inboxItems.id, ids.length ? ids : [-1])] : [])));
      await svc.publish({ type: 'inbox', userIds: [userId] });
      return { ok: true };
    });
    r.delete<{ Params: { id: string } }>('/api/inbox/:id', async (req) => {
      const userId = req.user!.id;
      await db.delete(inboxItems).where(and(eq(inboxItems.id, intParam(req.params.id)), eq(inboxItems.userId, userId)));
      await svc.publish({ type: 'inbox', userIds: [userId] });
      return { ok: true };
    });

    r.get('/api/issues', async (req) => {
      const { project } = await ctx(req);
      const rows = await svc.listIssues(project, { viewerId: req.user!.id });
      const reasons = await ag.waitReasons(project, rows);
      return rows.map((row, i) => ({ ...row, analysisWaitReason: reasons[i] }));
    });
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
      await logProject(p.id, req.user!.id, 'settings_changed', { data: { fields: { defaultView: 'changed' } } });
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
      // Token (agent, MCP) czytający zgłoszenie nie oznacza go jako przeczytanego przez człowieka.
      if (req.authVia !== 'token') await svc.markSeen(req.user!.id, d.id);
      const runner = await ag.analysisRunner(p, d);
      const [waitReason] = await ag.waitReasons(p, [d]);
      return { ...d, projectKey: p.key, projectHasRepo: !!p.githubRepo, analysisWaitReason: waitReason, lastSeenAt, analysisCanRun: runner.canRun, analysisClaimedDeviceName: runner.claimedDeviceName, analysisNoCapablePc: runner.noCapablePc, teamQueue: p.agentTeamQueue };
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
      // Issues są wspólne: każdy członek projektu może usunąć każde (potwierdzenie jest w UI).
      const { p, number } = await issueRef(req, req.params.id);
      await svc.requireIssue(p, number);
      await svc.deleteIssue(p, number);
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/issues/:id/analyze', async (req, reply) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = z.object({ deep: z.boolean().default(false), local: z.boolean().default(false) }).parse(req.body ?? {});
      // Analiza czyta kod repo, więc projekt bez repo nie ma czego analizować.
      if (!p.githubRepo) return reply.code(400).send({ error: 'no_repo' });
      await svc.requestAnalysis(p, req.user, number, b.deep, b.local);
      return { ok: true };
    });
    // Agent na PC przejmuje zlecenie przed uruchomieniem (409, gdy zajęte albo nieaktualne) i oddaje je po błędzie.
    const deviceBody = z.object({ deviceId: z.string().uuid() });
    r.post<{ Params: { id: string } }>('/api/issues/:id/analyze/claim', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = deviceBody.extend({ version: z.string().max(40).optional(), engine: z.enum(['claude', 'codex']).optional() }).parse(req.body);
      return ag.claimAnalysis(p, req.user!, number, b.deviceId, b.version, b.engine === 'codex');
    });
    r.delete<{ Params: { id: string } }>('/api/issues/:id/analyze/claim', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = deviceBody.extend({ error: z.string().max(8000).optional().transform((e) => e?.slice(0, 2000)), requeue: z.boolean().optional() }).parse(req.body);
      return ag.releaseClaim(p, req.user!, number, b.deviceId, b.error, b.requeue === true);
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

    // Gotowe polecenie dla Claude Code z szablonu projektu (guziki, agent na PC; ?engine=codex podmienia skill na get_procedure).
    r.get<{ Params: { id: string; kind: string }; Querystring: { compact?: string; deep?: string; engine?: string } }>('/api/issues/:id/prompt/:kind', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const kind = z.enum(PROMPT_KINDS).parse(req.params.kind);
      const deep = req.query.deep === '1';
      // Model tylko dla analizy: agent odpala z nim claude -p.
      return { prompt: await renderPrompt(p, number, kind, req.query.compact === '1', deep, req.query.engine === 'codex'), ...(kind === 'analyze' ? { model: analysisModel(p, deep) } : {}) };
    });

    // Ślad pracy z sesji Claude Code, wysyłany przez hooki dewelopera (token API).
    r.post<{ Params: { id: string } }>('/api/issues/:id/worklog', async (req) => {
      const { p, number } = await issueRef(req, req.params.id);
      const b = z.object({
        session: z.string().min(1).max(100),
        repo: z.string().max(400).transform((s) => s.slice(0, 100)).default(''),
        files: z.array(z.string().max(1200).transform((s) => s.slice(0, 300))).max(200).default([]),
        commits: z.array(z.object({ sha: z.string().max(64), message: z.string().max(1200).transform((s) => s.slice(0, 300)) })).max(50).default([]),
        prompts: z.array(z.string().max(1600).transform((s) => s.slice(0, 400))).max(10).default([]),
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
    const relationBody = z.object({ kind: z.enum(['waits_on', 'blocks', 'related', 'duplicate_of', 'duplicated_by']), other: z.union([z.string(), z.number()]) });
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
      const { body } = z.object({ body: z.string().min(1).max(50_000) }).parse(req.body);
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
      const { body } = z.object({ body: z.string().min(1).max(50_000) }).parse(req.body);
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
      const body = z.object({ reviewNotes: z.string().max(20_000).optional(), name: z.string().min(1).optional() }).parse(req.body);
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

    // Etykieta z poziomu zgłoszenia: każdy członek projektu. Istniejąca etykieta o tej nazwie wraca bez zmian (kolor zmienia tylko admin).
    r.post('/api/labels', async (req) => {
      const b = z.object({ projectKey: z.string().optional(), name: z.string().trim().min(1).max(50), color: z.string().min(4).max(20).optional() }).parse(req.body);
      const { project } = await ctx(req, b.projectKey);
      const [existing] = await db.select().from(labels).where(and(eq(labels.projectId, project.id), dsql`lower(${labels.name}) = lower(${b.name})`));
      if (existing) return existing;
      return svc.saveLabel(project, { name: b.name, color: b.color ?? Object.values(TYPE_LABEL_COLORS)[0] });
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
      await sp.setSprintLength(await manage(req), days, new Date(), req.user!.id);
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
      // Czym konto może się logować; żadne = jeszcze się nie zalogowało (konto z allowlisty).
      hasGithub: dsql<boolean>`${users.githubId} is not null`, hasGoogle: dsql<boolean>`${users.googleId} is not null`,
      hasPassword: dsql<boolean>`${users.passwordHash} is not null`,
    }).from(users).orderBy(asc(users.name)));
    r.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-link', async (req) => inv.createResetLink(req.user!.id, intParam(req.params.id)));
    r.post('/api/admin/users', async (req) => {
      const body = z.object({
        id: z.number().int().optional(), login: z.string().min(1), name: z.string().optional(),
        isAdmin: z.boolean().optional(), active: z.boolean().optional(),
      }).parse(req.body);
      // Workspace zakłada samo konto; do projektu dodaje Projekt › Ludzie albo zaproszenie.
      // Konto z e-mailem ustawia hasło przy pierwszym logowaniu (/auth/password).
      await svc.saveUser(null, body);
      return { ok: true };
    });
  });
}
