import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as svc from './service.ts';
import { RuleError, identifier, parseIdentifier, PRIORITIES } from './rules.ts';
import { projectsOf, requireMember, type Project } from './projects.ts';
import { createMeeting, listMeetings, meetingUrl, setAttendance } from './meetings.ts';
import type { SessionUser } from './auth.ts';
import { markMcpUse } from './oauth.ts';
import { procedures } from './skills/index.ts';
import { addRelation, removeRelation } from './relations.ts';
import { matchesMagic, readUpload, saveUpload } from './uploads.ts';
import { and, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { comments, issues, sprints } from '../db/schema.ts';
import { mentionsOf } from './issueMentions.ts';
import { ANALYSIS_TYPES, SECTION_KEYS, TYPE_LABEL_NAMES, analysisInputSchema, decisionSchema, parseData } from './analysis.ts';

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

async function presentIssue(me: SessionUser, p: Project, number: number) {
  const d = await svc.getIssueDetail(p, number);
  const m = await mentionsOf(me, d, d.comments);
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
    // Wzmianki z opisu i komentarzy (w obie strony), też z innych projektów użytkownika.
    mentions: m.mentions.map((x) => ({ id: x.id, title: x.title, open: x.open })),
    mentionedIn: m.mentionedIn.map((x) => ({ id: x.id, title: x.title, open: x.open })),
    duplicateOf: d.relations.duplicateOf.map((x) => ({ id: identifier(x.number), title: x.title })),
    duplicatedBy: d.relations.duplicates.map((x) => ({ id: identifier(x.number), title: x.title })),
    subIssues: d.children.map((c) => ({ id: identifier(c.number), title: c.title, status: r.meta.statuses.find((s) => s.id === c.statusId)?.name })),
    // Pytanie do osoby, do #tagu (wszyscy z tagiem) albo do kogokolwiek.
    question: d.infoQuestion ? {
      for: userName(d.infoFromId) ?? (d.infoTagId != null ? `#${r.meta.tags.find((x) => x.id === d.infoTagId)?.name ?? '?'}` : 'anyone'),
      by: userName(d.infoById), text: d.infoQuestion,
    } : null,
    pauseReason: d.pauseReason || null,
    analysis: d.analysis,
    analysisRequested: !!d.analysisRequestedAt,
    changeHuman: d.changeHuman,
    changeAi: d.changeAi,
    // Po zapisaniu opisu doszly commity: trzeba go uzupelnic (procedura close, tryb aktualizacji).
    changeNotesStale: d.changeNotesStale,
    changeNotesAt: d.changeNotesAt,
    commits: d.commits.map((c) => ({ sha: c.sha.slice(0, 9), message: c.message.split('\n')[0], deployedAt: c.deployedAt, envs: c.envs.map((e) => ({ name: e.name, at: e.at })) })),
    // Ślad z sesji Claude Code (hooki): od tego zaczyna się zamykanie zadania, zamiast przekopywać rozmowę.
    worklog: d.activity.flatMap((a) => a.payload.kind === 'worklog'
      ? [{ by: userName(a.actorId), repo: a.payload.repo, startedAt: a.createdAt, updatedAt: a.payload.updatedAt, files: a.payload.files, commits: a.payload.commits }]
      : []),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    completedAt: d.completedAt,
  };
}

/** Zakres jednego zgłoszenia (nagłówek X-Exponential-Issue: agent analizy dostaje tylko to, czego potrzebuje do jednej analizy). */
export type McpScope = { key: string; number: number };
/** Limit opisu zapisywanego przez MCP (ludzi w UI nie dotyczy): analiza agenta ma iść do set_analysis, nie do opisu. */
export const DESCRIPTION_MAX = 1500;
export const SCOPED_TOOLS =['get_issue', 'list_comments', 'get_attachment', 'get_procedure', 'set_analysis'];

