import { and, desc, eq, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../db/index.ts';
import { projectLog, users } from '../db/schema.ts';

type Exec = typeof db | Tx;

/** Dziennik projektu. Nigdy nie rzuca: błąd zapisu dziennika nie może zepsuć akcji, którą opisuje. */
export async function logProject(projectId: number, actorId: number | null, kind: string, opts: { targetUserId?: number | null; data?: Record<string, unknown>; exec?: Exec } = {}) {
  try {
    await (opts.exec ?? db).insert(projectLog).values({ projectId, actorId, kind, targetUserId: opts.targetUserId ?? null, data: opts.data ?? {} });
  } catch (e) {
    console.warn('project log write failed', kind, e instanceof Error ? e.message : e);
  }
}

// Pola, których wartości nie trafiają do dziennika: sekret (tylko czy ustawiony) albo długi tekst/obrazek (tylko "changed").
const SECRET_FIELDS = new Set(['discordWebhookUrl']);
const OPAQUE_FIELDS = new Set(['color', 'logoUrl', 'promptStart', 'promptAnalyze', 'promptClose', 'promptDeep']);

/** Zmienione pola ustawień projektu (tylko te, które naprawdę się zmieniły), bez wartości sekretów. */
export function diffSettings(before: Record<string, unknown>, after: Record<string, unknown>, patch: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) continue;
    const from = before[k] ?? null;
    const to = after[k] ?? null;
    if (from === to) continue;
    if (SECRET_FIELDS.has(k)) fields[k] = { set: !!to };
    else if (OPAQUE_FIELDS.has(k)) fields[k] = 'changed';
    else fields[k] = { from, to };
  }
  return fields;
}

const actor = alias(users, 'log_actor');
const target = alias(users, 'log_target');

export async function listProjectLog(projectId: number, limit = 200, before?: number) {
  const rows = await db.select({
    id: projectLog.id, kind: projectLog.kind, data: projectLog.data, createdAt: projectLog.createdAt,
    actorId: projectLog.actorId, actorName: actor.name, targetId: projectLog.targetUserId, targetName: target.name,
  })
    .from(projectLog).leftJoin(actor, eq(actor.id, projectLog.actorId)).leftJoin(target, eq(target.id, projectLog.targetUserId))
    .where(and(eq(projectLog.projectId, projectId), before ? lt(projectLog.id, before) : undefined))
    .orderBy(desc(projectLog.id)).limit(limit);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, data: r.data, createdAt: r.createdAt,
    actor: r.actorId ? { id: r.actorId, name: r.actorName ?? '' } : null,
    target: r.targetId ? { id: r.targetId, name: r.targetName ?? '' } : null,
  }));
}
