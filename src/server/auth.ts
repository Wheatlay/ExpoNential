import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { apiTokens, sessions, users } from '../db/schema.ts';
import { ensureSomeMembership } from './projects.ts';
import { consumeInvite, consumeReset, inviteInfo, resetInfo } from './invites.ts';
import { RuleError, isEmail } from './rules.ts';
import { dummyHash, hashPassword, loginLimiter, passwordProblem, verifyPassword } from './password.ts';

const SESSION_DAYS = 30;
const COOKIE = 'tracker_session';
const isProd = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
/** Loginy GitHub, które przy pierwszym logowaniu dostają konto admina (np. "Wheatlay"). */
const ADMIN_LOGINS = (process.env.ADMIN_LOGINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** E-maile Google, które przy pierwszym logowaniu dostają konto admina (czytane przy użyciu, nie przy imporcie modułu). */
const adminEmails = () => (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const tmpCookie = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProd, maxAge: 600 };

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

  /** Początek logowania przez dostawcę: state (+ zaproszenie z ?invite=) w ciasteczkach na 10 minut. */
  function beginOAuth(req: FastifyRequest, reply: FastifyReply) {
    const state = randomBytes(16).toString('hex');
    reply.setCookie('oauth_state', state, tmpCookie);
    const invite = (req.query as { invite?: string }).invite;
    if (invite && invite.length <= 200) reply.setCookie('invite', invite, tmpCookie);
    else reply.clearCookie('invite', { path: '/' });
    return state;
  }

  /** Koniec logowania: zaproszenie z ciasteczka (jeśli jest) zużywamy atomowo i wchodzimy do projektu. */
  async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: number) {
    const invite = req.cookies.invite;
    reply.clearCookie('invite', { path: '/' });
    if (invite) {
      const joined = await consumeInvite(invite, userId);
      if (!joined) return reply.redirect('/login?error=invite');
      await createSession(reply, userId);
      return reply.redirect(`/?project=${joined.projectKey}`);
    }
    await createSession(reply, userId);
    return reply.redirect('/');
  }

  app.get('/auth/login', async (req, reply) => {
    const state = beginOAuth(req, reply);
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

    const userId = await upsertGithubUser(gh, { invite: req.cookies.invite });
    if (!userId) return reply.redirect('/login?error=not_allowed');
    return finishLogin(req, reply, userId);
  });

  // Google (OIDC + PKCE S256). Trasy tylko, gdy ustawiono GOOGLE_CLIENT_ID.
  if (process.env.GOOGLE_CLIENT_ID) {
    app.get('/auth/google', async (req, reply) => {
      const state = beginOAuth(req, reply);
      const verifier = randomBytes(32).toString('base64url');
      reply.setCookie('oauth_pkce', verifier, tmpCookie);
      const q = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? '',
        redirect_uri: `${BASE_URL}/auth/google/callback`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
    });

    app.get<{ Querystring: { code?: string; state?: string } }>('/auth/google/callback', async (req, reply) => {
      const { code, state } = req.query;
      const verifier = req.cookies.oauth_pkce;
      reply.clearCookie('oauth_state', { path: '/' });
      reply.clearCookie('oauth_pkce', { path: '/' });
      if (!code || !state || state !== req.cookies.oauth_state || !verifier) return reply.redirect('/login?error=state');
      let profile: GoogleProfile;
      try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code, grant_type: 'authorization_code', client_id: process.env.GOOGLE_CLIENT_ID ?? '', client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
            redirect_uri: `${BASE_URL}/auth/google/callback`, code_verifier: verifier,
          }),
        });
        const { access_token } = (await tokenRes.json()) as { access_token?: string };
        if (!access_token) return reply.redirect('/login?error=google');
        const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
        if (!infoRes.ok) return reply.redirect('/login?error=google');
        profile = (await infoRes.json()) as GoogleProfile;
      } catch {
        return reply.redirect('/login?error=google');
      }
      const userId = await upsertGoogleUser(profile, { invite: req.cookies.invite });
      if (!userId) return reply.redirect('/login?error=not_allowed');
      return finishLogin(req, reply, userId);
    });
  }

  // E-mail + hasło. Zawsze ten sam błąd, niezależnie od przyczyny; limit nieudanych prób na (IP + e-mail).
  app.post('/auth/password', async (req, reply) => {
    const body = z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1000) }).parse(req.body);
    const email = body.email.trim().toLowerCase();
    const key = `${req.ip}|${email}`;
    if (loginLimiter.blocked(key)) return reply.code(429).send({ error: 'Too many failed attempts, try again in 15 minutes', code: 'rate' });
    const id = await loginWithPassword(email, body.password);
    if (!id) {
      loginLimiter.fail(key);
      return reply.code(401).send({ error: 'Wrong e-mail or password' });
    }
    loginLimiter.reset(key);
    await createSession(reply, id);
    return { ok: true };
  });

  // Rejestracja tylko z ważnym zaproszeniem: konto + zużycie zaproszenia w jednej transakcji.
  app.post<{ Params: { token: string } }>('/auth/invite/:token/register', async (req, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().max(320), password: z.string().max(1000) }).parse(req.body);
    if (!isEmail(body.email)) throw new RuleError('Enter a valid e-mail address', 'invalid');
    const problem = passwordProblem(body.password);
    if (problem) throw new RuleError(problem, 'invalid');
    const joined = await registerWithInvite(req.params.token, { name: body.name, email: body.email, passwordHash: await hashPassword(body.password) });
    await createSession(reply, joined.userId);
    return { projectKey: joined.projectKey };
  });

  // Reset hasła z linku admina: nowy hash, wszystkie sesje konta kasowane, nowa sesja.
  app.post<{ Params: { token: string } }>('/auth/reset/:token', async (req, reply) => {
    const { password } = z.object({ password: z.string().max(1000) }).parse(req.body);
    const problem = passwordProblem(password);
    if (problem) throw new RuleError(problem, 'invalid');
    const userId = await resetPassword(req.params.token, await hashPassword(password));
    await createSession(reply, userId);
    return { ok: true };
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
 * albo z importu), jest w ADMIN_LOGINS albo ma ważne zaproszenie. Zwraca id albo null.
 * E-mail z GitHuba nigdy nie łączy kont.
 */
export async function upsertGithubUser(gh: { id: number; login: string; name: string | null; avatar_url: string; email: string | null }, opts: { invite?: string } = {}) {
  const [byGithub] = await db.select().from(users).where(eq(users.githubId, gh.id));
  const [byLogin] = byGithub ? [byGithub] : await db.select().from(users).where(and(dsql`lower(${users.login}) = lower(${gh.login})`, isNull(users.githubId)));
  const existing = byGithub ?? byLogin;
  if (existing) {
    if (!existing.active) return null;
    await db.update(users).set({ githubId: gh.id, login: gh.login, avatarUrl: gh.avatar_url }).where(eq(users.id, existing.id));
    return existing.id;
  }
  if (!ADMIN_LOGINS.includes(gh.login.toLowerCase())) {
    // Nowe konto tylko z ważnym zaproszeniem (członkostwo dodaje consumeInvite).
    if (!opts.invite || !(await inviteInfo(opts.invite))) return null;
    const [row] = await db.insert(users).values({ githubId: gh.id, login: gh.login, name: gh.name || gh.login, avatarUrl: gh.avatar_url }).returning();
    return row.id;
  }
  const [row] = await db.insert(users).values({
    githubId: gh.id, login: gh.login, name: gh.name || gh.login, email: gh.email, avatarUrl: gh.avatar_url, isAdmin: true,
  }).returning();
  await ensureSomeMembership(row.id);
  return row.id;
}

export type GoogleProfile = { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string };

/**
 * Konto Google: po `sub`, potem po zweryfikowanym e-mailu (lower), jeśli konto nie ma jeszcze googleId (e-mail wpisał admin).
 * Nowe konto tylko dla ADMIN_EMAILS albo z ważnym zaproszeniem. Niezweryfikowany e-mail = odmowa. Zwraca id albo null.
 */
export async function upsertGoogleUser(profile: GoogleProfile, opts: { invite?: string } = {}) {
  if (!profile.sub || !profile.email || profile.email_verified !== true) return null;
  const email = profile.email.trim();
  const [bySub] = await db.select().from(users).where(eq(users.googleId, profile.sub));
  const [byEmail] = bySub ? [bySub] : await db.select().from(users).where(dsql`lower(${users.email}) = lower(${email})`);
  const existing = bySub ?? byEmail;
  if (existing) {
    if (!existing.active) return null;
    // Konto z tym e-mailem należy już do innego konta Google: nie przejmujemy go.
    if (existing.googleId && existing.googleId !== profile.sub) return null;
    await db.update(users).set({ googleId: profile.sub, avatarUrl: existing.avatarUrl ?? profile.picture ?? null }).where(eq(users.id, existing.id));
    return existing.id;
  }
  const admin = adminEmails().includes(email.toLowerCase());
  if (!admin && !(opts.invite && (await inviteInfo(opts.invite)))) return null;
  const [row] = await db.insert(users).values({
    googleId: profile.sub, login: email, name: profile.name || email, email, avatarUrl: profile.picture ?? null, isAdmin: admin,
  }).returning();
  if (admin) await ensureSomeMembership(row.id);
  return row.id;
}

/** Logowanie hasłem: id konta albo null (brak konta, brak hasła, złe hasło, konto nieaktywne: ta sama praca i ten sam wynik). */
export async function loginWithPassword(email: string, password: string) {
  const [u] = await db.select().from(users).where(dsql`lower(${users.email}) = lower(${email})`);
  const ok = await verifyPassword(password, u?.passwordHash ?? (await dummyHash()));
  return u && u.passwordHash && u.active && ok ? u.id : null;
}

const taken = () => new RuleError('This e-mail already has an account. Log in to accept the invite.', 'conflict');

/** Rejestracja z zaproszenia: konto i zużycie zaproszenia w jednej transakcji (błąd wycofuje oba). */
export async function registerWithInvite(token: string, input: { name: string; email: string; passwordHash: string }) {
  try {
    return await db.transaction(async (tx) => {
      if (!(await inviteInfo(token, tx))) throw new RuleError('This invite is no longer valid', 'not_found');
      const [dup] = await tx.select({ id: users.id }).from(users).where(dsql`lower(${users.email}) = lower(${input.email}) or lower(${users.login}) = lower(${input.email})`);
      if (dup) throw taken();
      const [row] = await tx.insert(users).values({ login: input.email, name: input.name, email: input.email, passwordHash: input.passwordHash }).returning();
      const joined = await consumeInvite(token, row.id, tx);
      if (!joined) throw new RuleError('This invite is no longer valid', 'not_found');
      return { userId: row.id, projectKey: joined.projectKey };
    });
  } catch (e) {
    // Wyścig na unikalnym e-mailu albo loginie: ten sam komunikat co zajęty e-mail.
    if ((e as { code?: string })?.code === '23505') throw taken();
    throw e;
  }
}

/** Reset hasła z linku: zużycie linku, nowy hash i kasowanie wszystkich sesji konta w jednej transakcji. Zwraca id konta. */
export async function resetPassword(token: string, passwordHash: string) {
  return db.transaction(async (tx) => {
    const userId = (await resetInfo(token, tx)) && (await consumeReset(token, tx));
    if (!userId) throw new RuleError('This link is no longer valid', 'not_found');
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return userId;
  });
}