export function buildServer(user: SessionUser, scope: McpScope | null = null) {
  const me = { ...user, ai: true };   // zmiany przez MCP robi agent: historia pokazuje je jako AI
  const server = new McpServer({ name: 'expo', version: '1.0.0' }, {
    instructions:
      'Team issue tracker (Linear-like) with projects. Issues are identified as <PROJECT KEY>-<number>, e.g. ACME-12 or WEB-3; always use the full identifier. ' +
      'Tools that create or list project settings take a project key (required when you belong to more than one project); list_projects shows your projects. ' +
      'list_issues without project lists issues of all your projects. ' +
      'Before moving an issue to a "completed" status (Done), fill in changeHuman and changeAi with set_change_notes (the team expects them; it is not enforced). changeNotesStale=true means commits landed after the notes were written: update them with the close procedure. ' +
      'Issues with analysisRequested=true are waiting for an AI analysis: list them with list_issues({analysisRequested:true}) (all your projects) and write the result with set_analysis. ' +
      'Before analyzing an issue or closing one (moving to Done), call get_procedure with name analyze or close and follow it. ' +
      `An issue description is short (max ${DESCRIPTION_MAX} characters): the problem and the goal, in plain language. Places in the code, risks and open questions go to set_analysis (sections and decisions), also for an issue you have just created. ` +
      'When a person answers a decision from the analysis in the chat, record it with set_decision. ' +
      'Images in descriptions and comments (/uploads/... links) need get_attachment; a plain fetch returns 401.',
  });

  const tool = <S extends z.ZodRawShape>(name: string, description: string, shape: S, fn: (a: z.infer<z.ZodObject<S>>) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        if (scope) {
          if (!SCOPED_TOOLS.includes(name)) throw new RuleError(`Tool ${name} is not available in the scope of ${identifier(scope.key, scope.number)}`, 'forbidden');
          const id = (args as { id?: string }).id;
          if (id !== undefined) {
            const r = parseIdentifier(id);
            if (!r || r.key !== scope.key || r.number !== scope.number) throw new RuleError(`This session is limited to ${identifier(scope.key, scope.number)}`, 'forbidden');
          }
        }
        return ok(await fn(args));
      } catch (e) {
        if (e instanceof RuleError) return fail(e.message);
        throw e;
      }
    }) as never);

  tool('get_procedure', 'Step-by-step procedure for analyzing an issue (analyze) or closing it with change notes (close). Call it before doing either.',
    { name: z.enum(['analyze', 'close']) }, async ({ name }) => procedures[name].text);

  const promptFor = (name: 'analyze' | 'close', id: string) => ({
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${procedures[name].text}\n\nIssue: ${id}` } }],
  });
  server.registerPrompt('analyze_issue', { description: procedures.analyze.title, argsSchema: { id: z.string().describe('Issue identifier, e.g. ACME-12') } }, ({ id }) => promptFor('analyze', id));
  server.registerPrompt('close_issue', { description: procedures.close.title, argsSchema: { id: z.string().describe('Issue identifier, e.g. ACME-12') } }, ({ id }) => promptFor('close', id));

  tool('get_issue', 'Get an issue by identifier (e.g. ACME-12) with description, AI analysis, HUMAN/AI change notes, sub-issues, commits and the Claude Code worklog (files and commits per session). history: true adds who changed what and when.',
    { id: z.string(), history: z.boolean().optional() }, async ({ id, history }) => {
      const { p, n } = await ref(me, id);
      const out = await presentIssue(me, p, n);
      if (!history) return out;
      // Historia bez tego, co już jest w commits/worklog; jedna płaska linia na zdarzenie.
      const d = await svc.getIssueDetail(p, n);
      const users = (await svc.getMeta(p)).users;
      return { ...out, history: d.activity.filter((a) => !['worklog', 'commit'].includes(a.payload.kind)).map((a) => ({ at: a.createdAt, by: users.find((u) => u.id === a.actorId)?.name ?? null, ...(a.viaAi ? { ai: true } : {}), ...a.payload })) };
    });

  tool('list_projects', 'List projects you are a member of (key, name, your role).', {}, async () =>
    (await projectsOf(me)).map(({ project, role }) => ({ key: project.key, name: project.name, role })));

  tool('list_issues', 'List issues (without descriptions) of one project, or of all your projects when project is omitted. Filters are optional and combined with AND.', {
    project: z.string().optional().describe('Project key, e.g. "WEB"; omit for all your projects'),
    status: z.string().optional().describe('Status name, e.g. "Testing"'),
    assignee: z.string().optional().describe('User name, login or "me"'),
    label: z.string().optional(),
    analysisRequested: z.boolean().optional().describe('Only issues waiting for an AI analysis'),
    query: z.string().optional().describe('Case-insensitive search in title, description and comments'),
    sprint: z.string().optional().describe('"current" or a sprint name'),
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
      let sprintId: number | undefined;
      if (a.sprint) {
        const all = await db.select({ id: sprints.id, name: sprints.name, status: sprints.status }).from(sprints).where(eq(sprints.projectId, p.id));
        const sp = a.sprint.toLowerCase() === 'current' ? all.find((s) => s.status === 'active') : all.find((s) => s.name.toLowerCase() === a.sprint!.toLowerCase());
        if (!sp) { if (a.project) throw new RuleError(a.sprint.toLowerCase() === 'current' ? 'No active sprint' : 'Unknown sprint "' + a.sprint + '". Available: ' + all.map((s) => s.name).join(', '), 'invalid'); continue; }
        sprintId = sp.id;
      }
      let rows = await svc.listIssues(p, { statusIds: statusId ? [statusId] : undefined, assigneeId, labelId, sprintId, analysisRequested: a.analysisRequested });
      if (a.query) {
        const q = '%' + a.query.replace(/[%_]/g, (c) => String.fromCharCode(92) + c) + '%';
        const hits = new Set((await db.selectDistinct({ id: issues.id }).from(issues).leftJoin(comments, eq(comments.issueId, issues.id))
          .where(and(eq(issues.projectId, p.id), or(ilike(issues.title, q), ilike(issues.description, q), ilike(comments.body, q))))).map((r) => r.id));
        rows = rows.filter((x) => hits.has(x.id));
      }
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
    description: z.string().optional().describe(`Markdown, max ${DESCRIPTION_MAX} characters: the problem and the goal only. Code locations, risks and open questions go to set_analysis`),
    status: z.string().optional(),
    assignee: z.string().nullable().optional().describe('User name, login, "me", or null to unassign'),
    priority: z.union([z.number().int().min(0).max(4), z.string()]).optional().describe('0 none, 1 urgent, 2 high, 3 medium, 4 low'),
    labels: z.array(z.string()).optional(),
    parentId: z.string().nullable().optional().describe('Parent issue identifier, null to detach'),
    askUser: z.string().optional().describe('With question: who should answer (name, login, "me", "#tag" for everyone with that people tag, or "anyone"); use with status "Need Info"'),
    question: z.string().optional(),
    pauseReason: z.string().optional().describe('Why the issue is paused; use with a status whose role is paused (see list_issue_statuses)'),
    pauseWaitsOn: z.string().optional().describe('Identifier of the issue this one waits on; use with a status whose role is paused. The issue returns to its previous status when that one closes'),
  }, async (a) => {
    if (a.description && a.description.length > DESCRIPTION_MAX) {
      throw new RuleError(`Description has ${a.description.length} characters, the limit is ${DESCRIPTION_MAX}. Keep the problem and the goal in the description; ` +
        'move code locations, risks and open questions to set_analysis (sections and decisions).', 'invalid');
    }
    const target = a.id ? await ref(me, a.id) : { p: await projectOf(me, a.project), n: 0 };
    const p = target.p;
    const r = await resolver(p);
    // "#backend" = pytanie do wszystkich z tagiem osób.
    const askTag = a.askUser?.startsWith('#') ? a.askUser.slice(1).toLowerCase() : null;
    const tagId = (name: string) => {
      const tag = r.meta.tags.find((x) => x.name === name);
      if (!tag) throw new RuleError(`Unknown tag #${name}. Tags: ${r.meta.tags.map((x) => '#' + x.name).join(', ') || 'none'}`, 'invalid');
      return tag.id;
    };
    const input: svc.IssueInput = {
      title: a.title,
      description: a.description,
      statusId: a.status ? r.status(a.status) : undefined,
      assigneeId: a.assignee === undefined ? undefined : a.assignee === null ? null : r.user(a.assignee, me),
      priority: a.priority === undefined ? undefined : r.priority(a.priority),
      labelIds: a.labels?.map((l) => r.label(l)),
      parentNumber: a.parentId === undefined ? undefined : a.parentId === null ? null : numIn(p, a.parentId),
      infoFromId: !a.question ? undefined : askTag ? null : a.askUser && a.askUser.toLowerCase() !== 'anyone' ? r.user(a.askUser, me) : null,
      infoTagId: !a.question ? undefined : askTag ? tagId(askTag) : null,
      infoQuestion: a.question,
      pauseReason: a.pauseReason,
      pauseWaitsOn: a.pauseWaitsOn ? numIn(p, a.pauseWaitsOn) : undefined,
    };
    if (a.id) {
      await svc.updateIssue(p, me, target.n, input);
      return presentIssue(me, p, target.n);
    }
    if (!a.title) throw new RuleError('title is required to create an issue', 'invalid');
    const row = await svc.createIssue(p, me, { ...input, title: a.title });
    return presentIssue(me, p, row.number);
  });

  tool('set_analysis',
    'Write the AI analysis of an issue. Clears the "analysis requested" flag. Preferred: type + sections + decisions; ' +
    'the tracker shows each section separately and people pick decision options there. Legacy: analysis (markdown only).',
    {
      id: z.string(),
      type: z.enum(ANALYSIS_TYPES).optional().describe('bug | feature | investigate'),
      sections: analysisSections.optional().describe(
        'Plain text in the language of the issue (match the issue description), 1-2 short sentences per section, omit empty ones. bug: verdict ("Yes · cause"), howToCheck (steps with →). ' +
        'feature: current. investigate: answer. All types: system (other places in the code that use the same thing), risk, related. todo and after are legacy, do not write them.'),
      decisions: z.array(decisionSchema).max(5).optional().describe('Questions for a human, 2-4 options each, mark one recommended. Empty when none.'),
      analysis: z.string().optional().describe('Legacy markdown analysis; ignored when type is given'),
      label: z.boolean().optional().describe('false when the type cannot be confidently assigned (e.g. test, empty or unclear issue): no type label is set. Default true.'),
    },
    async ({ id, type, sections, decisions, analysis, label }) => {
      const { p, n } = await ref(me, id);
      if (type) {
        const parsed = analysisInputSchema.safeParse({ type, sections: sections ?? {}, decisions: decisions ?? [], label });
        if (!parsed.success) throw new RuleError(`Invalid analysis: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid');
        await svc.setAnalysis(p, me, n, parsed.data);
        return `Analysis saved on ${id} (label: ${parsed.data.label === false ? 'none' : TYPE_LABEL_NAMES[type]})`;
      } else {
        if (!analysis?.trim()) throw new RuleError('Provide type + sections (preferred) or analysis', 'invalid');
        await svc.updateIssue(p, me, n, { analysis });
      }
      return `Analysis saved on ${id}`;
    });

  tool('set_decision',
    'Record a person\'s answer to a decision from the AI analysis (the same as picking it in the tracker). Use it after asking them in the chat. ' +
    'Give option (its label) or other (own answer); both empty clears the choice.',
    {
      id: z.string(),
      decision: z.number().int().min(1).describe('Decision number as listed in the analysis (1 = first)'),
      option: z.string().optional().describe('Label of the chosen option, as in the analysis'),
      other: z.string().optional().describe('Own answer when none of the options fits'),
    },
    async ({ id, decision, option, other }) => {
      const { p, n } = await ref(me, id);
      const d = parseData((await svc.getIssueDetail(p, n)).analysisData)?.decisions[decision - 1];
      if (!d) throw new RuleError(`${id} has no decision ${decision}`, 'invalid');
      let index: number | null = null;
      if (option?.trim()) {
        const norm = (s: string) => s.trim().toLowerCase();
        index = d.options.findIndex((o) => norm(o.label) === norm(option));
        if (index < 0) throw new RuleError(`Unknown option "${option}". Options: ${d.options.map((o) => o.label).join(', ')}`, 'invalid');
      }
      await svc.chooseDecision(p, me, n, decision - 1, index, index == null ? other ?? '' : '');
      return `Decision ${decision} on ${id}: ${index != null ? d.options[index].label : other?.trim() || 'cleared'}`;
    });

  tool('set_change_notes','Set the HUMAN (short, for people) and/or AI (detailed, technical) description of the changes. Expected before Done.',
    { id: z.string(), human: z.string().optional(), ai: z.string().optional() }, async ({ id, human, ai }) => {
      if (human === undefined && ai === undefined) throw new RuleError('Provide human and/or ai', 'invalid');
      const { p, n } = await ref(me, id);
      await svc.updateIssue(p, me, n, { changeHuman: human, changeAi: ai });
      return `Change notes saved on ${id}`;
    });

  tool('set_relation', 'Add or remove a relation (plain links between issues are not a relation: mention the id, e.g. ACME-12, in the description or a comment; get_issue lists them as mentions). waits_on: this issue waits on other (other blocks it). blocks: this issue blocks other. duplicate_of: this issue is a duplicate of other (the original); duplicated_by: the reverse.',
    { id: z.string(), kind: z.enum(['waits_on', 'blocks', 'duplicate_of', 'duplicated_by']), otherId: z.string(), remove: z.boolean().optional() },
    async ({ id, kind, otherId, remove }) => {
      const { p, n } = await ref(me, id);
      if (remove) await removeRelation(p, me, n, kind, numIn(p, otherId));
      else await addRelation(p, me, n, kind, numIn(p, otherId));
      return `${remove ? 'Removed' : 'Added'}: ${id} ${kind.replaceAll('_', ' ')} ${otherId}`;
    });

  tool('list_comments', 'List comments of an issue.', { id: z.string() }, async ({ id }) => {
    const { p, n } = await ref(me, id);
    const d = await svc.getIssueDetail(p, n);
    const r = await resolver(p);
    return d.comments.map((c) => ({
      id: c.id, author: r.meta.users.find((u) => u.id === c.authorId)?.name ?? null, body: c.body, createdAt: c.createdAt,
    }));
  });

  // Obrazki z opisu i komentarzy (/uploads/...): bez sesji link zwraca 401, więc agent bierze je tędy.
  // Zwraca treść typu image, więc z pominięciem tool() (ten pakuje wynik w tekst).
  server.registerTool('get_attachment', {
    description: 'Get an image attached to an issue description or comment (a /uploads/... link, relative or full URL). Plain HTTP fetches of these links return 401; use this tool instead.',
    inputSchema: { url: z.string() },
  }, async ({ url }) => {
    try {
      if (scope) {
        // Sesja jednego zgłoszenia: tylko obrazki, które to zgłoszenie faktycznie zawiera.
        const d = await svc.getIssueDetail((await requireMember(me, scope.key)).project, scope.number);
        const name = /\/uploads\/([^/?#]+)/.exec(url)?.[1];
        const texts = [d.description, d.analysis, ...d.comments.map((c) => c.body)];
        if (!name || !texts.some((t) => t.includes(`/uploads/${name}`))) return fail(`This session is limited to attachments of ${identifier(scope.key, scope.number)}`);
      }
      const f = readUpload(url);
      if (!f) return fail(`No uploaded image at "${url}"`);
      return { content: [{ type: 'image' as const, data: f.data.toString('base64'), mimeType: f.mimeType }] };
    } catch (e) {
      if (e instanceof RuleError) return fail(e.message);
      throw e;
    }
  });

  tool('save_comment', 'Add a comment to an issue (markdown), or edit your own one (commentId). images: PNG/JPEG/GIF/WebP as base64, appended to the body.', {
    id: z.string(), body: z.string().min(1), commentId: z.number().int().optional(),
    images: z.array(z.object({ data: z.string(), mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']) })).max(5).optional(),
  }, async ({ id, body, commentId, images }) => {
    const { p, n } = await ref(me, id);
    const urls = (images ?? []).map((im) => {
      const ext = im.mimeType.split('/')[1].replace('jpeg', 'jpg');
      const buf = Buffer.from(im.data, 'base64');
      if (!matchesMagic(ext, buf)) throw new RuleError('Image content does not match ' + im.mimeType, 'invalid');
      if (buf.length > 10 * 1024 * 1024) throw new RuleError('Image too large (max 10 MB)', 'invalid');
      return saveUpload(buf, ext, me.id);
    });
    const text = [body, ...urls.map((u) => '![](' + u + ')')].join('\n\n');
    if (commentId != null) { await svc.updateComment(p, me, commentId, text); return { id: commentId, issue: id }; }
    const c = await svc.addComment(p, me, n, text);
    return { id: c.id, issue: id };
  });

  tool('list_issue_statuses', 'List statuses of a project with their type (backlog/unstarted/started/completed/canceled/duplicate) and role (need_info/testing/paused/in_progress or null). Status names are free: recognize special statuses by role, never by name.', { project: projectArg }, async (a) =>
    (await svc.getMeta(await projectOf(me, a.project))).statuses.map((s) => ({ name: s.name, type: s.type, role: s.role })));

  tool('list_issue_labels', 'List labels of a project.', { project: projectArg }, async (a) =>
    (await svc.getMeta(await projectOf(me, a.project))).labels.map((l) => ({ name: l.name, color: l.color })));

  tool('list_meetings', 'List meetings of a project: scheduled ones (incl. automatic sprint reviews) and open time polls with their proposed times and votes. Times are ISO UTC.',
    { project: projectArg }, async (a) => {
      const p = await projectOf(me, a.project);
      const r = await resolver(p);
      const name = (id: number | null) => (id == null ? null : r.meta.users.find((u) => u.id === id)?.name ?? null);
      return (await listMeetings(p, new Date(Date.now() - 864e5))).map((m) => ({
        id: m.id, title: m.title, kind: m.kind, status: m.status, startsAt: m.startsAt, endsAt: m.endsAt, where: m.locationUrl || null,
        organizer: name(m.createdBy), url: meetingUrl(p, m.id),
        invited: m.attendeeIds ? m.attendeeIds.map(name) : 'whole team',
        attendance: m.kind === 'fixed' ? m.attendance.map((x) => `${name(x.userId)}: ${x.answer}${x.note ? ` (${x.note})` : ''}`) : undefined,
        poll: m.status === 'polling' ? m.slots.map((s) => ({
          startsAt: s.startsAt, proposedBy: name(s.proposedBy), reason: s.reason,
          votes: s.votes.map((v) => `${name(v.userId)}: ${v.vote}`),
        })) : undefined,
      }));
    });

  tool('save_meeting', 'Schedule a meeting in a project (fixed time, like the Meetings tab). Times are ISO 8601 with the UTC offset of the people meeting, e.g. 2026-11-12T11:30:00+01:00. The team gets the usual notifications and reminders. The time stays fixed (also for meetings set by someone outside the team); invitees answer whether they come with set_attendance.',
    {
      project: projectArg,
      title: z.string().min(1).max(200),
      startsAt: z.string().describe('Start, ISO 8601 with offset'),
      endsAt: z.string().optional().describe('End, ISO 8601 with offset; default startsAt + durationMinutes'),
      durationMinutes: z.number().int().min(5).max(1440).optional().describe('Used when endsAt is missing; default 60'),
      agenda: z.string().max(10000).optional(),
      locationUrl: z.string().max(500).optional(),
      attendees: z.array(z.string()).max(200).optional().describe('Names or logins ("me" for you); omitted = whole team'),
    }, async (a) => {
      const p = await projectOf(me, a.project);
      const at = (v: string, what: string) => {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new RuleError(`Invalid ${what} "${v}", expected ISO 8601, e.g. 2026-11-12T11:30:00+01:00`, 'invalid');
        return d;
      };
      const startsAt = at(a.startsAt, 'startsAt');
      const endsAt = a.endsAt ? at(a.endsAt, 'endsAt') : new Date(startsAt.getTime() + (a.durationMinutes ?? 60) * 60e3);
      const r = await resolver(p);
      const attendeeIds = a.attendees?.length ? a.attendees.map((x) => r.user(x, me)) : null;
      const m = await createMeeting(p, { id: me.id, name: me.name }, {
        title: a.title, kind: 'fixed', startsAt, endsAt, agenda: a.agenda, locationUrl: a.locationUrl, attendeeIds,
      });
      return { id: m.id, title: m.title, startsAt: m.startsAt, endsAt: m.endsAt, url: meetingUrl(p, m.id) };
    });

  tool('set_attendance', 'Answer whether you come to a fixed-time meeting: yes, maybe (with an optional note) or no; null takes the answer back. Meeting id from list_meetings.',
    {
      project: projectArg,
      meetingId: z.number().int(),
      answer: z.enum(['yes', 'maybe', 'no']).nullable(),
      note: z.string().max(200).optional().describe('Only with maybe, e.g. "joining for the second half"'),
    }, async (a) => {
      const p = await projectOf(me, a.project);
      await setAttendance(p, { id: me.id, name: me.name }, a.meetingId, a.answer, a.note);
      return a.answer ? `Answered ${a.answer}` : 'Answer removed';
    });

  tool('list_users', 'List members of a project with their people tags (usable as askUser "#tag").', { project: projectArg }, async (a) => {
    const meta = await svc.getMeta(await projectOf(me, a.project));
    return meta.users.filter((u) => u.active).map((u) => {
      const tags = u.tagIds.map((t) => meta.tags.find((x) => x.id === t)?.name).filter(Boolean);
      return { name: u.name, login: u.login, role: u.role, ...(tags.length ? { tags } : {}) };
    });
  });

  return server;
}

export async function registerMcp(app: FastifyInstance) {
  // Bezstanowo: nowy serwer i transport na każde żądanie, użytkownik z tokenu Bearer.
  app.all('/mcp', async (req, reply) => {
    if (!req.user) {
      return reply.code(401).header('WWW-Authenticate', `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`)
        .send({ error: 'Missing or invalid API token' });
    }
    await markMcpUse(req);
    if (req.method !== 'POST') return reply.code(405).send({ error: 'Method not allowed' });
    // Zakres jednego zgłoszenia: nagłówek z kluczem zgłoszenia (np. ACME-12) zawęża narzędzia do analizy tego zgłoszenia.
    const scopeHeader = req.headers['x-exponential-issue'];
    let scope: McpScope | null = null;
    if (typeof scopeHeader === 'string' && scopeHeader.trim()) {
      const r = parseIdentifier(scopeHeader.trim());
      if (!r?.key) return reply.code(400).send({ error: 'Invalid X-Exponential-Issue header, expected e.g. ACME-12' });
      scope = { key: r.key, number: r.number };
    }
    const server = buildServer(req.user, scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
}
