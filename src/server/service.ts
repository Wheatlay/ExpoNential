import { and, asc, desc, eq, inArray, isNotNull, isNull, sql as dsql } from 'drizzle-orm';
import { db, sql, type Tx } from '../db/index.ts';
import {
  activity, comments, issueCommits, issueLabels, issueViews, issues, labels, projectMembers, projects, sprints, statuses, users,
  type ActivityPayload,
} from '../db/schema.ts';
import { RuleError, identifier, isNeedInfo, PRIORITIES } from './rules.ts';
import { relationsOf } from './relations.ts';
import { listAllProjects, seedProjectStatuses, type Project } from './projects.ts';
import { TYPE_LABEL_COLORS, TYPE_LABEL_NAMES, chosenText, fromInput, parseData, render, type AnalysisData, type AnalysisInput } from './analysis.ts';

export type Actor = { id: number; name: string; ai?: boolean } | null;
export type { Project };

// ---------- realtime ----------

/**
 * Każda zmiana leci przez NOTIFY, więc SSE działa też przy kilku instancjach.
 * projectKey: klient ignoruje zdarzenia projektów, których nie ogląda.
 */
export async function publish(event: { type: string; projectKey?: string; number?: number; [k: string]: unknown }) {
  await sql.notify('tracker_events', JSON.stringify(event));
}

// ---------- seed ----------

/** Każdy projekt bez statusów dostaje domyślne (pierwszy admin zakłada projekt w pustej bazie). */
export async function seedDefaults() {
  for (const p of await listAllProjects()) await seedProjectStatuses(p.id);
}

// ---------- odczyt ----------

export async function getMeta(p: Project) {
  const [st, lb, us] = await Promise.all([
    db.select().from(statuses).where(eq(statuses.projectId, p.id)).orderBy(asc(statuses.position)),
    db.select().from(labels).where(eq(labels.projectId, p.id)).orderBy(asc(labels.name)),
    // Ludzie projektu (do przypisywania, pytań, awatarów).
    db.select({ id: users.id, login: users.login, name: users.name, avatarUrl: users.avatarUrl, isAdmin: users.isAdmin, active: users.active, role: projectMembers.role })
      .from(projectMembers).innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, p.id)).orderBy(asc(users.name)),
  ]);
  return { statuses: st, labels: lb, users: us, priorities: PRIORITIES };
}

/** Lekka lista do boardu: bez opisów i pól tekstowych. */
export async function listIssues(p: Project, filter: {
  viewerId?: number;
  statusIds?: number[]; assigneeId?: number | null; labelId?: number; sprintId?: number; analysisRequested?: boolean; limit?: number;
} = {}) {
  const conds = [eq(issues.projectId, p.id)];
  if (filter.statusIds?.length) conds.push(inArray(issues.statusId, filter.statusIds));
  if (filter.assigneeId !== undefined) conds.push(filter.assigneeId === null ? dsql`${issues.assigneeId} is null` : eq(issues.assigneeId, filter.assigneeId));
  if (filter.sprintId !== undefined) conds.push(eq(issues.sprintId, filter.sprintId));
  if (filter.analysisRequested) conds.push(isNotNull(issues.analysisRequestedAt));
  if (filter.labelId !== undefined) {
    conds.push(dsql`exists (select 1 from issue_labels il where il.issue_id = "issues"."id" and il.label_id = ${filter.labelId})`);
  }
  const rows = await db.select({
    id: issues.id, number: issues.number, title: issues.title, statusId: issues.statusId,
    assigneeId: issues.assigneeId, creatorId: issues.creatorId, priority: issues.priority, parentId: issues.parentId,
    sprintId: issues.sprintId, sortOrder: issues.sortOrder,
    analysisRequestedAt: issues.analysisRequestedAt,
    hasAnalysis: dsql<boolean>`${issues.analysis} <> ''`,
    hasChangeNotes: dsql<boolean>`${issues.changeHuman} <> '' and ${issues.changeAi} <> ''`,
    createdAt: issues.createdAt, updatedAt: issues.updatedAt, completedAt: issues.completedAt,
    labelIds: dsql<number[]>`coalesce((select array_agg(label_id) from issue_labels where issue_id = "issues"."id"), '{}')`,
    subTotal: dsql<number>`(select count(*)::int from issues c where c.parent_id = "issues"."id")`,
    // Czy zadanie było kiedyś w statusie testowym (do ostrzeżenia przy Done z pominięciem testów).
    wasTested: dsql<boolean>`exists (select 1 from activity a where a.issue_id = "issues"."id" and a.payload->>'kind' = 'status' and a.payload->>'to' in (select s.name from statuses s where s.project_id = "issues"."project_id" and s.role = 'testing'))`,
    // Niezamknięte zadania, na które to zadanie czeka (relacja blocks).
    infoFromId: issues.infoFromId, infoQuestion: issues.infoQuestion, infoById: issues.infoById,
    // Komentarze innych od ostatniego otwarcia zadania (bez wizyty: od założenia konta).
    unreadComments: filter.viewerId ? dsql<number>`(select count(*)::int from comments c where c.issue_id = "issues"."id"
      and c.author_id is distinct from ${filter.viewerId}
      and c.created_at > coalesce((select v.seen_at from issue_views v where v.user_id = ${filter.viewerId} and v.issue_id = "issues"."id"),
        (select u.created_at from users u where u.id = ${filter.viewerId})))` : dsql<number>`0`,
    waitingOn: dsql<number[]>`coalesce((select array_agg(b.number order by b.number) from issue_relations r join issues b on b.id = r.from_issue_id join statuses bs on bs.id = b.status_id where r.kind = 'blocks' and r.to_issue_id = "issues"."id" and bs.type in ('backlog','unstarted','started')), '{}')`,
    subDone: dsql<number>`(select count(*)::int from issues c join statuses s on s.id = c.status_id where c.parent_id = "issues"."id" and s.type in ('completed','canceled','duplicate'))`,
  }).from(issues)
    .where(and(...conds))
    .orderBy(asc(issues.sortOrder), desc(issues.number))
    .limit(filter.limit ?? 5000);
  return rows;
}

