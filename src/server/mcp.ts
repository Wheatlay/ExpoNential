import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as svc from './service.ts';
import { RuleError, identifier, parseIdentifier, PRIORITIES } from './rules.ts';
import { projectsOf, requireMember, type Project } from './projects.ts';
import { listMeetings, meetingUrl } from './meetings.ts';
import type { SessionUser } from './auth.ts';
import { addRelation, removeRelation } from './relations.ts';
import { ANALYSIS_TYPES, SECTION_KEYS, TYPE_LABEL_NAMES, analysisInputSchema, decisionSchema } from './analysis.ts';

const analysisSections = z.object(Object.fromEntries(SECTION_KEYS.map((k) => [k, z.string().optional()])));

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

/**
 * Projekt, gdy wołający go nie podał: jedyny projekt użytkownika. Przy kilku zgadywanie (dawniej zawsze ACME)
 * zapisywało notatki do zadania o tym samym numerze w innym projekcie, więc wtedy błąd z listą kluczy.
 */
async function onlyProject(me: SessionUser, what: string) {
  const mine = await projectsOf(me);
  if (mine.length === 1) return mine[0].project;
  if (!mine.length) throw new RuleError('You are not a member of any project', 'not_found');
  throw new RuleError(`${what}: you are in several projects (${mine.map((x) => x.project.key).join(', ')})`, 'invalid');
}

/** Identyfikator zadania: "WEB-12" (projekt z klucza) albo "12" (tylko gdy użytkownik ma jeden projekt). Sprawdza członkostwo. */
async function ref(me: SessionUser, id: string) {
  const r = parseIdentifier(id);
  if (!r) throw new RuleError(`Invalid issue id "${id}", expected e.g. ACME-12`, 'invalid');
  const project = r.key ? (await requireMember(me, r.key)).project : await onlyProject(me, `Use the full id (e.g. KEY-${r.number}) instead of "${id}"`);
  return { p: project, n: r.number };
}

/** Drugi identyfikator w obrębie tego samego projektu (relacje, rodzic). */
function numIn(p: Project, id: string) {
  const r = parseIdentifier(id);
  if (!r) throw new RuleError(`Invalid issue id "${id}"`, 'invalid');
  if (r.key && r.key !== p.key) throw new RuleError('Issues from different projects cannot be linked', 'invalid');
  return r.number;
}

const projectArg = z.string().optional().describe('Project key, e.g. "WEB"; required when you are in more than one project (see list_projects)');
const projectOf = async (me: SessionUser, key?: string) => (key ? (await requireMember(me, key)).project : onlyProject(me, 'Pass project'));

/** Zamienia nazwy (status, label, user) na id, tak jak robi to Linear MCP. */
async function resolver(p: Project) {
  const meta = await svc.getMeta(p);
  const lc = (s: string) => s.trim().toLowerCase();
  return {
    meta,
    status(name: string) {
      const s = meta.statuses.find((x) => lc(x.name) === lc(name));
      if (!s) throw new RuleError(`Unknown status "${name}". Available: ${meta.statuses.map((x) => x.name).join(', ')}`, 'invalid');
      return s.id;
    },
    label(name: string) {
      const l = meta.labels.find((x) => lc(x.name) === lc(name));
      if (!l) throw new RuleError(`Unknown label "${name}". Available: ${meta.labels.map((x) => x.name).join(', ')}`, 'invalid');
      return l.id;
    },
    user(q: string, me: SessionUser) {
      if (lc(q) === 'me') return me.id;
      const u = meta.users.find((x) => lc(x.login) === lc(q) || lc(x.name) === lc(q));
      if (!u) throw new RuleError(`Unknown user "${q}". Available: ${meta.users.map((x) => x.name).join(', ')}`, 'invalid');
      return u.id;
    },
    priority(p: number | string) {
      if (typeof p === 'number') return p;
      const i = PRIORITIES.findIndex((x) => lc(x) === lc(p));
      if (i < 0) throw new RuleError(`Unknown priority "${p}". Use 0-4 or ${PRIORITIES.join(', ')}`, 'invalid');
      return i;
    },
  };
}

