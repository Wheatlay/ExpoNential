import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { apiTokens, sessions, users } from '../db/schema.ts';
import { ensureSomeMembership } from './projects.ts';

const SESSION_DAYS = 30;
const COOKIE = 'tracker_session';
const isProd = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
/** Loginy GitHub, które przy pierwszym logowaniu dostają konto admina (np. "Wheatlay"). */
const ADMIN_LOGINS = (process.env.ADMIN_LOGINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export type SessionUser = { id: number; name: string; login: string; isAdmin: boolean };

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(reply: FastifyReply, userId: number) {
  const id = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({ id: sha256(id), userId, expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5) });
  reply.setCookie(COOKIE, id, cookieOpts);
}

const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProd, maxAge: SESSION_DAYS * 86400 };

/**
 * Sesja przesuwna: każda wizyta przedłuża ją do pełnych 30 dni (najwyżej raz na dobę,
 * żeby nie pisać do bazy przy każdym żądaniu). Wylogowuje dopiero miesiąc bez używania.
 */
async function userFromSession(raw: string | undefined, reply: FastifyReply): Promise<SessionUser | null> {
  if (!raw) return null;
  const [row] = await db.select({ id: users.id, name: users.name, login: users.login, isAdmin: users.isAdmin, expiresAt: sessions.expiresAt })
    .from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(raw)), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
  if (!row) return null;
  const { expiresAt, ...user } = row;
  if (expiresAt.getTime() - Date.now() < (SESSION_DAYS - 1) * 864e5) {
    await db.update(sessions).set({ expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5) }).where(eq(sessions.id, sha256(raw)));
    reply.setCookie(COOKIE, raw, cookieOpts);
  }
  return user;
}

export async function userFromToken(header: string | undefined): Promise<SessionUser | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  const [row] = await db.select({ id: users.id, name: users.name, login: users.login, isAdmin: users.isAdmin, tokenId: apiTokens.id })
    .from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(m[1])), eq(users.active, true)));
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.tokenId));
  const { tokenId: _, ...user } = row;
  return user;
}

export async function createApiToken(userId: number, name: string) {
  const token = `trk_${randomBytes(24).toString('base64url')}`;
  await db.insert(apiTokens).values({ userId, name, tokenHash: sha256(token) });
  return token;
}

export function requireUser(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user) return void reply.code(401).send({ error: 'Not signed in' });
  done();
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  if (!req.user?.isAdmin) return void reply.code(403).send({ error: 'Admin only' });
  done();
}

export async function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req, reply) => {
    req.user = (await userFromSession(req.cookies[COOKIE], reply)) ?? (await userFromToken(req.headers.authorization));
  });

  app.get('/auth/login', async (_req, reply) => {
    const state = randomBytes(16).toString('hex');
    reply.setCookie('oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 600 });
    const q = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID ?? '',
      redirect_uri: `${BASE_URL}/auth/callback`,
      scope: 'read:user user:email',
      state,
    });
    return reply.redirect(`https://github.com/login/oauth/authorize?${q}`);
  });

  app.get<{ Querystring: { code?: string; state?: string } }>('/auth/callback', async (req, reply) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.cookies.oauth_state) return reply.redirect('/login?error=state');
    reply.clearCookie('oauth_state', { path: '/' });

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code }),
    });
    const { access_token } = (await tokenRes.json()) as { access_token?: string };
    if (!access_token) return reply.redirect('/login?error=github');
    const gh = (await (await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'tracker' },
    })).json()) as { id: number; login: string; name: string | null; avatar_url: string; email: string | null };

    const userId = await upsertGithubUser(gh);
    if (!userId) return reply.redirect('/login?error=not_allowed');
    await createSession(reply, userId);
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) await db.delete(sessions).where(eq(sessions.id, sha256(raw)));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Logowanie bez GitHuba tylko lokalnie i tylko po jawnym włączeniu.
  if (!isProd && process.env.DEV_LOGIN === '1') {
    app.get<{ Querystring: { login: string } }>('/auth/dev', async (req, reply) => {
      const [u] = await db.select().from(users).where(dsql`lower(${users.login}) = lower(${req.query.login})`);
      const id = u?.id ?? (await db.insert(users).values({ login: req.query.login, name: req.query.login, isAdmin: true }).returning())[0].id;
      await ensureSomeMembership(id);
      await createSession(reply, id);
      return reply.redirect('/');
    });
  }
}

/**
 * Allowlista: wchodzi tylko ktoś, kogo login jest już w tabeli users (dodany przez admina
 * albo z importu) albo jest w ADMIN_LOGINS. Zwraca id albo null.
 */
export async function upsertGithubUser(gh: { id: number; login: string; name: string | null; avatar_url: string; email: string | null }) {
  const [byGithub] = await db.select().from(users).where(eq(users.githubId, gh.id));
  const [byLogin] = byGithub ? [byGithub] : await db.select().from(users).where(and(dsql`lower(${users.login}) = lower(${gh.login})`, isNull(users.githubId)));
  const existing = byGithub ?? byLogin;
  if (existing) {
    if (!existing.active) return null;
    await db.update(users).set({ githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url }).where(eq(users.id, existing.id));
    return existing.id;
  }
  if (!ADMIN_LOGINS.includes(gh.login.toLowerCase())) return null;
  const [row] = await db.insert(users).values({
    githubId: gh.id, login: gh.login, name: gh.name || gh.login, email: gh.email, avatarUrl: gh.avatar_url, isAdmin: true,
  }).returning();
  await ensureSomeMembership(row.id);
  return row.id;
}