export async function findIssueByNumber(p: Project, number: number, tx: Tx | typeof db = db) {
  const [row] = await tx.select().from(issues).where(and(eq(issues.projectId, p.id), eq(issues.number, number)));
  return row ?? null;
}

export async function requireIssue(p: Project, number: number, tx: Tx | typeof db = db) {
  const row = await findIssueByNumber(p, number, tx);
  if (!row) throw new RuleError(`${identifier(p.key, number)} not found`, 'not_found');
  return row;
}

export async function getIssueDetail(p: Project, number: number) {
  const issue = await requireIssue(p, number);
  const [lbl, children, cmts, act, commits, parent] = await Promise.all([
    db.select({ id: labels.id }).from(issueLabels).innerJoin(labels, eq(labels.id, issueLabels.labelId)).where(eq(issueLabels.issueId, issue.id)),
    db.select({ number: issues.number, title: issues.title, statusId: issues.statusId, assigneeId: issues.assigneeId, priority: issues.priority, hasChangeNotes: dsql<boolean>`${issues.changeHuman} <> '' and ${issues.changeAi} <> ''` })
      .from(issues).where(eq(issues.parentId, issue.id)).orderBy(asc(issues.number)),
    db.select().from(comments).where(eq(comments.issueId, issue.id)).orderBy(asc(comments.createdAt)),
    db.select().from(activity).where(eq(activity.issueId, issue.id)).orderBy(asc(activity.createdAt)),
    db.select().from(issueCommits).where(eq(issueCommits.issueId, issue.id)).orderBy(asc(issueCommits.committedAt)),
    issue.parentId
      ? db.select({ number: issues.number, title: issues.title }).from(issues).where(eq(issues.id, issue.parentId))
      : Promise.resolve([]),
  ]);
  const relations = await relationsOf(issue.id);
  return {
    ...issue,
    identifier: identifier(p.key, issue.number),
    relations,
    labelIds: lbl.map((l) => l.id),
    parent: parent[0] ?? null,
    children,
    comments: cmts,
    activity: act,
    commits,
  };
}

// ---------- zapis ----------

export async function log(tx: Tx, issueId: number, actor: Actor, payload: ActivityPayload, at?: Date) {
  await tx.insert(activity).values({ issueId, actorId: actor?.id ?? null, viaAi: !!actor?.ai, payload, ...(at ? { createdAt: at } : {}) });
}