async function presentIssue(p: Project, number: number) {
  const d = await svc.getIssueDetail(p, number);
  const r = await resolver(p);
  const identifier = (n: number) => `${p.key}-${n}`;
  const userName = (id: number | null) => (id == null ? null : r.meta.users.find((u) => u.id === id)?.name ?? null);
  return {
    id: d.identifier,
    url: `${BASE_URL}/issue/${d.identifier}`,
    title: d.title,
    description: d.description,
    status: r.meta.statuses.find((s) => s.id === d.statusId)?.name,
    priority: { value: d.priority, name: PRIORITIES[d.priority] },
    assignee: userName(d.assigneeId),
    creator: userName(d.creatorId),
    labels: d.labelIds.map((id) => r.meta.labels.find((l) => l.id === id)?.name),
    parent: d.parent ? identifier(d.parent.number) : null,
    waitingOn: d.relations.waitingOn.map((x) => ({ id: identifier(x.number), title: x.title, open: x.open })),
    blocking: d.relations.blocking.map((x) => ({ id: identifier(x.number), title: x.title, open: x.open })),
    relatedTo: d.relations.related.map((x) => ({ id: identifier(x.number), title: x.title })),
    subIssues: d.children.map((c) => ({ id: identifier(c.number), title: c.title, status: r.meta.statuses.find((s) => s.id === c.statusId)?.name })),
    question: d.infoQuestion ? { for: userName(d.infoFromId) ?? 'anyone', by: userName(d.infoById), text: d.infoQuestion } : null,
    analysis: d.analysis,
    analysisRequested: !!d.analysisRequestedAt,
    changeHuman: d.changeHuman,
    changeAi: d.changeAi,
    commits: d.commits.map((c) => ({ sha: c.sha.slice(0, 9), message: c.message.split('\n')[0], deployedAt: c.deployedAt })),
    // Ślad z sesji Claude Code (hooki): od tego zaczyna się zamykanie zadania, zamiast przekopywać rozmowę.
    worklog: d.activity.flatMap((a) => a.payload.kind === 'worklog'
      ? [{ by: userName(a.actorId), repo: a.payload.repo, startedAt: a.createdAt, updatedAt: a.payload.updatedAt, files: a.payload.files, commits: a.payload.commits, prompts: a.payload.prompts }]
      : []),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    completedAt: d.completedAt,
  };
}

