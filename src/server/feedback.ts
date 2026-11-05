import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { labels, projects, settings } from '../db/schema.ts';
import { requireUser } from './auth.ts';
import { RuleError } from './rules.ts';
import { TYPE_LABEL_COLORS, TYPE_LABEL_NAMES } from './analysis.ts';
import * as svc from './service.ts';

/**
 * "Report a bug or idea": zgłoszenie od dowolnej zalogowanej osoby trafia jako zadanie do projektu wskazanego
 * przez admina workspace (ustawienie `feedback_project_id` w tabeli settings). Zgłaszający nie musi być członkiem
 * tego projektu i nie dostaje z powrotem numeru ani linku.
 */

const SETTING = 'feedback_project_id';
const PER_HOUR = 10;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function getFeedbackProjectId() {
  const [row] = await db.select().from(settings).where(eq(settings.key, SETTING));
  return typeof row?.value === 'number' ? row.value : null;
}

export async function setFeedbackProjectId(id: number | null) {
  if (id !== null) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, id));
    if (!p) throw new RuleError('Project not found', 'not_found');
  }
  if (id === null) await db.delete(settings).where(eq(settings.key, SETTING));
  else await db.insert(settings).values({ key: SETTING, value: id }).onConflictDoUpdate({ target: settings.key, set: { value: id } });
}

/** Projekt zgłoszeń albo null (nieustawiony albo usunięty). */
async function feedbackProject() {
  const id = await getFeedbackProjectId();
  if (id === null) return null;
  const [p] = await db.select().from(projects).where(eq(projects.id, id));
  return p ?? null;
}

function appVersion() {
  try { return String((JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown'); } catch { return 'unknown'; }
}

// Ostatnie zgłoszenia osoby, w pamięci: po restarcie licznik się zeruje, to wystarcza na ochronę przed zalewem.
const sent = new Map<number, number[]>();
export function resetFeedbackLimit() { sent.clear(); }

export const feedbackSchema = z.object({
  kind: z.enum(['bug', 'idea']),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000),
  page: z.string().max(500),
  client: z.string().max(300),
});

export async function submitFeedback(user: { id: number; name: string }, input: z.infer<typeof feedbackSchema>) {
  if (process.env.DEMO_MODE === '1') throw new RuleError('Disabled in the demo', 'forbidden');
  const p = await feedbackProject();
  if (!p) throw new NotSetUp();
  const now = Date.now();
  const recent = (sent.get(user.id) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= PER_HOUR) throw new TooMany();
  sent.set(user.id, [...recent, now]);

  const name = TYPE_LABEL_NAMES[input.kind === 'bug' ? 'bug' : 'feature'];
  const [existing] = await db.select({ id: labels.id }).from(labels).where(and(eq(labels.projectId, p.id), dsql`lower(${labels.name}) = lower(${name})`));
  const labelId = existing?.id ?? (await svc.saveLabel(p, { name, color: TYPE_LABEL_COLORS[name] })).id;

  const text = input.description.trim();
  const tail = input.kind === 'bug' ? [`Page: ${input.page}`, `Browser: ${input.client}`, `App version: ${appVersion()}`].join('\n') : '';
  const description = [text, tail && '---', tail].filter(Boolean).join('\n\n');
  await svc.createIssue(p, { id: user.id, name: user.name }, { title: input.title, description, labelIds: [labelId] });
}

export class NotSetUp extends Error {}
export class TooMany extends Error {}

export async function registerFeedback(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // Każdy widzi tylko, czy zgłaszanie jest skonfigurowane; wybrany projekt tylko admin workspace.
    r.get('/api/feedback', async (req) => {
      const id = await getFeedbackProjectId();
      const ok = id !== null && !!(await feedbackProject());
      return { configured: ok, ...(req.user!.isAdmin ? { projectId: ok ? id : null } : {}) };
    });
    r.post('/api/feedback', async (req, reply) => {
      const b = feedbackSchema.parse(req.body);
      try {
        await submitFeedback(req.user!, b);
      } catch (e) {
        if (e instanceof NotSetUp) return reply.code(400).send({ error: 'Reporting is not set up', code: 'invalid' });
        if (e instanceof TooMany) return reply.code(429).send({ error: 'Too many reports, try again later', code: 'rate' });
        throw e;
      }
      return { ok: true };
    });
    r.put('/api/admin/feedback-project', async (req) => {
      if (!req.user!.isAdmin) throw new RuleError('Workspace admin only', 'forbidden');
      const { projectId } = z.object({ projectId: z.number().int().nullable() }).parse(req.body);
      await setFeedbackProjectId(projectId);
      return { ok: true };
    });
  });
}
