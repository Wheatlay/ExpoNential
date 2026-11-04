import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, gt, isNull, sql as dsql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { apiTokens, oauthGrants, sessions, users } from '../db/schema.ts';
import { ensureSomeMembership } from './projects.ts';
import { consumeInvite, consumeReset, inviteInfo, resetInfo } from './invites.ts';
import { RuleError, isEmail } from './rules.ts';
import { oauthTokenInfo } from './oauth.ts';
import { createAttemptLimiter, dummyHash, hashPassword, loginLimiter, passwordProblem, verifyPassword } from './password.ts';

const SESSION_DAYS = 30;
const COOKIE = 'tracker_session';
const isProd = process.env.NODE_ENV === 'production';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
/** Loginy GitHub, które przy pierwszym logowaniu dostają konto admina (tylko gdy nie ustawiono ADMIN_GITHUB_IDS). Czytane przy użyciu. */
const adminLogins = () => csv(process.env.ADMIN_LOGINS);
/** Numeryczne ID kont GitHub, które przy pierwszym logowaniu dostają konto admina. Gdy ustawione, tylko ono decyduje. */
const adminGithubIds = () => csv(process.env.ADMIN_GITHUB_IDS).filter((s) => /^\d+$/.test(s)).map(Number);
const DAY = 864e5;
const TOKEN_TTL_DAYS = 180;
const TOKEN_SLIDE_DAYS = 90;
/** Drugi limiter logowania tylko na e-mail: IP w kluczu ip|e-mail da się rotować. */
const emailLimiter = createAttemptLimiter(20, 15 * 60_000);
/** E-maile Google, które przy pierwszym logowaniu dostają konto admina (czytane przy użyciu, nie przy imporcie modułu). */
const adminEmails = () => (process.env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const tmpCookie = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProd, maxAge: 600 };

export type SessionUser = { id: number; name: string; login: string; isAdmin: boolean };

declare module 'fastify' {
  interface FastifyRequest { user: SessionUser | null; authVia: 'session' | 'token' | null; /** Token Bearer należy do agenta (grant exponential-agent albo klucz trk_ z agentId). */ tokenAgent: boolean }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

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

type TokenAuth = { user: SessionUser; agent: boolean };

async function tokenAuth(header: string | undefined): Promise<TokenAuth | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return null;
  if (m[1].startsWith('exa_')) return oauthTokenInfo(m[1]);
  const [row] = await db.select({
    id: users.id, name: users.name, login: users.login, isAdmin: users.isAdmin, tokenId: apiTokens.id, agentId: apiTokens.agentId, expiresAt: apiTokens.expiresAt,
  }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, sha256(m[1])), eq(users.active, true)));
  if (!row) return null;
  const now = Date.now();
  if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
  // Klucz sprzed terminów ważności (expiresAt null) dostaje go przy pierwszym użyciu; potem przesuwamy, gdy zostało mniej niż 90 dni
  // (po przesunięciu zostaje 180, więc najwyżej raz na 90 dni).
  const slide = !row.expiresAt || row.expiresAt.getTime() - now < TOKEN_SLIDE_DAYS * DAY;
  await db.update(apiTokens).set({ lastUsedAt: new Date(now), ...(slide ? { expiresAt: new Date(now + TOKEN_TTL_DAYS * DAY) } : {}) }).where(eq(apiTokens.id, row.tokenId));
  const { tokenId: _, agentId, expiresAt: __, ...user } = row;
  return { user, agent: agentId != null };
}

export async function userFromToken(header: string | undefined): Promise<SessionUser | null> {
  return (await tokenAuth(header))?.user ?? null;
}

/** Klucz trk_ ważny 180 dni (przesuwany przy użyciu). agentId: komputer, dla którego agent wystawił klucz (mcp-key). */
export async function createApiToken(userId: number, name: string, agentId?: string | null) {
  const token = `trk_${randomBytes(24).toString('base64url')}`;
  await db.insert(apiTokens).values({ userId, name, tokenHash: sha256(token), agentId: agentId ?? null, expiresAt: new Date(Date.now() + TOKEN_TTL_DAYS * DAY) });
  return token;
}

/**
 * Token Bearer (trk_ i exa_) działa tylko dla klientów AI i agenta: /mcp, część /oauth/* (bez stron zgody authorize i device),
 * trasy wołane przez agenta (agent/src) i hook worklog (exponential-agent hook). Reszta (m.in. /api/tokens, /api/connections) wymaga ciasteczka sesji.
 */
