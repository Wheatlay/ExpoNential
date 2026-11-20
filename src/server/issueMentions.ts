import { and, eq, inArray, ne, or, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { comments, issues, statuses } from '../db/schema.ts';
import { findIssueRefs, issueRefPattern } from '../shared/issueRefs.ts';
import { projectsOf } from './projects.ts';
import { identifier } from './rules.ts';
import type { SessionUser } from './auth.ts';

/**
 * Wzmianki zamiast ręcznej relacji "Related": liczone na bieżąco z opisu i komentarzy, w obie strony
 * ("wspomina" i "wspomniane w"), tym samym wzorcem co pille w tekście. Tylko projekty, których członkiem
 * jest oglądający (inne zostają zwykłym tekstem, jak w pillach).
 */
export type MentionedIssue = { id: string; key: string; number: number; title: string; statusId: number; open: boolean };

const OPEN_TYPES = ['backlog', 'unstarted', 'started'];

export async function mentionsOf(user: Pick<SessionUser, 'id' | 'isAdmin'>, issue: { id: number; identifier: string; description: string }, issueComments: { body: string }[]) {
  const mine = (await projectsOf(user)).map((x) => x.project);
  const re = issueRefPattern(mine.map((p) => p.key));
  const keyOf = new Map(mine.map((p) => [p.id, p.key]));
  const idOf = new Map(mine.map((p) => [p.key, p.id]));
  const empty = { mentions: [] as MentionedIssue[], mentionedIn: [] as MentionedIssue[] };
  if (!re || !mine.length) return empty;

  // Wychodzące: odwołania w opisie i komentarzach tego zgłoszenia.
  const refs = findIssueRefs([issue.description, ...issueComments.map((c) => c.body)].join('\n\n'), re).filter((r) => r !== issue.identifier);
  const wanted = refs.map((r) => { const i = r.lastIndexOf('-'); return { projectId: idOf.get(r.slice(0, i))!, number: Number(r.slice(i + 1)) }; });

  // Przychodzące: wstępny filtr w SQL (klucz, opcjonalny myślnik/spacja, numer), potem ten sam parser co w UI.
  const [key, num] = [issue.identifier.slice(0, issue.identifier.lastIndexOf('-')), issue.identifier.slice(issue.identifier.lastIndexOf('-') + 1)];
  const pat = `${key}[- ]?${num}([^0-9]|$)`;
  const projectIds = mine.map((p) => p.id);
  const candidates = await db.selectDistinct({ id: issues.id, projectId: issues.projectId, number: issues.number, description: issues.description })
    .from(issues).leftJoin(comments, eq(comments.issueId, issues.id))
    .where(and(inArray(issues.projectId, projectIds), ne(issues.id, issue.id), or(dsql`${issues.description} ~* ${pat}`, dsql`${comments.body} ~* ${pat}`)));
  const incomingIds: number[] = [];
  for (const c of candidates) {
    const bodies = await db.select({ body: comments.body }).from(comments).where(eq(comments.issueId, c.id));
    if (findIssueRefs([c.description, ...bodies.map((b) => b.body)].join('\n\n'), re).includes(issue.identifier)) incomingIds.push(c.id);
  }

  const outgoingWhere = wanted.length ? or(...wanted.map((w) => and(eq(issues.projectId, w.projectId), eq(issues.number, w.number)))) : null;
  const where = [outgoingWhere, incomingIds.length ? inArray(issues.id, incomingIds) : null].filter((x) => x != null);
  if (!where.length) return empty;
  const rows = await db.select({ id: issues.id, projectId: issues.projectId, number: issues.number, title: issues.title, statusId: issues.statusId, type: statuses.type })
    .from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(or(...where));
  const toItem = (r: (typeof rows)[number]): MentionedIssue => {
    const k = keyOf.get(r.projectId)!;
    return { id: identifier(k, r.number), key: k, number: r.number, title: r.title, statusId: r.statusId, open: OPEN_TYPES.includes(r.type) };
  };
  const order = (id: string) => refs.indexOf(id);
  return {
    mentions: rows.map(toItem).filter((x) => refs.includes(x.id)).sort((a, b) => order(a.id) - order(b.id)),
    mentionedIn: rows.filter((r) => incomingIds.includes(r.id)).map(toItem).sort((a, b) => b.number - a.number),
  };
}
