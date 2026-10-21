import { and, eq, inArray, or, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { activity, issueRelations, issues, statuses } from '../db/schema.ts';
import { RuleError, identifier } from './rules.ts';
import { publish, requireIssue, type Actor, type Project } from './service.ts';

/** Z perspektywy jednego zadania: na co czeka, co blokuje, z czym jest powiązane. */
export type RelationKind = 'waits_on' | 'blocks' | 'related';
const OPEN_TYPES = ['backlog', 'unstarted', 'started'];

/** Zapis zawsze w kierunku "from blokuje to"; "A czeka na B" to blocks(B → A). */
function toStored(kind: RelationKind, selfId: number, otherId: number) {
  if (kind === 'waits_on') return { kind: 'blocks' as const, fromIssueId: otherId, toIssueId: selfId };
  if (kind === 'blocks') return { kind: 'blocks' as const, fromIssueId: selfId, toIssueId: otherId };
  const [a, b] = selfId < otherId ? [selfId, otherId] : [otherId, selfId];
  return { kind: 'related' as const, fromIssueId: a, toIssueId: b };
}

const opposite: Record<RelationKind, RelationKind> = { waits_on: 'blocks', blocks: 'waits_on', related: 'related' };

export async function addRelation(p: Project, actor: Actor, number: number, kind: RelationKind, otherNumber: number) {
  if (number === otherNumber) throw new RuleError('An issue cannot be related to itself', 'invalid');
  const [self, other] = await Promise.all([requireIssue(p, number), requireIssue(p, otherNumber)]);
  const stored = toStored(kind, self.id, other.id);
  if (stored.kind === 'blocks') {
    // Pętla blokad (też pośrednia): z "to" da się już dojść po blokadach do "from".
    const loop = await db.execute(dsql`with recursive r(id) as (select ${stored.toIssueId}::int union select ir.to_issue_id from issue_relations ir join r on ir.from_issue_id = r.id where ir.kind = 'blocks') select 1 from r where id = ${stored.fromIssueId} limit 1`);
    if ((loop as unknown as unknown[]).length) throw new RuleError(`${identifier(p.key, otherNumber)} already ${kind === 'waits_on' ? 'waits on' : 'blocks'} ${identifier(p.key, number)} (would create a blocking loop)`, 'invalid');
  }
  const inserted = await db.insert(issueRelations).values(stored).onConflictDoNothing().returning();
  if (inserted.length) {
    await db.insert(activity).values([
      { issueId: self.id, actorId: actor?.id ?? null, viaAi: !!actor?.ai, payload: { kind: 'relation', action: 'added', relation: kind, other: otherNumber } },
      { issueId: other.id, actorId: actor?.id ?? null, viaAi: !!actor?.ai, payload: { kind: 'relation', action: 'added', relation: opposite[kind], other: number } },
    ]);
  }
  await publish({ type: 'issue', projectKey: p.key, number });
  await publish({ type: 'issue', projectKey: p.key, number: otherNumber });
}

export async function removeRelation(p: Project, actor: Actor, number: number, kind: RelationKind, otherNumber: number) {
  const [self, other] = await Promise.all([requireIssue(p, number), requireIssue(p, otherNumber)]);
  const stored = toStored(kind, self.id, other.id);
  const removed = await db.delete(issueRelations).where(and(
    eq(issueRelations.kind, stored.kind), eq(issueRelations.fromIssueId, stored.fromIssueId), eq(issueRelations.toIssueId, stored.toIssueId))).returning();
  if (removed.length) {
    await db.insert(activity).values([
      { issueId: self.id, actorId: actor?.id ?? null, viaAi: !!actor?.ai, payload: { kind: 'relation', action: 'removed', relation: kind, other: otherNumber } },
      { issueId: other.id, actorId: actor?.id ?? null, viaAi: !!actor?.ai, payload: { kind: 'relation', action: 'removed', relation: opposite[kind], other: number } },
    ]);
  }
  await publish({ type: 'issue', projectKey: p.key, number });
  await publish({ type: 'issue', projectKey: p.key, number: otherNumber });
}

export type RelatedIssue = { number: number; title: string; statusId: number; open: boolean };

export async function relationsOf(issueId: number) {
  const rows = await db.select().from(issueRelations)
    .where(or(eq(issueRelations.fromIssueId, issueId), eq(issueRelations.toIssueId, issueId)));
  const otherIds = [...new Set(rows.map((r) => (r.fromIssueId === issueId ? r.toIssueId : r.fromIssueId)))];
  const others = otherIds.length
    ? await db.select({ id: issues.id, number: issues.number, title: issues.title, statusId: issues.statusId, type: statuses.type })
      .from(issues).innerJoin(statuses, eq(statuses.id, issues.statusId)).where(inArray(issues.id, otherIds))
    : [];
  const byId = new Map(others.map((o) => [o.id, { number: o.number, title: o.title, statusId: o.statusId, open: OPEN_TYPES.includes(o.type) }]));
  const out = { waitingOn: [] as RelatedIssue[], blocking: [] as RelatedIssue[], related: [] as RelatedIssue[] };
  for (const r of rows) {
    if (r.kind === 'blocks' && r.toIssueId === issueId) out.waitingOn.push(byId.get(r.fromIssueId)!);
    else if (r.kind === 'blocks') out.blocking.push(byId.get(r.toIssueId)!);
    else out.related.push(byId.get(r.fromIssueId === issueId ? r.toIssueId : r.fromIssueId)!);
  }
  return out;
}

