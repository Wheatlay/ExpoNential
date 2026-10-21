import { and, asc, eq, inArray, lte, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { issues, sprints, statuses } from '../db/schema.ts';
import { publish } from './service.ts';
import { RuleError } from './rules.ts';
import { zonedDate, zonedToUtc } from './tz.ts';
import { getProjectByKey, listAllProjects, updateProject, type Project } from './projects.ts';

const DAY = 24 * 60 * 60 * 1000;

/** Hak po każdym przebiegu ensureSprints (spotkania doczepiają tu automatyczne sprint review). */
const afterEnsure: ((p: Project) => Promise<void>)[] = [];
export function onSprintsEnsured(fn: (p: Project) => Promise<void>) {
  afterEnsure.push(fn);
}

export async function setSprintLength(p: Project, days: number) {
  await updateProject(p.id, { sprintLengthDays: days });
  await publish({ type: 'sprints', projectKey: p.key });
}

/** Wszystkie projekty: wołane przy starcie i co godzinę. */
export async function ensureSprints(now = new Date()) {
  for (const p of await listAllProjects()) await ensureProjectSprints(p, now);
}

/**
 * Pilnuje, żeby w projekcie zawsze był aktywny sprint i jeden zaplanowany po nim.
 * Sprint, któremu minął termin, przechodzi w "ended" i czeka na przegląd.
 */
export async function ensureProjectSprints(project: Project, now = new Date()) {
  const p = (await getProjectByKey(project.key)) ?? project; // świeża długość sprintu
  const len = p.sprintLengthDays;
  const inProject = eq(sprints.projectId, p.id);

  const changed = await db.transaction(async (tx) => {
    // Blokada per projekt: równoległe przebiegi nie dublują sprintów.
    await tx.execute(dsql`select pg_advisory_xact_lock(4243, ${p.id})`);
    let changed = false;

    const expired = await tx.select().from(sprints).where(and(inProject, inArray(sprints.status, ['active', 'planned']), lte(sprints.endsAt, now)));
    for (const s of expired) {
      await tx.update(sprints).set({ status: 'ended' }).where(eq(sprints.id, s.id));
      changed = true;
    }

    const all = await tx.select().from(sprints).where(inProject).orderBy(asc(sprints.startsAt));
    let active = all.find((s) => s.status === 'active');
    const planned = all.filter((s) => s.status === 'planned');

    if (!active) {
      const next = planned.find((s) => s.startsAt <= now && s.endsAt > now) ?? null;
      if (next) {
        await tx.update(sprints).set({ status: 'active' }).where(eq(sprints.id, next.id));
        active = { ...next, status: 'active' };
      } else {
        const last = all.at(-1);
        const start = last && last.endsAt > now ? last.endsAt : startOfDay(now);
        [active] = await tx.insert(sprints).values({
          projectId: p.id, name: `Sprint ${all.length + 1}`, startsAt: start, endsAt: new Date(start.getTime() + len * DAY), status: 'active',
        }).returning();
      }
      changed = true;
    }

    const fresh = await tx.select().from(sprints).where(inProject).orderBy(asc(sprints.startsAt));
    if (!fresh.some((s) => s.status === 'planned' && s.startsAt >= active!.startsAt)) {
      await tx.insert(sprints).values({
        projectId: p.id, name: `Sprint ${fresh.length + 1}`, startsAt: active.endsAt, endsAt: new Date(active.endsAt.getTime() + len * DAY), status: 'planned',
      });
      changed = true;
    }
    return changed;
  });
  for (const fn of afterEnsure) await fn(p);
  if (changed) await publish({ type: 'sprints', projectKey: p.key });
}

function startOfDay(d: Date) {
  return zonedToUtc(zonedDate(d), '00:00'); // początek dnia w strefie instancji
}

export async function listSprints(p: Project) {
  return db.select().from(sprints).where(eq(sprints.projectId, p.id)).orderBy(asc(sprints.startsAt));
}

async function requireSprint(p: Project, id: number) {
  const [s] = await db.select().from(sprints).where(and(eq(sprints.id, id), eq(sprints.projectId, p.id)));
  if (!s) throw new RuleError('Unknown sprint', 'not_found');
  return s;
}

/** Kolejny sprint po danym (planned albo active, najbliższy w czasie). */
async function nextSprintAfter(p: Project, id: number) {
  const all = await listSprints(p);
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) throw new RuleError('Unknown sprint', 'not_found');
  return all.slice(idx + 1).find((s) => s.status === 'planned' || s.status === 'active') ?? null;
}

/** Przerzuca nieukończone zadania sprintu do następnego. Bez numerów = wszystkie. */
export async function carryOver(p: Project, sprintId: number, numbers?: number[]) {
  const next = await nextSprintAfter(p, sprintId);
  if (!next) throw new RuleError('No next sprint to carry over to', 'invalid');
  const open = await db.select({ id: issues.id, number: issues.number }).from(issues)
    .innerJoin(statuses, eq(statuses.id, issues.statusId))
    .where(and(eq(issues.sprintId, sprintId), inArray(statuses.type, ['backlog', 'unstarted', 'started'])));
  const ids = open.filter((i) => !numbers || numbers.includes(i.number)).map((i) => i.id);
  if (ids.length) await db.update(issues).set({ sprintId: next.id, updatedAt: new Date() }).where(inArray(issues.id, ids));
  await publish({ type: 'sprints', projectKey: p.key });
  return { moved: ids.length, to: next.name };
}

export async function saveReviewNotes(p: Project, sprintId: number, notes: string) {
  await requireSprint(p, sprintId);
  await db.update(sprints).set({ reviewNotes: notes }).where(eq(sprints.id, sprintId));
  await publish({ type: 'sprints', projectKey: p.key });
}

export async function closeReview(p: Project, sprintId: number) {
  const s = await requireSprint(p, sprintId);
  if (s.status !== 'ended') throw new RuleError('Only an ended sprint can be closed after review', 'invalid');
  await db.update(sprints).set({ status: 'reviewed' }).where(eq(sprints.id, sprintId));
  await publish({ type: 'sprints', projectKey: p.key });
}

export async function updateSprint(p: Project, id: number, patch: { name?: string; endsAt?: Date }) {
  await requireSprint(p, id);
  await db.update(sprints).set(patch).where(eq(sprints.id, id));
  await publish({ type: 'sprints', projectKey: p.key });
}