const ANY_METHOD = /^(GET|POST|DELETE|PUT|PATCH|HEAD|OPTIONS)$/;
const TOKEN_ROUTES: Array<[RegExp, RegExp]> = [
  [ANY_METHOD, /^\/mcp(\/|$)/],
  [ANY_METHOD, /^\/\.well-known(\/|$)/],
  [ANY_METHOD, /^\/oauth\/(token|revoke|register|device_authorization)$/],
  [/^GET$/, /^\/api\/(me|projects)$/],
  [/^GET$/, /^\/api\/issues\/[^/]+$/], // hook worklog czyta zgłoszenie
  [/^GET$/, /^\/api\/issues\/[^/]+\/prompt\/[^/]+$/],
  [/^(POST|DELETE)$/, /^\/api\/issues\/[^/]+\/analyze\/claim$/],
  [/^POST$/, /^\/api\/issues\/[^/]+\/worklog$/],
  [/^GET$/, /^\/api\/agent\/work$/],
  [/^POST$/, /^\/api\/agent\/runs$/],
  [/^POST$/, /^\/api\/agent\/consent-pending$/],
  [/^GET$/, /^\/api\/agent\/open-requests$/],
  [/^POST$/, /^\/api\/agent\/mcp-key$/], // klucz MCP dla instalatora agenta (pairing.ts sprawdza klienta grantu)
  [/^POST$/, /^\/api\/agent\/start-jobs\/[^/]+\/claim$/],
  [/^(DELETE|PATCH)$/, /^\/api\/agents\/[^/]+$/], // PATCH: tylko teamMode (api.ts)
];
/** Trasy z listy wyżej, które token może wołać tylko jako agent (grant exponential-agent albo klucz trk_ z agentId). */
const AGENT_ONLY: Array<[RegExp, RegExp]> = [
  [/^GET$/, /^\/api\/agent\/work$/],
  [/^POST$/, /^\/api\/agent\/runs$/],
  [/^POST$/, /^\/api\/agent\/consent-pending$/],
  [/^GET$/, /^\/api\/agent\/open-requests$/],
  [/^(POST|DELETE)$/, /^\/api\/issues\/[^/]+\/analyze\/claim$/],
  [/^POST$/, /^\/api\/agent\/start-jobs\/[^/]+\/claim$/],
  [/^(DELETE|PATCH)$/, /^\/api\/agents\/[^/]+$/],
];
const matches = (list: Array<[RegExp, RegExp]>, method: string, url: string) => {
  const path = url.split('?')[0];
  return list.some(([m, p]) => m.test(method) && p.test(path));
};
export const tokenAllowed = (method: string, url: string) => matches(TOKEN_ROUTES, method, url);
export const agentOnlyRoute = (method: string, url: string) => matches(AGENT_ONLY, method, url);

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
  app.decorateRequest('authVia', null);
  app.decorateRequest('tokenAgent', false);
  app.addHook('onRequest', async (req, reply) => {
    const fromSession = await userFromSession(req.cookies[COOKIE], reply);
    const viaToken = fromSession ? null : await tokenAuth(req.headers.authorization);
    req.user = fromSession ?? viaToken?.user ?? null;
    req.authVia = req.user ? (fromSession ? 'session' : 'token') : null;
    req.tokenAgent = !!viaToken?.agent;
    if (req.authVia === 'token' && !tokenAllowed(req.method, req.url)) {
      return reply.code(403).send({ error: 'This token can only be used by AI clients and the agent' });
    }
    if (req.authVia === 'token' && !req.tokenAgent && agentOnlyRoute(req.method, req.url)) {
      return reply.code(403).send({ error: 'Only the Exponential agent can use this' });
    }
    // Powrót do /oauth/authorize albo /oauth/device po logowaniu (dowolną metodą): logowanie kończy się wejściem na "/".
    const ret = req.cookies.oauth_return;
    if (ret && req.user && req.method === 'GET' && req.url.split('?')[0] === '/') {
      reply.clearCookie('oauth_return', { path: '/' });
      if (/^\/oauth\/(authorize|device)(\?|$)/.test(ret)) return reply.redirect(ret);
    }
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
    })).json()) as { id: number; login: string; name: string | null; avatar_url: string; email: string | null; created_at?: string };

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
    const emailKey = `email|${email}`;
    if (loginLimiter.blocked(key) || emailLimiter.blocked(emailKey)) return reply.code(429).send({ error: 'Too many failed attempts, try again in 15 minutes', code: 'rate' });
    const id = await loginWithPassword(email, body.password) ?? await claimPreAddedAccount(email, body.password);
    if (!id) {
      loginLimiter.fail(key);
      emailLimiter.fail(emailKey);
      return reply.code(401).send({ error: 'Wrong e-mail or password' });
    }
    loginLimiter.reset(key);
    await createSession(reply, id);
    return { ok: true };
  });

  // Krok 1 logowania: czy ten e-mail ustawia hasło (konto dodane ręcznie, nigdy niezalogowane).
  // Każdy inny przypadek (konto z hasłem, z Google, brak konta) daje to samo: nie zdradza, czy konto istnieje.
  app.post('/auth/password/check', async (req) => {
    const { email } = z.object({ email: z.string().min(1).max(320) }).parse(req.body);
    return { setPassword: await isPreAddedAccount(email.trim().toLowerCase()) };
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

  /** Bez nagłówka X-Requested-With: exponential to formularz z cudzej strony (CSRF), nie aplikacja. */
  const csrfHeader = (req: FastifyRequest) => req.headers['x-requested-with'] === 'exponential';

  app.post('/auth/logout', async (req, reply) => {
    if (!csrfHeader(req)) return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    const raw = req.cookies[COOKIE];
    if (raw) await db.delete(sessions).where(eq(sessions.id, sha256(raw)));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Wylogowanie ze wszystkich urządzeń: sesje, grants OAuth (też agenta) i klucze trk_ konta.
  app.post('/auth/logout-all', async (req, reply) => {
    if (!csrfHeader(req)) return reply.code(403).send({ error: 'Missing X-Requested-With header' });
    if (req.authVia !== 'session' || !req.user) return reply.code(401).send({ error: 'Not signed in' });
    const userId = req.user.id;
    await db.transaction(async (tx) => {
      await revokeAllCredentials(tx, userId);
      await tx.delete(sessions).where(eq(sessions.userId, userId));
    });
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  // Logowanie bez GitHuba tylko lokalnie i tylko po jawnym włączeniu.
  if (!isProd && process.env.DEV_LOGIN === '1') {
    app.get<{ Querystring: { login?: string } }>('/auth/dev', async (req, reply) => {
      // Bez ?login=: pierwszy aktywny admin z bazy (lokalnie to zwykle właściciel), inaczej pierwsza aktywna osoba, a w pustej bazie "dev".
      const [first] = req.query.login ? [] : await db.select({ login: users.login }).from(users).where(eq(users.active, true)).orderBy(desc(users.isAdmin), users.id).limit(1);
      const login = req.query.login || first?.login || 'dev';
      const [u] = await db.select().from(users).where(dsql`lower(${users.login}) = lower(${login})`);
      const id = u?.id ?? (await db.insert(users).values({ login, name: login, isAdmin: true }).returning())[0].id;
      await ensureSomeMembership(id);
      await createSession(reply, id);
      return reply.redirect('/');
    });
  }
}

/** Unieważnia grants OAuth (też agenta) i kasuje klucze trk_ konta. Sesji nie rusza. */
async function revokeAllCredentials(tx: Pick<typeof db, 'update' | 'delete'>, userId: number) {
  await tx.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)));
  await tx.delete(apiTokens).where(eq(apiTokens.userId, userId));
}

/**
 * Kto dostaje admina przy tworzeniu konta: gdy ustawiono ADMIN_GITHUB_IDS, tylko te numeryczne ID. Inaczej ADMIN_LOGINS,
 * ale nie, jeśli konto o tym loginie już istnieje z innym githubId (ktoś zmienił nazwę, a jego starym loginem zalogował się obcy).
 */
async function adminCandidate(gh: { id: number; login: string }) {
  if ((process.env.ADMIN_GITHUB_IDS ?? '').trim()) return adminGithubIds().includes(gh.id);
  if (!adminLogins().includes(gh.login.toLowerCase())) return false;
  const [other] = await db.select({ id: users.id }).from(users)
    .where(and(dsql`lower(${users.login}) = lower(${gh.login})`, dsql`${users.githubId} is not null`, dsql`${users.githubId} <> ${gh.id}`));
  return !other;
}

/**
 * Allowlista: wchodzi tylko ktoś, czyje konto GitHub (id) już jest w tabeli users, kto przejmuje wiersz dodany przez admina
 * albo z importu (bez githubId), jest adminem z ADMIN_GITHUB_IDS / ADMIN_LOGINS albo ma ważne zaproszenie. Zwraca id albo null.
 * Wiersz bez githubId przejmuje po loginie tylko konto GitHub założone przed tym wierszem (created_at z API GitHuba; bez niego
 * wystarcza zgodność loginu i leci ostrzeżenie). E-mail z GitHuba nigdy nie łączy kont.
 */
export async function upsertGithubUser(gh: { id: number; login: string; name: string | null; avatar_url: string; email: string | null; created_at?: string }, opts: { invite?: string } = {}) {
  const [byGithub] = await db.select().from(users).where(eq(users.githubId, gh.id));
  const [byLogin] = byGithub ? [byGithub] : await db.select().from(users).where(and(dsql`lower(${users.login}) = lower(${gh.login})`, isNull(users.githubId)));
  const existing = byGithub ?? byLogin;
  if (existing) {
    if (!existing.active) return null;
    if (!byGithub) {
      const created = gh.created_at ? new Date(gh.created_at) : null;
      if (created && !Number.isNaN(created.getTime())) {
        if (created.getTime() >= existing.createdAt.getTime()) return null; // konto GitHub młodsze od wiersza: nie przejmuje cudzego loginu
      } else {
        console.warn(`GitHub login ${gh.login} claimed a pre-added account by login only (GitHub did not give created_at)`);
      }
    }
    await db.update(users).set({ githubId: gh.id, login: gh.login, providerAvatarUrl: gh.avatar_url, ...(existing.avatarCustom ? {} : { avatarUrl: gh.avatar_url }) }).where(eq(users.id, existing.id));
    return existing.id;
  }
  if (!(await adminCandidate(gh))) {
    // Nowe konto tylko z ważnym zaproszeniem (członkostwo dodaje consumeInvite).
    if (!opts.invite || !(await inviteInfo(opts.invite))) return null;
    const [row] = await db.insert(users).values({ githubId: gh.id, login: gh.login, name: gh.name || gh.login, avatarUrl: gh.avatar_url, providerAvatarUrl: gh.avatar_url }).returning();
    return row.id;
  }
  const [row] = await db.insert(users).values({
    githubId: gh.id, login: gh.login, name: gh.name || gh.login, email: gh.email, avatarUrl: gh.avatar_url, providerAvatarUrl: gh.avatar_url, isAdmin: true,
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
    await db.update(users).set({ googleId: profile.sub, providerAvatarUrl: profile.picture ?? existing.providerAvatarUrl, ...(existing.avatarCustom ? {} : { avatarUrl: existing.avatarUrl ?? profile.picture ?? null }) }).where(eq(users.id, existing.id));
    return existing.id;
  }
  const admin = adminEmails().includes(email.toLowerCase());
  if (!admin && !(opts.invite && (await inviteInfo(opts.invite)))) return null;
  const [row] = await db.insert(users).values({
    googleId: profile.sub, login: email, name: profile.name || email, email, avatarUrl: profile.picture ?? null, providerAvatarUrl: profile.picture ?? null, isAdmin: admin,
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

/**
 * Pierwsze logowanie na konto dodane ręcznie w Accounts (e-mail, bez hasła, nigdy niezalogowane):
 * wpisane hasło staje się hasłem konta. Decyzja właściciela repo (04.11.2026): wygoda ponad to,
 * że aplikacja nie sprawdza skrzynki (kto pierwszy wpisze e-mail, ustawia hasło).
 * Za słabe hasło: błąd z regułą, żeby osoba wiedziała, czemu nie weszła.
 */
async function preAddedAccount(email: string) {
  const [u] = await db.select().from(users).where(dsql`lower(${users.email}) = lower(${email})`);
  return u && u.active && !u.passwordHash && !u.githubId && !u.googleId ? u : null;
}
export const isPreAddedAccount = async (email: string) => !!(await preAddedAccount(email));

export async function claimPreAddedAccount(email: string, password: string) {
  const u = await preAddedAccount(email);
  if (!u) return null;
  const problem = passwordProblem(password);
  if (problem) throw new RuleError(problem, 'invalid');
  const passwordHash = await hashPassword(password);
  const [row] = await db.update(users).set({ passwordHash })
    .where(and(eq(users.id, u.id), isNull(users.passwordHash), isNull(users.githubId), isNull(users.googleId))).returning({ id: users.id });
  return row?.id ?? null;
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

/** Reset hasła z linku: zużycie linku, nowy hash, kasowanie sesji, odwołanie grantów OAuth i kluczy trk_ konta w jednej transakcji. Zwraca id konta. */
export async function resetPassword(token: string, passwordHash: string) {
  return db.transaction(async (tx) => {
    const userId = (await resetInfo(token, tx)) && (await consumeReset(token, tx));
    if (!userId) throw new RuleError('This link is no longer valid', 'not_found');
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await revokeAllCredentials(tx, userId);
    return userId;
  });
}