async function nextNumber(tx: Tx, p: Project) {
  // Licznik w projekcie: numer usuniętego zgłoszenia nie wraca do obiegu (linki i commity wskazywałyby inne zgłoszenie).
  const [r] = await tx.update(projects).set({ issueSeq: dsql`${projects.issueSeq} + 1` }).where(eq(projects.id, p.id)).returning({ n: projects.issueSeq });
  return r.n;
}

async function resolveParent(tx: Tx, p: Project, parentNumber: number | null | undefined, selfId?: number) {
  if (parentNumber == null) return null;
  const parent = await requireIssue(p, parentNumber, tx);
  if (selfId && parent.id === selfId) throw new RuleError('An issue cannot be its own parent', 'invalid');
  if (selfId) {
    const rows = await tx.execute(dsql`with recursive up(id, parent_id) as (select id, parent_id from issues where id = ${parent.id} union all select i.id, i.parent_id from issues i join up on i.id = up.parent_id) select 1 from up where id = ${selfId} limit 1`);
    if ((rows as unknown as unknown[]).length) throw new RuleError('This would create a parent loop', 'invalid');
  }
  return parent.id;
}

/** Sprint i etykiety muszą należeć do projektu zadania (id są globalne). */
async function checkSprint(tx: Tx, p: Project, sprintId: number) {
  const [sp] = await tx.select().from(sprints).where(and(eq(sprints.id, sprintId), eq(sprints.projectId, p.id)));
  if (!sp) throw new RuleError('Unknown sprint', 'invalid');
  return sp;
}

async function checkLabels(tx: Tx, p: Project, labelIds: number[]) {
  if (!labelIds.length) return;
  const found = await tx.select({ id: labels.id }).from(labels).where(and(inArray(labels.id, labelIds), eq(labels.projectId, p.id)));
  if (found.length !== new Set(labelIds).size) throw new RuleError('Unknown label', 'invalid');
}

async function checkMember(tx: Tx, p: Project, userId: number) {
  const [m] = await tx.select().from(projectMembers).where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, userId)));
  if (!m) throw new RuleError('This person is not a member of the project', 'invalid');
}

export type IssueInput = {
  title?: string;
  description?: string;
  statusId?: number;
  assigneeId?: number | null;
  priority?: number;
  labelIds?: number[];
  parentNumber?: number | null;
  sprintId?: number | null;
  sortOrder?: number;
  analysis?: string;
  /** Tylko z setAnalysis: dane analizy. Zmiana samego `analysis` (edycja tekstu) je czyści. */
  analysisData?: AnalysisData | null;
  changeHuman?: string;
  changeAi?: string;
  /** Need Info: kogo pytamy i o co (wymagane razem przy wejściu w Need Info z UI). */
  infoFromId?: number | null;
  infoQuestion?: string;
};

export async function createIssue(p: Project, actor: Actor, input: IssueInput & { title: string }) {
  const result = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, p);
    let statusId = input.statusId;
    if (!statusId) {
      const [todo] = await tx.select().from(statuses).where(and(eq(statuses.projectId, p.id), eq(statuses.type, 'unstarted'))).orderBy(asc(statuses.position)).limit(1);
      if (!todo) throw new RuleError('The project has no "unstarted" status', 'invalid');
      statusId = todo.id;
    }
    const [st] = await tx.select().from(statuses).where(and(eq(statuses.id, statusId), eq(statuses.projectId, p.id)));
    if (!st) throw new RuleError('Unknown status', 'invalid');
    if (input.sprintId != null) await checkSprint(tx, p, input.sprintId);
    if (input.labelIds) await checkLabels(tx, p, input.labelIds);
    if (input.assigneeId != null) await checkMember(tx, p, input.assigneeId);
    const [{ minSort }] = await tx.select({ minSort: dsql<number>`coalesce(min(${issues.sortOrder}), 0)` }).from(issues).where(eq(issues.statusId, statusId));
    const [row] = await tx.insert(issues).values({
      projectId: p.id,
      number,
      title: input.title.trim(),
      description: input.description ?? '',
      statusId,
      assigneeId: input.assigneeId ?? null,
      creatorId: actor?.id ?? null,
      priority: input.priority ?? 0,
      parentId: await resolveParent(tx, p, input.parentNumber),
      sprintId: input.sprintId ?? null,
      sortOrder: input.sortOrder ?? minSort - 1,
      analysis: input.analysis ?? '',
      changeHuman: input.changeHuman ?? '',
      changeAi: input.changeAi ?? '',
      completedAt: st.type === 'completed' ? new Date() : null,
    }).returning();
    if (input.labelIds?.length) {
      await tx.insert(issueLabels).values(input.labelIds.map((labelId) => ({ issueId: row.id, labelId })));
    }
    await log(tx, row.id, actor, { kind: 'created' });
    return row;
  });
  await publish({ type: 'issue', projectKey: p.key, number: result.number });
  return result;
}

