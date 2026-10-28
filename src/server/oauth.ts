/**
 * OAuth 2.1 dla klientów MCP (Claude Code, Codex, Cursor, VS Code): rejestracja publicznych klientów (RFC 7591),
 * kod + PKCE S256, odświeżanie z rotacją, device flow (RFC 8628). Tokeny `exa_` / `exr_`, w bazie tylko sha256.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { oauthClients, oauthCodes, oauthDeviceCodes, oauthGrants, users } from '../db/schema.ts';
import { requireUser, sha256, type SessionUser } from './auth.ts';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const isProd = process.env.NODE_ENV === 'production';
const tmpCookie = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: isProd, maxAge: 600 };
const ACCESS_MS = 3600e3;
const REFRESH_MS = 90 * 864e5;
const CODE_MS = 600e3;
const DEVICE_MS = 900e3;
const DEVICE_INTERVAL_MS = 5000;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // bez samogłosek i podobnych znaków
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
/** Własne schematy znanych klientów MCP. Inne (ms-msdt:, search-ms:...) potrafią uruchomić programy w systemie. */
const APP_SCHEMES = ['cursor:', 'vscode:', 'vscode-insiders:', 'claude:'];

type Body = Record<string, string | undefined>;
const bodyOf = (req: FastifyRequest): Body => {
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'string')) as Body;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** https, loopback po http (dowolny port) albo schemat znanej aplikacji (cursor://, vscode://...). */
function validRedirect(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || raw.length > 500) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.includes(u.hostname);
  return APP_SCHEMES.includes(u.protocol);
}

/** Dokąd wróci zgoda, tak jak zobaczy to człowiek: "this computer" dla loopback, inaczej host albo schemat. */
function returnsTo(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' && LOOPBACK.includes(u.hostname)) return 'an app on this computer';
    return u.protocol === 'https:' ? u.host : u.protocol.replace(':', '') + ' app';
  } catch { return raw; }
}

/** Nazwę podaje sam klient przy rejestracji, więc ekran zgody mówi wprost, skąd wróci i od kiedy klient istnieje. */
const clientFacts = (name: string, createdAt: Date, redirect?: string) =>
  `<p class="note">The name “${esc(name)}” is given by the app itself and is not verified.${redirect ? ` Access goes to <b>${esc(returnsTo(redirect))}</b>.` : ''} App registered ${createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.</p>`;

/** Zgodność redirect_uri: dokładna, a dla loopback pomijamy port (RFC 8252). */
function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try { g = new URL(given); } catch { return false; }
  if (g.protocol !== 'http:' || !LOOPBACK.includes(g.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
    } catch { return false; }
  });
}

function pkceOk(verifier: string, challenge: string) {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier) && createHash('sha256').update(verifier).digest('base64url') === challenge;
}

async function issueGrant(clientId: string, userId: number, scope: string) {
  const access = `exa_${randomBytes(32).toString('base64url')}`;
  const refresh = `exr_${randomBytes(32).toString('base64url')}`;
  await db.insert(oauthGrants).values({
    clientId, userId, accessHash: sha256(access), refreshHash: sha256(refresh),
    accessExpiresAt: new Date(Date.now() + ACCESS_MS), refreshExpiresAt: new Date(Date.now() + REFRESH_MS),
  });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh, scope };
}

/** Użytkownik z tokenu dostępu `exa_`: grant nieodwołany i niewygasły, konto aktywne. lastUsedAt najwyżej raz na minutę. */
export async function userFromOAuthToken(token: string): Promise<SessionUser | null> {
  const [row] = await db.select({
    id: users.id, name: users.name, login: users.login, isAdmin: users.isAdmin, grantId: oauthGrants.id, lastUsedAt: oauthGrants.lastUsedAt,
  }).from(oauthGrants).innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(eq(oauthGrants.accessHash, sha256(token)), isNull(oauthGrants.revokedAt), gt(oauthGrants.accessExpiresAt, new Date()), eq(users.active, true)));
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60e3) {
    await db.update(oauthGrants).set({ lastUsedAt: new Date() }).where(eq(oauthGrants.id, row.grantId));
  }
  const { grantId: _, lastUsedAt: __, ...user } = row;
  return user;
}

