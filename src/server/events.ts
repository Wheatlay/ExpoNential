import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { db, sql } from '../db/index.ts';
import { projectMembers, users } from '../db/schema.ts';
import { requireUser, type SessionUser } from './auth.ts';
import { publish } from './service.ts';
import { projectsOf } from './projects.ts';

/** Otwarty strumień z kluczami projektów, które dana osoba widzi: zdarzenia innych projektów do niej nie idą. */
type Client = { reply: FastifyReply; user: SessionUser; keys: Set<string> };
const clients = new Set<Client>();
/** Ile otwartych kart trackera ma każda osoba: > 0 znaczy online. */
const connections = new Map<number, number>();

export function onlineUserIds() {
  return [...connections].filter(([, n]) => n > 0).map(([id]) => id);
}

async function refreshKeys(c: Client) {
  c.keys = new Set((await projectsOf(c.user)).map((x) => x.project.key));
}

export async function registerEvents(app: FastifyInstance) {
  await sql.listen('tracker_events', async (payload) => {
    const e = JSON.parse(payload) as { type: string; projectKey?: string };
    // Zmiana członkostwa: najpierw odświeżamy, co kto widzi, potem rozdajemy zdarzenie.
    if (e.type === 'projects') await Promise.all([...clients].map(refreshKeys));
    for (const c of clients) if (!e.projectKey || c.keys.has(e.projectKey)) c.reply.raw.write(`data: ${payload}\n\n`);
  });

  // Proxy (Traefik w Coolify) zamyka bezczynne połączenia, więc co 25 s pusty komentarz.
  const ping = setInterval(() => { for (const c of clients) c.reply.raw.write(': ping\n\n'); }, 25_000);
  app.addHook('onClose', async () => clearInterval(ping));

  app.get('/api/events', { preHandler: requireUser }, (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');
    const client: Client = { reply, user: req.user!, keys: new Set() };
    clients.add(client);
    void refreshKeys(client).catch((e) => app.log.warn(e, 'event stream: project keys'));
    const userId = req.user!.id;
    const before = connections.get(userId) ?? 0;
    connections.set(userId, before + 1);
    if (before === 0) void publish({ type: 'online' });
    req.raw.on('close', () => {
      clients.delete(client);
      const left = (connections.get(userId) ?? 1) - 1;
      connections.set(userId, left);
      if (left === 0) {
        // Ostatnia karta zamknięta: zapamiętujemy, kiedy osoba była (żółta kropka "niedawno").
        void db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId)).then(() => publish({ type: 'online' }));
      }
    });
  });

  // Obecność tylko osób, z którymi dzielisz projekt (admin globalny widzi wszystkich).
  app.get('/api/online', { preHandler: requireUser }, async (req) => {
    const me = req.user!;
    const projectIds = (await projectsOf(me)).map((x) => x.project.id);
    const visible = me.isAdmin ? null : new Set([me.id, ...(projectIds.length
      ? (await db.selectDistinct({ id: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, projectIds))).map((x) => x.id)
      : [])]);
    const shown = (id: number) => !visible || visible.has(id);
    const seen = await db.select({ id: users.id, lastSeenAt: users.lastSeenAt }).from(users);
    return {
      online: onlineUserIds().filter(shown),
      lastSeen: Object.fromEntries(seen.filter((u) => u.lastSeenAt && shown(u.id)).map((u) => [u.id, u.lastSeenAt])),
    };
  });
}