export async function updateIssue(p: Project, actor: Actor, number: number, patch: IssueInput) {
  const result = await db.transaction(async (tx) => {
    const cur = await requireIssue(p, number, tx);
    const set: Partial<typeof issues.$inferInsert> = {};
    const allStatuses = await tx.select().from(statuses).where(eq(statuses.projectId, p.id));
    const statusById = new Map(allStatuses.map((s) => [s.id, s]));
    const userName = async (id: number | null) => {
      if (id == null) return null;
      const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
      return u?.name ?? null;
    };

    if (patch.title !== undefined && patch.title.trim() !== cur.title) {
      if (!patch.title.trim()) throw new RuleError('Title cannot be empty', 'invalid');
      set.title = patch.title.trim();
      await log(tx, cur.id, actor, { kind: 'field', field: 'title' });
    }
    for (const [key, field] of [['description', 'description'], ['analysis', 'analysis'], ['changeHuman', 'change_human'], ['changeAi', 'change_ai']] as const) {
      const v = patch[key];
      if (v !== undefined && v !== cur[key]) {
        set[key] = v;
        await log(tx, cur.id, actor, { kind: 'field', field });
      }
    }
    if (patch.analysis !== undefined && patch.analysis !== cur.analysis) {
      set.analysisUpdatedAt = new Date();
      set.analysisRequestedAt = null;
      Object.assign(set, NO_CLAIM);
      if (cur.analysisRequestedAt) set.analysisResultDeep = cur.analysisDeep;
      // Ręcznie poprawiony tekst nie zgadza się już z sekcjami: zostaje sam tekst.
      if (patch.analysisData === undefined) set.analysisData = null;
    }
    if (patch.analysisData !== undefined) {
      set.analysisData = patch.analysisData;
      set.analysisUpdatedAt = new Date();
      set.analysisRequestedAt = null;
      Object.assign(set, NO_CLAIM);
      if (cur.analysisRequestedAt) set.analysisResultDeep = cur.analysisDeep;
    }

    if (patch.statusId !== undefined && patch.statusId !== cur.statusId) {
      const to = statusById.get(patch.statusId);
      if (!to) throw new RuleError('Unknown status', 'invalid');
      set.statusId = to.id;
      set.completedAt = to.type === 'completed' ? new Date() : null;
      await log(tx, cur.id, actor, { kind: 'status', from: statusById.get(cur.statusId)?.name ?? null, to: to.name });
      // Wyjście z Need Info zamyka pytanie.
      if (!isNeedInfo(to) && (cur.infoFromId || cur.infoQuestion)) {
        set.infoFromId = null;
        set.infoQuestion = '';
        set.infoById = null;
        set.infoPrevStatusId = null;
      }
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== cur.assigneeId) {
      if (patch.assigneeId != null) await checkMember(tx, p, patch.assigneeId);
      set.assigneeId = patch.assigneeId;
      await log(tx, cur.id, actor, { kind: 'assignee', from: await userName(cur.assigneeId), to: await userName(patch.assigneeId) });
    }
    if (patch.priority !== undefined && patch.priority !== cur.priority) {
      if (patch.priority < 0 || patch.priority > 4) throw new RuleError('Priority must be 0-4', 'invalid');
      set.priority = patch.priority;
      await log(tx, cur.id, actor, { kind: 'priority', from: cur.priority, to: patch.priority });
    }
    if (patch.parentNumber !== undefined) {
      const parentId = await resolveParent(tx, p, patch.parentNumber, cur.id);
      if (parentId !== cur.parentId) {
        set.parentId = parentId;
        await log(tx, cur.id, actor, { kind: 'parent', to: patch.parentNumber });
      }
    }
    if (patch.sprintId !== undefined && patch.sprintId !== cur.sprintId) {
      set.sprintId = patch.sprintId;
      const name = patch.sprintId != null ? (await checkSprint(tx, p, patch.sprintId)).name : null;
      await log(tx, cur.id, actor, { kind: 'sprint', to: name });
    }
    if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;

    const asking = patch.infoQuestion !== undefined && !!patch.infoQuestion.trim();
    // "Answered": jawne wyczyszczenie pytania (infoFromId: null bez treści) bez zmiany statusu.
    if (patch.infoFromId === null && !asking && (cur.infoFromId || cur.infoQuestion)) {
      set.infoFromId = null;
      set.infoQuestion = '';
      set.infoById = null;
      set.infoPrevStatusId = null;
    }
    // Pytanie do osoby albo do każdego (infoFromId null/brak): pole na karcie plus komentarz w historii.
    if (asking) {
      if (patch.infoFromId) await checkMember(tx, p, patch.infoFromId);
      const who = patch.infoFromId ? await userName(patch.infoFromId) : 'anyone';
      if (!who) throw new RuleError('Unknown user', 'invalid');
      set.infoFromId = patch.infoFromId ?? null;
      set.infoById = actor?.id ?? null;
      // Status sprzed Need Info: po odpowiedzi zadanie do niego wróci.
      set.infoPrevStatusId = set.statusId !== undefined && set.statusId !== cur.statusId ? cur.statusId : (cur.infoPrevStatusId ?? null);
      set.infoQuestion = patch.infoQuestion!.trim();
      await log(tx, cur.id, actor, { kind: 'question', to: who, question: set.infoQuestion });
      const [q] = await tx.insert(comments).values({ issueId: cur.id, authorId: actor?.id ?? null, body: `**Question for ${who}:** ${set.infoQuestion}` }).returning();
      set.infoCommentId = q.id;
    }

    if (patch.labelIds !== undefined) {
      const curLabels = (await tx.select().from(issueLabels).where(eq(issueLabels.issueId, cur.id))).map((l) => l.labelId);
      const added = patch.labelIds.filter((l) => !curLabels.includes(l));
      const removed = curLabels.filter((l) => !patch.labelIds!.includes(l));
      if (added.length || removed.length) {
        await checkLabels(tx, p, added);
        await tx.delete(issueLabels).where(eq(issueLabels.issueId, cur.id));
        if (patch.labelIds.length) await tx.insert(issueLabels).values(patch.labelIds.map((labelId) => ({ issueId: cur.id, labelId })));
        const all = await tx.select().from(labels).where(eq(labels.projectId, p.id));
        const nm = (ids: number[]) => ids.map((id) => all.find((l) => l.id === id)?.name ?? '?');
        await log(tx, cur.id, actor, { kind: 'labels', added: nm(added), removed: nm(removed) });
      }
    }

    if (Object.keys(set).length) {
      set.updatedAt = new Date();
      await tx.update(issues).set(set).where(eq(issues.id, cur.id));
    }
    return { ...cur, ...set };
  });
  await publish({ type: 'issue', projectKey: p.key, number });
  return result;
}