/** Pierwsze wywołanie /mcp tokenem OAuth zapisuje firstMcpAt (kropka "połączono" w kreatorze). */
export async function markMcpUse(req: FastifyRequest) {
  const m = /^Bearer\s+(exa_\S+)$/i.exec(req.headers.authorization ?? '');
  if (!m) return;
  await db.update(oauthGrants).set({ firstMcpAt: new Date() }).where(and(eq(oauthGrants.accessHash, sha256(m[1])), isNull(oauthGrants.firstMcpAt)));
}

const oerr = (reply: FastifyReply, error: string, description?: string, code = 400) =>
  reply.code(code).header('Cache-Control', 'no-store').send({ error, ...(description ? { error_description: description } : {}) });

const PAGE_CSS = `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f5f4;color:#1c1917;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 32px);box-sizing:border-box}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:#57534e}p.note{font-size:13px;padding:10px 12px;border-radius:8px;background:#fef3c7;color:#78350f}.row{display:flex;gap:8px}
button{flex:1;font:inherit;padding:9px 14px;border-radius:8px;border:1px solid #d6d3d1;background:#fff;color:#1c1917;cursor:pointer}
button.p{background:#1c1917;color:#fff;border-color:#1c1917}input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:9px 12px;border:1px solid #d6d3d1;border-radius:8px;margin-bottom:12px;letter-spacing:2px;text-transform:uppercase}
@media(prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}.card{background:#292524;border-color:#44403c}p{color:#a8a29e}button{background:#292524;border-color:#57534e;color:#f5f5f4}button.p{background:#f5f5f4;color:#1c1917;border-color:#f5f5f4}input[type=text]{background:#1c1917;border-color:#57534e;color:#f5f5f4}}`;