function buildServer(user: SessionUser) {
  const me = { ...user, ai: true };   // zmiany przez MCP robi agent: historia pokazuje je jako AI
  const server = new McpServer({ name: 'tracker', version: '1.0.0' }, {
    instructions:
      'Team issue tracker (Linear-like) with projects. Issues are identified as <PROJECT KEY>-<number>, e.g. ACME-12 or WEB-3; always use the full identifier. ' +
      'Tools that create or list project settings take a project key (required when you belong to more than one project); list_projects shows your projects. ' +
      'list_issues without project lists issues of all your projects. ' +
      'Before moving an issue to a "completed" status (Done), fill in changeHuman and changeAi with set_change_notes (the team expects them; it is not enforced). ' +
      'Issues with analysisRequested=true are waiting for an AI analysis: list them with list_issues({analysisRequested:true}) (all your projects) and write the result with set_analysis.',
  });

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return ok(await fn(args));
      } catch (e) {
        if (e instanceof RuleError) return fail(e.message);
        throw e;
      }
    }) as never);

  tool('get_issue', 'Get an issue by identifier (e.g. ACME-12) with description, AI analysis, HUMAN/AI change notes, sub-issues, commits and the Claude Code worklog (files, commits, prompts per session).',
    { id: z.string() }, async ({ id }) => { const { p, n } = await ref(me, id); return presentIssue(p, n); });

  tool('list_projects', 'List projects you are a member of (key, name, your role).', {}, async () =>
    (await projectsOf(me)).map(({ project, role }) => ({ key: project.key, name: project.name, role })));

  tool('list_issues', 'List issues (without descriptions) of one project, or of all your projects when project is omitted. Filters are optional and combined with AND.', {
    project: z.string().optional().describe('Project key, e.g. "WEB"; omit for all your projects'),
    status: z.string().optional().describe('Status name, e.g. "Testing"'),
    assignee: z.string().optional().describe('User name, login or "me"'),
    label: z.string().optional(),
    analysisRequested: z.boolean().optional().describe('Only issues waiting for an AI analysis'),
    query: z.string().optional().describe('Case-insensitive search in title'),
    limit: z.number().int().max(250).optional(),
  }, async (a) => {
    const ps = a.project ? [await projectOf(me, a.project)] : (await projectsOf(me)).map((x) => x.project);
    const out = [];
    for (const p of ps) {
      const r = await resolver(p);
      // Przy wszystkich projektach nazwa statusu/etykiety może istnieć tylko w części z nich: tamte pomijamy.
      const find = <T>(f: () => T) => { try { return f(); } catch (e) { if (a.project) throw e; return null; } };
      const statusId = a.status ? find(() => r.status(a.status!)) : undefined;
      const assigneeId = a.assignee ? find(() => r.user(a.assignee!, me)) : undefined;
      const labelId = a.label ? find(() => r.label(a.label!)) : undefined;
      if (statusId === null || assigneeId === null || labelId === null) continue;
      let rows = await svc.listIssues(p, { statusIds: statusId ? [statusId] : undefined, assigneeId, labelId, analysisRequested: a.analysisRequested });
      if (a.query) rows = rows.filter((x) => x.title.toLowerCase().includes(a.query!.toLowerCase()));
      out.push(...rows.map((x) => ({
        id: identifier(p.key, x.number),
        title: x.title,
        status: r.meta.statuses.find((s) => s.id === x.statusId)?.name,
        // Nazwy statusów są dowolne; typ mówi agentowi, czy zgłoszenie jest zrobione (completed) albo porzucone.
        statusType: r.meta.statuses.find((s) => s.id === x.statusId)?.type,
        assignee: r.meta.users.find((u) => u.id === x.assigneeId)?.name ?? null,
        priority: PRIORITIES[x.priority],
        labels: x.labelIds.map((id) => r.meta.labels.find((l) => l.id === id)?.name),
        analysisRequested: !!x.analysisRequestedAt,
        updatedAt: x.updatedAt,
      })));
    }
    out.sort((x, y) => +new Date(y.updatedAt) - +new Date(x.updatedAt));
    return out.slice(0, a.limit ?? 50);
  });

  tool('save_issue', 'Create an issue (omit id, optional project) or update one (pass id). Only provided fields change. Labels replace the current set.', {
    id: z.string().optional(),
    project: projectArg.describe('Project key for a new issue (required when you are in more than one project); ignored when id is given'),
    title: z.string().optional(),
    description: z.string().optional().describe('Markdown'),
    status: z.string().optional(),
    assignee: z.string().nullable().optional().describe('User name, login, "me", or null to unassign'),
    priority: z.union([z.number().int().min(0).max(4), z.string()]).optional().describe('0 none, 1 urgent, 2 high, 3 medium, 4 low'),
    labels: z.array(z.string()).optional(),
    parentId: z.string().nullable().optional().describe('Parent issue identifier, null to detach'),
    askUser: z.string().optional().describe('With question: who should answer (name, login, "me" or "anyone"); use with status "Need Info"'),
    question: z.string().optional(),
  }, async (a) => {
    const target = a.id ? await ref(me, a.id) : { p: await projectOf(me, a.project), n: 0 };
    const p = target.p;
    const r = await resolver(p);
    const input: svc.IssueInput = {
      title: a.title,
      description: a.description,
      statusId: a.status ? r.status(a.status) : undefined,
      assigneeId: a.assignee === undefined ? undefined : a.assignee === null ? null : r.user(a.assignee, me),
      priority: a.priority === undefined ? undefined : r.priority(a.priority),
      labelIds: a.labels?.map((l) => r.label(l)),
      parentNumber: a.parentId === undefined ? undefined : a.parentId === null ? null : numIn(p, a.parentId),
      infoFromId: a.askUser && a.askUser.toLowerCase() !== 'anyone' ? r.user(a.askUser, me) : a.question ? null : undefined,
      infoQuestion: a.question,
    };
    if (a.id) {
      await svc.updateIssue(p, me, target.n, input);
      return presentIssue(p, target.n);
    }
    if (!a.title) throw new RuleError('title is required to create an issue', 'invalid');
    const row = await svc.createIssue(p, me, { ...input, title: a.title });
    return presentIssue(p, row.number);
  });

  tool('set_analysis',
    'Write the AI analysis of an issue. Clears the "analysis requested" flag. Preferred: type + sections + decisions; ' +
    'the tracker shows each section separately and people pick decision options there. Legacy: analysis (markdown only).',
    {
      id: z.string(),
      type: z.enum(ANALYSIS_TYPES).optional().describe('bug | feature | investigate'),
      sections: analysisSections.optional().describe(
        'Plain text in the language of the issue (match the issue description), 1-2 short sentences per section, omit empty ones. bug: verdict ("Yes · cause"), howToCheck (steps with →). ' +
        'feature: current. investigate: answer, todo. All types: system (how it fits the rest of the system), after (target state for the user), risk, related.'),
      decisions: z.array(decisionSchema).max(5).optional().describe('Questions for a human, 2-4 options each, mark one recommended. Empty when none.'),
      analysis: z.string().optional().describe('Legacy markdown analysis; ignored when type is given'),
    },
    async ({ id, type, sections, decisions, analysis }) => {
      const { p, n } = await ref(me, id);
      if (type) {
        const parsed = analysisInputSchema.safeParse({ type, sections: sections ?? {}, decisions: decisions ?? [] });
        if (!parsed.success) throw new RuleError(`Invalid analysis: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid');
        await svc.setAnalysis(p, me, n, parsed.data);
        return `Analysis saved on ${id} (label: ${TYPE_LABEL_NAMES[type]})`;
      } else {
        if (!analysis?.trim()) throw new RuleError('Provide type + sections (preferred) or analysis', 'invalid');
        await svc.updateIssue(p, me, n, { analysis });
      }
      return `Analysis saved on ${id}`;
    });

  tool('set_change_notes', 'Set the HUMAN (short, for people) and/or AI (detailed, technical) description of the changes. Expected before Done.',
    { id: z.string(), human: z.string().optional(), ai: z.string().optional() }, async ({ id, human, ai }) => {
      if (human === undefined && ai === undefined) throw new RuleError('Provide human and/or ai', 'invalid');
      const { p, n } = await ref(me, id);
      await svc.updateIssue(p, me, n, { changeHuman: human, changeAi: ai });
      return `Change notes saved on ${id}`;
    });

  tool('set_relation', 'Add or remove a relation. waits_on: this issue waits on other (other blocks it). blocks: this issue blocks other. related: plain link.',
    { id: z.string(), kind: z.enum(['waits_on', 'blocks', 'related']), otherId: z.string(), remove: z.boolean().optional() },
    async ({ id, kind, otherId, remove }) => {
      const { p, n } = await ref(me, id);
      if (remove) await removeRelation(p, me, n, kind, numIn(p, otherId));
      else await addRelation(p, me, n, kind, numIn(p, otherId));
      return `${remove ? 'Removed' : 'Added'}: ${id} ${kind.replace('_', ' ')} ${otherId}`;
    });

  tool('list_comments', 'List comments of an issue.', { id: z.string() }, async ({ id }) => {
    const { p, n } = await ref(me, id);
    const d = await svc.getIssueDetail(p, n);
    const r = await resolver(p);
    return d.comments.map((c) => ({
      id: c.id, author: r.meta.users.find((u) => u.id === c.authorId)?.name ?? null, body: c.body, createdAt: c.createdAt,
    }));
  });

  tool('save_comment', 'Add a comment to an issue (markdown).', { id: z.string(), body: z.string().min(1) }, async ({ id, body }) => {
    const { p, n } = await ref(me, id);
    const c = await svc.addComment(p, me, n, body);
    return { id: c.id, issue: id };
  });

  tool('list_issue_statuses', 'List statuses of a project with their type (backlog/unstarted/started/completed/canceled/duplicate).', { project: projectArg }, async (a) =>
    (await svc.getMeta(await projectOf(me, a.project))).statuses.map((s) => ({ name: s.name, type: s.type })));

  tool('list_issue_labels', 'List labels of a project.', { project: projectArg }, async (a) =>
    (await svc.getMeta(await projectOf(me, a.project))).labels.map((l) => ({ name: l.name, color: l.color })));

  tool('list_meetings', 'List meetings of a project: scheduled ones (incl. automatic sprint reviews) and open time polls with their proposed times and votes. Times are ISO UTC.',
    { project: projectArg }, async (a) => {
      const p = await projectOf(me, a.project);
      const r = await resolver(p);
      const name = (id: number | null) => (id == null ? null : r.meta.users.find((u) => u.id === id)?.name ?? null);
      return (await listMeetings(p, new Date(Date.now() - 864e5))).map((m) => ({
        title: m.title, kind: m.kind, status: m.status, startsAt: m.startsAt, endsAt: m.endsAt, where: m.locationUrl || null,
        organizer: name(m.createdBy), url: meetingUrl(p, m.id),
        poll: m.status === 'polling' ? m.slots.map((s) => ({
          startsAt: s.startsAt, proposedBy: name(s.proposedBy), reason: s.reason,
          votes: s.votes.map((v) => `${name(v.userId)}: ${v.vote}`),
        })) : undefined,
      }));
    });

  tool('list_users', 'List members of a project.', { project: projectArg }, async (a) =>
    (await svc.getMeta(await projectOf(me, a.project))).users.filter((u) => u.active).map((u) => ({ name: u.name, login: u.login, role: u.role })));

  return server;
}

export async function registerMcp(app: FastifyInstance) {
  // Bezstanowo: nowy serwer i transport na każde żądanie, użytkownik z tokenu Bearer.
  app.all('/mcp', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Missing or invalid API token' });
    if (req.method !== 'POST') return reply.code(405).send({ error: 'Method not allowed' });
    const server = buildServer(req.user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