export async function deleteIssue(p: Project, number: number) {
  const cur = await requireIssue(p, number);
  await db.transaction(async (tx) => {
    await tx.update(issues).set({ parentId: null }).where(eq(issues.parentId, cur.id));
    await tx.delete(issues).where(eq(issues.id, cur.id));
  });
  await publish({ type: 'issue', projectKey: p.key, number });
}

// Zlecenie znika (analiza zapisana, Cancel) albo wraca na początek (nowe): claim agenta przepada razem z nim.
const NO_CLAIM = { analysisClaimedAt: null, analysisClaimedBy: null, analysisClaimedDevice: null, analysisLocalUntil: null, analysisFailedAt: null, analysisError: '' };

export async function requestAnalysis(p: Project, actor: Actor, number: number, deep = false, local = false) {
  const cur = await requireIssue(p, number);
  await db.transaction(async (tx) => {
    await tx.update(issues).set({
      analysisRequestedAt: new Date(), analysisDeep: deep, updatedAt: new Date(), analysisRequestedBy: actor?.id ?? null,
      ...NO_CLAIM, analysisLocalUntil: local ? new Date(Date.now() + 60_000) : null,
    }).where(eq(issues.id, cur.id));
    await log(tx, cur.id, actor, deep ? { kind: 'analysis_requested', deep } : { kind: 'analysis_requested' });
  });
  await publish({ type: 'issue', projectKey: p.key, number });
}