function page(reply: FastifyReply, title: string, body: string, status = 200) {
  return reply.code(status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store')
    .header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "frame-ancestors 'none'")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><div class="card">${body}</div></body></html>`);
}
const errorPage = (reply: FastifyReply, msg: string) => page(reply, 'Exponential', `<h1>Cannot continue</h1><p>${esc(msg)}</p>`, 400);

/** Niezalogowany: zapamiętujemy adres na 10 minut i wysyłamy na logowanie; auth.ts po wejściu na "/" odsyła z powrotem. */
function toLogin(req: FastifyRequest, reply: FastifyReply) {
  reply.setCookie('oauth_return', req.url, tmpCookie);
  return reply.redirect('/login');
}

const newCsrf = (reply: FastifyReply) => {
  const t = randomBytes(16).toString('hex');
  reply.setCookie('oauth_csrf', t, tmpCookie);
  return t;
};

function hidden(fields: Record<string, string>) {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

function backTo(redirectUri: string, params: Record<string, string | undefined>) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

const normCode = (s: string) => {
  const c = s.toUpperCase().replace(/[^A-Z]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
};

export async function registerOAuth(app: FastifyInstance) {
  await app.register(async (o) => {
    o.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    const resource = async () => ({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL] });
    o.get('/.well-known/oauth-protected-resource', resource);
    o.get('/.well-known/oauth-protected-resource/mcp', resource);
    o.get('/.well-known/oauth-authorization-server', async () => ({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      device_authorization_endpoint: `${BASE_URL}/oauth/device_authorization`,
      revocation_endpoint: `${BASE_URL}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    }));

    // Rejestracja klienta (RFC 7591), tylko publiczni.
    o.post('/oauth/register', async (req, reply) => {
      const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { client_name?: unknown; redirect_uris?: unknown };
      const uris = b.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && validRedirect(u))) {
        return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https, loopback http or an app scheme' });
      }
      const name = (typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim() : 'MCP client').slice(0, 100);
      const id = randomBytes(18).toString('base64url');
      await db.insert(oauthClients).values({ id, name, redirectUris: uris as string[] });
      return reply.code(201).send({
        client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'], response_types: ['code'],
      });
    });

    const clientById = async (id: string | undefined) => {
      if (!id || id.length > 100) return null;
      const [c] = await db.select().from(oauthClients).where(eq(oauthClients.id, id));
      return c ?? null;
    };

    o.get('/oauth/authorize', async (req, reply) => {
      const q = req.query as Body;
      const client = await clientById(q.client_id);
      if (!client || !q.redirect_uri || !redirectMatches(client.redirectUris, q.redirect_uri)) return errorPage(reply, 'Unknown client or redirect address.');
      // Błędne żądanie kończy się stroną błędu, nie przekierowaniem: inaczej każdy zarejestrowany klient robi z nas otwarte przekierowanie.
      if (q.response_type !== 'code') return errorPage(reply, 'This app sent an unsupported request (response_type).');
      if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? '')) return errorPage(reply, 'This app sent an invalid request (PKCE).');
      if (!req.user) return toLogin(req, reply);
      reply.clearCookie('oauth_return', { path: '/' });
      const csrf = newCsrf(reply);
      return page(reply, 'Authorize', `<h1>${esc(client.name)} wants access to Exponential</h1>
<p>It will act as <b>${esc(req.user.name)}</b> and can read and change issues you can access.</p>
${clientFacts(client.name, client.createdAt, q.redirect_uri)}
<form method="post" action="/oauth/authorize">${hidden({ csrf, client_id: client.id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge!, state: q.state ?? '', scope: (q.scope ?? '').slice(0, 200) })}
<div class="row"><button name="decision" value="deny">Deny</button><button class="p" name="decision" value="allow">Allow</button></div></form>`);
    });

    o.post('/oauth/authorize', async (req, reply) => {
      const b = bodyOf(req);
      const client = await clientById(b.client_id);
      if (!client || !b.redirect_uri || !redirectMatches(client.redirectUris, b.redirect_uri)) return errorPage(reply, 'Unknown client or redirect address.');
      if (!req.user) return errorPage(reply, 'You are not signed in.');
      if (!b.csrf || b.csrf !== req.cookies.oauth_csrf) return errorPage(reply, 'This page expired. Start again from your tool.');
      reply.clearCookie('oauth_csrf', { path: '/' });
      const state = b.state || undefined;
      if (b.decision !== 'allow') return reply.redirect(backTo(b.redirect_uri, { error: 'access_denied', state }));
      if (!/^[A-Za-z0-9_-]{43}$/.test(b.code_challenge ?? '')) return errorPage(reply, 'Invalid request.');
      const code = randomBytes(32).toString('base64url');
      await db.insert(oauthCodes).values({
        codeHash: sha256(code), clientId: client.id, userId: req.user.id, redirectUri: b.redirect_uri,
        codeChallenge: b.code_challenge!, scope: (b.scope ?? '').slice(0, 200), expiresAt: new Date(Date.now() + CODE_MS),
      });
      return reply.redirect(backTo(b.redirect_uri, { code, state }));
    });

    o.post('/oauth/token', async (req, reply) => {
      const b = bodyOf(req);
      const client = await clientById(b.client_id);
      if (!client) return oerr(reply, 'invalid_client', undefined, 401);
      const now = new Date();

      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier) return oerr(reply, 'invalid_request');
        // Jednorazowy: kod zużywamy atomowo, zanim cokolwiek sprawdzimy.
        const [c] = await db.update(oauthCodes).set({ usedAt: now })
          .where(and(eq(oauthCodes.codeHash, sha256(b.code)), isNull(oauthCodes.usedAt))).returning();
        if (!c || c.clientId !== client.id || c.expiresAt < now || c.redirectUri !== b.redirect_uri || !pkceOk(b.code_verifier, c.codeChallenge)) {
          return oerr(reply, 'invalid_grant');
        }
        return reply.header('Cache-Control', 'no-store').send(await issueGrant(client.id, c.userId, c.scope));
      }

      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token) return oerr(reply, 'invalid_request');
        const [g] = await db.update(oauthGrants).set({ revokedAt: now })
          .where(and(eq(oauthGrants.refreshHash, sha256(b.refresh_token)), eq(oauthGrants.clientId, client.id), isNull(oauthGrants.revokedAt), gt(oauthGrants.refreshExpiresAt, now))).returning();
        if (!g) return oerr(reply, 'invalid_grant');
        const [u] = await db.select({ active: users.active }).from(users).where(eq(users.id, g.userId));
        if (!u?.active) return oerr(reply, 'invalid_grant');
        return reply.header('Cache-Control', 'no-store').send(await issueGrant(client.id, g.userId, ''));
      }

      if (b.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (!b.device_code) return oerr(reply, 'invalid_request');
        const hash = sha256(b.device_code);
        const [d] = await db.select().from(oauthDeviceCodes).where(and(eq(oauthDeviceCodes.deviceHash, hash), eq(oauthDeviceCodes.clientId, client.id)));
        if (!d) return oerr(reply, 'access_denied'); // odrzucone na stronie urządzenia (wiersz skasowany)
        if (d.expiresAt < now) {
          await db.delete(oauthDeviceCodes).where(eq(oauthDeviceCodes.deviceHash, hash));
          return oerr(reply, 'expired_token');
        }
        if (!d.approvedAt || !d.userId) {
          const tooFast = d.lastPollAt && now.getTime() - d.lastPollAt.getTime() < DEVICE_INTERVAL_MS;
          await db.update(oauthDeviceCodes).set({ lastPollAt: now }).where(eq(oauthDeviceCodes.deviceHash, hash));
          return oerr(reply, tooFast ? 'slow_down' : 'authorization_pending');
        }
        const [taken] = await db.delete(oauthDeviceCodes).where(eq(oauthDeviceCodes.deviceHash, hash)).returning();
        if (!taken) return oerr(reply, 'invalid_grant');
        return reply.header('Cache-Control', 'no-store').send(await issueGrant(client.id, d.userId, ''));
      }

      return oerr(reply, 'unsupported_grant_type');
    });

    o.post('/oauth/device_authorization', async (req, reply) => {
      const b = bodyOf(req);
      const client = await clientById(b.client_id);
      if (!client) return oerr(reply, 'invalid_client', undefined, 401);
      const device = randomBytes(32).toString('base64url');
      let userCode = '';
      for (let i = 0; i < 5; i++) {
        const bytes = randomBytes(8);
        const raw = Array.from(bytes, (x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join('');
        userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
        try {
          await db.insert(oauthDeviceCodes).values({ deviceHash: sha256(device), userCode, clientId: client.id, expiresAt: new Date(Date.now() + DEVICE_MS) });
          break;
        } catch (e) {
          if ((e as { code?: string })?.code !== '23505' || i === 4) throw e; // kolizja kodu: losujemy ponownie
        }
      }
      return reply.header('Cache-Control', 'no-store').send({
        device_code: device, user_code: userCode, verification_uri: `${BASE_URL}/oauth/device`,
        verification_uri_complete: `${BASE_URL}/oauth/device?code=${userCode}`, expires_in: DEVICE_MS / 1000, interval: DEVICE_INTERVAL_MS / 1000,
      });
    });

    o.get('/oauth/device', async (req, reply) => {
      if (!req.user) return toLogin(req, reply);
      reply.clearCookie('oauth_return', { path: '/' });
      const q = req.query as Body;
      // Kod liczy się tylko przepisany ręcznie (typed=1 z formularza). Link z gotowym ?code= wysłany przez kogoś obcego
      // nie może prowadzić prosto do "Allow": człowiek musi przepisać kod, który widzi we własnym narzędziu.
      const code = q.code && q.typed === '1' ? normCode(q.code.slice(0, 20)) : '';
      const entry = (note = '') => page(reply, 'Connect a device', `<h1>Connect a device</h1><p>${note || 'Type the code shown in your own tool. If someone sent you a link or a code, do not continue.'}</p>
<form method="get" action="/oauth/device"><input type="hidden" name="typed" value="1"><input type="text" name="code" value="" placeholder="ABCD-EFGH" autocomplete="off" autofocus><div class="row"><button class="p">Continue</button></div></form>`);
      if (!code) return entry();
      const [d] = await db.select({ clientName: oauthClients.name, clientAt: oauthClients.createdAt, approvedAt: oauthDeviceCodes.approvedAt })
        .from(oauthDeviceCodes).innerJoin(oauthClients, eq(oauthClients.id, oauthDeviceCodes.clientId))
        .where(and(eq(oauthDeviceCodes.userCode, code), gt(oauthDeviceCodes.expiresAt, new Date())));
      if (!d || d.approvedAt) return entry('This code is not valid or has expired. Check it and try again.');
      const csrf = newCsrf(reply);
      return page(reply, 'Connect a device', `<h1>${esc(d.clientName)} wants access to Exponential</h1>
<p>It will act as <b>${esc(req.user.name)}</b>. Only continue if you started this on your own device.</p>
${clientFacts(d.clientName, d.clientAt)}
<form method="post" action="/oauth/device">${hidden({ csrf, code })}
<div class="row"><button name="decision" value="deny">Deny</button><button class="p" name="decision" value="allow">Allow</button></div></form>`);
    });

    o.post('/oauth/device', async (req, reply) => {
      const b = bodyOf(req);
      if (!req.user) return errorPage(reply, 'You are not signed in.');
      if (!b.csrf || b.csrf !== req.cookies.oauth_csrf) return errorPage(reply, 'This page expired. Start again from your tool.');
      reply.clearCookie('oauth_csrf', { path: '/' });
      const code = normCode((b.code ?? '').slice(0, 20));
      const live = and(eq(oauthDeviceCodes.userCode, code), isNull(oauthDeviceCodes.approvedAt), gt(oauthDeviceCodes.expiresAt, new Date()));
      if (b.decision === 'allow') {
        const [d] = await db.update(oauthDeviceCodes).set({ userId: req.user.id, approvedAt: new Date() }).where(live).returning();
        if (!d) return errorPage(reply, 'This code is not valid or has expired.');
        return page(reply, 'Connected', '<h1>Connected</h1><p>You can close this tab and go back to your tool.</p>');
      }
      await db.delete(oauthDeviceCodes).where(live);
      return page(reply, 'Denied', '<h1>Access denied</h1><p>Nothing was connected.</p>');
    });

    // Odwołanie (RFC 7009): zawsze 200, niezależnie od tego, czy token istniał.
    o.post('/oauth/revoke', async (req, reply) => {
      const token = bodyOf(req).token;
      if (token) {
        const h = sha256(token);
        await db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(isNull(oauthGrants.revokedAt), or(eq(oauthGrants.accessHash, h), eq(oauthGrants.refreshHash, h))));
      }
      return reply.send({});
    });

    // Połączenia zalogowanego użytkownika (Ustawienia).
    o.get('/api/connections', { preHandler: requireUser }, async (req) =>
      (await db.select({
        id: oauthGrants.id, client: oauthClients.name, createdAt: oauthGrants.createdAt, lastUsedAt: oauthGrants.lastUsedAt, firstMcpAt: oauthGrants.firstMcpAt,
      }).from(oauthGrants).innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
        .where(and(eq(oauthGrants.userId, req.user!.id), isNull(oauthGrants.revokedAt), gt(oauthGrants.refreshExpiresAt, new Date())))
        .orderBy(desc(oauthGrants.createdAt))));

    o.delete<{ Params: { id: string } }>('/api/connections/:id', { preHandler: requireUser }, async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return reply.code(404).send({ error: 'Not found' });
      const res = await db.update(oauthGrants).set({ revokedAt: new Date() })
        .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, req.user!.id), isNull(oauthGrants.revokedAt))).returning({ id: oauthGrants.id });
      if (!res.length) return reply.code(404).send({ error: 'Not found' });
      return { ok: true };
    });
  });

  // Sprzątanie wygasłych kodów raz na godzinę (nieużyte kody i device flow nie zalegają).
  const sweep = setInterval(() => void Promise.all([
    db.delete(oauthCodes).where(lt(oauthCodes.expiresAt, new Date())),
    db.delete(oauthDeviceCodes).where(lt(oauthDeviceCodes.expiresAt, new Date())),
  ]).catch((e) => app.log.error(e)), 3600e3);
  app.addHook('onClose', async () => clearInterval(sweep));
}
