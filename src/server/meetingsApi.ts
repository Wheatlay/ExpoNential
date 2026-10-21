import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import { requireUser } from './auth.ts';
import { ctx } from './api.ts';
import { canManage } from './projects.ts';
import * as mt from './meetings.ts';
import * as nt from './notify.ts';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const date = z.coerce.date();
const reminders = z.array(z.number().int()).max(4);

async function scope(req: FastifyRequest) {
  const { project, role } = await ctx(req);
  return { p: project, isAdmin: canManage(req.user!, role), actor: { id: req.user!.id, name: req.user!.name } };
}

export async function registerMeetings(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', requireUser);

    // ?since=ISO: widok miesiąca sięga dalej wstecz niż domyślne 14 dni (najwyżej rok).
    r.get<{ Querystring: { since?: string } }>('/api/meetings', async (req) => {
      const since = req.query.since ? new Date(req.query.since) : null;
      const valid = since && !Number.isNaN(since.getTime()) ? new Date(Math.max(since.getTime(), Date.now() - 366 * 864e5)) : undefined;
      return mt.listMeetings((await scope(req)).p, valid);
    });
    r.post('/api/meetings', async (req) => {
      const { p, actor } = await scope(req);
      const b = z.object({
        title: z.string().max(200), kind: z.enum(['poll', 'fixed']),
        slots: z.array(z.object({ startsAt: date, endsAt: date })).max(20).optional(),
        startsAt: date.optional(), endsAt: date.optional(),
        locationUrl: z.string().max(500).optional(), reminders: reminders.optional(),
      }).parse(req.body);
      return mt.createMeeting(p, actor, b, req.log);
    });
    r.patch<{ Params: { id: string } }>('/api/meetings/:id', async (req) => {
      const { p, actor, isAdmin } = await scope(req);
      const b = z.object({
        title: z.string().max(200).optional(), locationUrl: z.string().max(500).optional(), reminders: reminders.optional(),
        startsAt: date.optional(), endsAt: date.optional(),
      }).parse(req.body);
      await mt.updateMeeting(p, actor, isAdmin, Number(req.params.id), b);
      return { ok: true };
    });
    r.delete<{ Params: { id: string } }>('/api/meetings/:id', async (req) => {
      const { p, actor, isAdmin } = await scope(req);
      await mt.cancelMeeting(p, actor, isAdmin, Number(req.params.id));
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/meetings/:id/slots', async (req) => {
      const { p, actor } = await scope(req);
      const b = z.object({ startsAt: date, endsAt: date.optional(), reason: z.string().max(300).optional() }).parse(req.body);
      return mt.proposeSlot(p, actor, Number(req.params.id), b, req.log);
    });
    r.put<{ Params: { id: string } }>('/api/meeting-slots/:id/vote', async (req) => {
      const { p, actor } = await scope(req);
      const { vote } = z.object({ vote: z.enum(['yes', 'maybe', 'no']).nullable() }).parse(req.body);
      await mt.vote(p, actor, Number(req.params.id), vote);
      return { ok: true };
    });
    r.post<{ Params: { id: string } }>('/api/meetings/:id/pick', async (req) => {
      const { p, actor, isAdmin } = await scope(req);
      const { slotId } = z.object({ slotId: z.number().int() }).parse(req.body);
      await mt.pickSlot(p, actor, isAdmin, Number(req.params.id), slotId, req.log);
      return { ok: true };
    });

    // powiadomienia: ustawienia osoby, Web Push
    r.get('/api/notify-settings', async (req) => ({ ...(await nt.getNotifySettings(req.user!.id)), pushKey: nt.pushPublicKey() }));
    r.put('/api/notify-settings', async (req) => {
      const b = z.object({ inApp: z.boolean(), push: z.boolean(), discord: z.boolean(), notifyPromptShown: z.boolean() }).partial().parse(req.body);
      return nt.saveNotifySettings(req.user!.id, b);
    });
    r.post('/api/push/subscription', async (req) => {
      const b = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }).parse(req.body);
      await nt.savePushSubscription(req.user!.id, b);
      return { ok: true };
    });
    r.delete('/api/push/subscription', async (req) => {
      const { endpoint } = z.object({ endpoint: z.string() }).parse(req.body);
      await nt.deletePushSubscription(req.user!.id, endpoint);
      return { ok: true };
    });

    // link subskrypcji kalendarza (.ics): token zakładany przy pierwszym użyciu
    r.get('/api/calendar-link', async (req) => {
      const [u] = await db.select({ token: users.calendarToken }).from(users).where(eq(users.id, req.user!.id));
      let token = u?.token;
      if (!token) {
        token = randomBytes(24).toString('base64url');
        await db.update(users).set({ calendarToken: token }).where(eq(users.id, req.user!.id));
      }
      return { url: `${BASE_URL}/calendar/${token}.ics` };
    });
  });

  // Bez sesji: kalendarze (Google, Outlook) pobierają link same. Token jest sekretem.
  app.get<{ Params: { file: string } }>('/calendar/:file', async (req, reply) => {
    const m = /^([\w-]{20,})\.ics$/.exec(req.params.file);
    if (!m) return reply.code(404).send({ error: 'Not found' });
    const [u] = await db.select({ id: users.id, active: users.active }).from(users).where(eq(users.calendarToken, m[1]));
    if (!u?.active) return reply.code(404).send({ error: 'Not found' });
    return reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Cache-Control', 'no-cache').send(await mt.icsFor(u.id));
  });
}