/** Anulowanie zlecenia, które utknęło (agent nie ruszył albo padł): pasek wraca do przycisku Analyze. */
export async function cancelAnalysis(p: Project, number: number) {
  const cur = await requireIssue(p, number);
  await db.update(issues).set({ analysisRequestedAt: null, ...NO_CLAIM }).where(eq(issues.id, cur.id));
  await publish({ type: 'issue', projectKey: p.key, number });
}

/** Analiza od agenta w sekcjach. Wybory z poprzedniej analizy zostają przy tych samych pytaniach. */
export async function setAnalysis(p: Project, actor: Actor, number: number, input: AnalysisInput) {
  const cur = await requireIssue(p, number);
  const data = fromInput(input, parseData(cur.analysisData));
  // Typ z analizy jako etykieta (Bug / Feature / Investigate), tworzona, gdy projekt jej nie ma.
  // Etykieta poprzedniego typu ustępuje nowej; pozostałych etykiet analiza nie rusza.
  const typeLabel = async (name: string) => {
    const [l] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, p.id), dsql`lower(${labels.name}) = lower(${name})`));
    return l?.id ?? (await saveLabel(p, { name, color: TYPE_LABEL_COLORS[name] })).id;
  };
  const want = await typeLabel(TYPE_LABEL_NAMES[data.type]);
  const others = await Promise.all(Object.values(TYPE_LABEL_NAMES).filter((n) => n !== TYPE_LABEL_NAMES[data.type]).map(async (n) => {
    const [l] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, p.id), dsql`lower(${labels.name}) = lower(${n})`));
    return l?.id;
  }));
  const [{ ids }] = await db.select({ ids: dsql<number[]>`coalesce(array_agg(${issueLabels.labelId}), '{}')` }).from(issueLabels).where(eq(issueLabels.issueId, cur.id));
  const labelIds = [...new Set([...ids.filter((id) => !others.includes(id)), want])];
  const changed = labelIds.length !== ids.length || labelIds.some((id) => !ids.includes(id));
  await updateIssue(p, actor, number, { analysis: render(data), analysisData: data, ...(changed ? { labelIds } : {}) });
  return data;
}

/**
 * Wybór człowieka w decyzji z analizy: numer opcji albo własna odpowiedź ("Inne"); oba puste
 * cofają wybór. Markdown analizy odświeża się, więc Start work dostaje ustalenia.
 */
export async function chooseDecision(p: Project, actor: Actor, number: number, index: number, option: number | null, other: string) {
  const result = await db.transaction(async (tx) => {
    const cur = await requireIssue(p, number, tx);
    const data = parseData(cur.analysisData);
    const d = data?.decisions[index];
    if (!data || !d) throw new RuleError('Unknown decision', 'invalid');
    if (option != null && !d.options[option]) throw new RuleError('Unknown option', 'invalid');
    const clear = option == null && !other.trim();
    const decisions = data.decisions.map((x, i) => {
      if (i !== index) return x;
      const { choice: _old, ...rest } = x;
      return clear ? rest : { ...rest, choice: { option, other: option == null ? other.trim() : '', by: actor?.name ?? '?', at: new Date().toISOString() } };
    });
    const next: AnalysisData = { ...data, decisions };
    await tx.update(issues).set({ analysisData: next, analysis: render(next), updatedAt: new Date() }).where(eq(issues.id, cur.id));
    await log(tx, cur.id, actor, { kind: 'decision', question: d.question, answer: chosenText(next.decisions[index]) });
    return next;
  });
  await publish({ type: 'issue', projectKey: p.key, number });
  return result;
}

export type WorklogInput = { session: string; repo: string; files: string[]; commits: { sha: string; message: string }[]; prompts: string[] };

/**
 * Ślad pracy z sesji Claude Code (hooki). Jeden wpis na sesję: kolejne wysyłki scalają się
 * w ten sam wpis zamiast dokładać nowe, żeby aktywność zgłoszenia nie puchła.
 */
export async function upsertWorklog(p: Project, actor: Actor, number: number, w: WorklogInput) {
  const cur = await requireIssue(p, number);
  const [row] = await db.select().from(activity).where(and(
    eq(activity.issueId, cur.id), dsql`${activity.payload}->>'kind' = 'worklog'`, dsql`${activity.payload}->>'session' = ${w.session}`,
    // Wpis należy do autora: znajomość cudzego id sesji nie pozwala dopisać się do jego śladu.
    actor ? eq(activity.actorId, actor.id) : isNull(activity.actorId),
  ));
  const prev = row?.payload.kind === 'worklog' ? row.payload : null;
  const commits = [...(prev?.commits ?? [])];
  for (const c of w.commits) if (!commits.some((x) => x.sha === c.sha)) commits.push(c);
  const payload: ActivityPayload = {
    kind: 'worklog', session: w.session, repo: w.repo || prev?.repo || '',
    files: [...new Set([...(prev?.files ?? []), ...w.files])].slice(0, 200),
    commits: commits.slice(-50),
    prompts: [...(prev?.prompts ?? []), ...w.prompts.filter((x) => !prev?.prompts.includes(x))].slice(-10),
    updatedAt: new Date().toISOString(),
  };
  if (row) await db.update(activity).set({ payload }).where(eq(activity.id, row.id));
  // Ślad pracy przysyła hook sesji Claude Code: znacznik AI, jak inne akcje agenta.
  else await db.insert(activity).values({ issueId: cur.id, actorId: actor?.id ?? null, viaAi: true, payload });
  await publish({ type: 'issue', projectKey: p.key, number });
}

export async function addComment(p: Project, actor: Actor, number: number, body: string) {
  if (!body.trim()) throw new RuleError('Comment cannot be empty', 'invalid');
  const cur = await requireIssue(p, number);
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.insert(comments).values({ issueId: cur.id, authorId: actor?.id ?? null, body }).returning();
    await tx.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, cur.id));
    // Odpowiedź na otwarte pytanie: podpinamy komentarz pod pytanie (wątek) i zamykamy pytanie.
    if (await answerIfAsked(tx, actor, cur) && cur.infoCommentId) {
      await tx.update(comments).set({ replyToId: cur.infoCommentId }).where(eq(comments.id, r.id));
      r.replyToId = cur.infoCommentId;
    }
    return r;
  });
  if (actor) await markSeen(actor.id, cur.id);
  await publish({ type: 'issue', projectKey: p.key, number });
  return row;
}

/**
 * Komentarz osoby, której zadano pytanie (albo kogokolwiek poza pytającym przy "anyone"),
 * zamyka pytanie i przywraca status sprzed Need Info.
 */
async function answerIfAsked(tx: Tx, actor: Actor, cur: typeof issues.$inferSelect): Promise<boolean> {
  // Komentarz agenta przez MCP nie zamyka pytania do człowieka.
  if (!actor || actor.ai || !cur.infoQuestion) return false;
  const answers = cur.infoFromId ? cur.infoFromId === actor.id : cur.infoById !== actor.id;
  if (!answers) return false;
  const all = await tx.select().from(statuses).where(eq(statuses.projectId, cur.projectId));
  const now = all.find((x) => x.id === cur.statusId);
  const back = cur.infoPrevStatusId && now && isNeedInfo(now) ? all.find((x) => x.id === cur.infoPrevStatusId) : undefined;
  await tx.update(issues).set({
    infoFromId: null, infoQuestion: '', infoById: null, infoPrevStatusId: null, infoCommentId: null,
    ...(back ? { statusId: back.id, completedAt: null } : {}),
    updatedAt: new Date(),
  }).where(eq(issues.id, cur.id));
  await log(tx, cur.id, actor, { kind: 'answered', by: actor.name, backTo: back?.name ?? null });
  if (back) await log(tx, cur.id, actor, { kind: 'status', from: now!.name, to: back.name });
  return true;
}

export async function lastSeen(userId: number, issueId: number) {
  const [v] = await db.select().from(issueViews).where(and(eq(issueViews.userId, userId), eq(issueViews.issueId, issueId)));
  if (v) return v.seenAt;
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
  return u?.createdAt ?? null;
}

/** "Oznacz jako przeczytane" dla wielu zadań projektu naraz (po numerach; bez numerów: wszystkie). */
export async function markSeenMany(p: Project, userId: number, numbers?: number[]) {
  const rows = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.projectId, p.id), ...(numbers ? [inArray(issues.number, numbers.length ? numbers : [-1])] : [])));
  if (!rows.length) return 0;
  const now = new Date();
  await db.insert(issueViews).values(rows.map((r) => ({ userId, issueId: r.id, seenAt: now })))
    .onConflictDoUpdate({ target: [issueViews.userId, issueViews.issueId], set: { seenAt: now } });
  return rows.length;
}

/** Zapis "widziałem to zadanie", żeby komentarze sprzed tej chwili nie były nowe. */
export async function markSeen(userId: number, issueId: number) {
  await db.insert(issueViews).values({ userId, issueId, seenAt: new Date() })
    .onConflictDoUpdate({ target: [issueViews.userId, issueViews.issueId], set: { seenAt: new Date() } });
}

/** Komentarz z numerem zadania, tylko jeśli należy do projektu (id komentarzy są globalne). */
async function commentIn(p: Project, id: number) {
  const [c] = await db.select({ comment: comments, number: issues.number }).from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(and(eq(comments.id, id), eq(issues.projectId, p.id)));
  return c ?? null;
}

export async function updateComment(p: Project, actor: Actor, id: number, body: string) {
  const c = await commentIn(p, id);
  if (!c) throw new RuleError('Comment not found', 'not_found');
  if (actor && c.comment.authorId !== actor.id) throw new RuleError('You can only edit your own comments', 'forbidden');
  await db.update(comments).set({ body, updatedAt: new Date() }).where(eq(comments.id, id));
  await publish({ type: 'issue', projectKey: p.key, number: c.number });
}

export async function deleteComment(p: Project, actor: Actor, id: number) {
  const c = await commentIn(p, id);
  if (!c) return;
  if (actor && c.comment.authorId !== actor.id) throw new RuleError('You can only delete your own comments', 'forbidden');
  await db.delete(comments).where(eq(comments.id, id));
  await publish({ type: 'issue', projectKey: p.key, number: c.number });
}

/** Projekt, do którego należy komentarz (API sprawdza po nim członkostwo). */
export async function projectIdOfComment(id: number) {
  const [r] = await db.select({ projectId: issues.projectId }).from(comments).innerJoin(issues, eq(issues.id, comments.issueId)).where(eq(comments.id, id));
  return r?.projectId ?? null;
}

// ---------- słowniki (admin projektu) ----------

export async function saveLabel(p: Project, input: { id?: number; name: string; color: string }) {
  const row = input.id
    ? (await db.update(labels).set({ name: input.name, color: input.color }).where(and(eq(labels.id, input.id), eq(labels.projectId, p.id))).returning())[0]
    : (await db.insert(labels).values({ projectId: p.id, name: input.name, color: input.color })
      .onConflictDoUpdate({ target: [labels.projectId, labels.name], set: { color: input.color } }).returning())[0];
  await publish({ type: 'meta', projectKey: p.key });
  return row;
}

export async function deleteLabel(p: Project, id: number) {
  await db.delete(labels).where(and(eq(labels.id, id), eq(labels.projectId, p.id)));
  await publish({ type: 'meta', projectKey: p.key });
}

export async function saveStatus(p: Project, input: { id: number; name?: string; color?: string; position?: number; hiddenOnBoard?: boolean; role?: 'need_info' | 'testing' | null }) {
  const { id, ...rest } = input;
  await db.update(statuses).set(rest).where(and(eq(statuses.id, id), eq(statuses.projectId, p.id)));
  await publish({ type: 'meta', projectKey: p.key });
}

/** Konta (allowlista logowania) są globalne; nowe konto od razu trafia do bieżącego projektu. */
export async function saveUser(p: Project | null, input: { id?: number; login: string; name?: string; isAdmin?: boolean; active?: boolean }) {
  if (input.id) {
    const { id, ...rest } = input;
    await db.update(users).set(rest).where(eq(users.id, id));
  } else {
    const [dup] = await db.select({ id: users.id }).from(users).where(dsql`lower(${users.login}) = lower(${input.login})`);
    if (dup) throw new RuleError(`${input.login} already has an account`, 'invalid');
    const [u] = await db.insert(users).values({ login: input.login, name: input.name || input.login, isAdmin: !!input.isAdmin }).returning();
    if (p) await db.insert(projectMembers).values({ projectId: p.id, userId: u.id, role: 'member' }).onConflictDoNothing();
  }
  await publish({ type: 'meta', projectKey: p?.key });
}
