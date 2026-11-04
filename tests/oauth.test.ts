/**
 * OAuth 2.1 dla klientów MCP: rejestracja, kod + PKCE, odświeżanie, device flow, odwołanie, /mcp z tokenem exa_.
 * Osobna baza tracker_test_oauth, trasy przez Fastify.inject.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const ADMIN_URL = 'postgres://tracker:tracker@localhost:5434/tracker';
process.env.DATABASE_URL = 'postgres://tracker:tracker@localhost:5434/tracker_test_oauth';
process.env.BASE_URL = 'http://localhost:5173';

let dbmod: typeof import('../src/db/index.ts');
let schema: typeof import('../src/db/schema.ts');
let auth: typeof import('../src/server/auth.ts');
let app: import('fastify').FastifyInstance;
let sessionCookie: string;
let userId: number;
const { eq } = await import('drizzle-orm');

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const REDIRECT = 'http://127.0.0.1:8123/callback';

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { onnotice: () => {} });
  await admin.unsafe('drop database if exists tracker_test_oauth with (force)');
  await admin.unsafe('create database tracker_test_oauth');
  await admin.end();
  dbmod = await import('../src/db/index.ts');
  await dbmod.runMigrations();
  schema = await import('../src/db/schema.ts');
  auth = await import('../src/server/auth.ts');
  const [u] = await dbmod.db.insert(schema.users).values({ login: 'oa', name: 'OA User' }).returning();
  userId = u.id;
  const raw = randomBytes(16).toString('base64url');
  await dbmod.db.insert(schema.sessions).values({ id: auth.sha256(raw), userId, expiresAt: new Date(Date.now() + 864e5) });
  sessionCookie = `tracker_session=${raw}`;
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const { registerMcp } = await import('../src/server/mcp.ts');
  const { registerOAuth } = await import('../src/server/oauth.ts');
  app = Fastify();
  await app.register(cookie);
  await auth.registerAuth(app);
  await registerOAuth(app);
  await registerMcp(app);
});
afterAll(async () => { await app?.close(); await dbmod?.sql.end(); });

const register = async (redirect_uris: string[]) =>
  app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name: 'Test client', redirect_uris } });
const registerNamed = async (client_name: string) =>
  app.inject({ method: 'POST', url: '/oauth/register', payload: { client_name, redirect_uris: [REDIRECT] } });
const newClient = async () => (await register([REDIRECT])).json().client_id as string;

/** Pełne przejście przez stronę zgody: zwraca kod z przekierowania. */
async function authorize(clientId: string, challenge: string) {
  const q = form({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:9999/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'st1' });
  const page = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: { cookie: sessionCookie } });
  expect(page.statusCode).toBe(200);
  expect(page.body).toContain('Test client');
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const post = await app.inject({
    method: 'POST', url: '/oauth/authorize', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${csrf}` },
    payload: form({ csrf, client_id: clientId, redirect_uri: 'http://127.0.0.1:9999/callback', code_challenge: challenge, state: 'st1', scope: '', decision: 'allow' }),
  });
  expect(post.statusCode).toBe(302);
  const loc = new URL(post.headers.location as string);
  expect(loc.searchParams.get('state')).toBe('st1');
  return loc.searchParams.get('code')!;
}
const token = (o: Record<string, string>) => app.inject({ method: 'POST', url: '/oauth/token', headers: FORM, payload: form(o) });

describe('discovery and registration', () => {
  it('serves metadata', async () => {
    const r = (await app.inject({ url: '/.well-known/oauth-protected-resource' })).json();
    expect(r).toEqual({ resource: 'http://localhost:5173/mcp', authorization_servers: ['http://localhost:5173'] });
    const m = (await app.inject({ url: '/.well-known/oauth-authorization-server' })).json();
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.token_endpoint).toBe('http://localhost:5173/oauth/token');
  });
  it('rejects http non-loopback and dangerous schemes, accepts loopback, https and app schemes', async () => {
    expect((await register(['http://example.com/cb'])).statusCode).toBe(400);
    expect((await register(['javascript:alert(1)'])).statusCode).toBe(400);
    expect((await register(['ms-msdt:/id PCWDiagnostic'])).statusCode).toBe(400);
    expect((await register(['search-ms:query=x'])).statusCode).toBe(400);
    expect((await register([])).statusCode).toBe(400);
    expect((await register(['http://localhost:3000/cb', 'https://example.com/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'])).statusCode).toBe(201);
  });
});

describe('authorization code + PKCE', () => {
  it('redirects an anonymous user to login and remembers the return path', async () => {
    const cid = await newClient();
    const url = `/oauth/authorize?${form({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`;
    const r = await app.inject({ method: 'GET', url });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/login');
    expect(String(r.headers['set-cookie'])).toContain('oauth_return=');
    const back = await app.inject({ method: 'GET', url: '/', headers: { cookie: `${sessionCookie}; oauth_return=${encodeURIComponent(url)}` } });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(url);
  });
  it('refuses an unknown redirect_uri without redirecting', async () => {
    const cid = await newClient();
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize?${form({ response_type: 'code', client_id: cid, redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`, headers: { cookie: sessionCookie } });
    expect(r.statusCode).toBe(400);
  });
  it('is not an open redirect: a bad request shows an error page, even for a registered https redirect', async () => {
    const evil = (await register(['https://evil.example/cb'])).json().client_id as string;
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize?${form({ response_type: 'bad', client_id: evil, redirect_uri: 'https://evil.example/cb' })}` });
    expect(r.statusCode).toBe(400);
    expect(r.headers.location).toBeUndefined();
  });
  it('the consent page says the name is not verified and where access goes', async () => {
    const cid = await newClient();
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize?${form({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`, headers: { cookie: sessionCookie } });
    expect(r.body).toContain('is not verified');
    expect(r.body).toContain('Access goes to');
  });
  it('happy path, single use, wrong verifier', async () => {
    const cid = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(cid, challenge);
    const bad = await token({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: pkce().verifier });
    expect(bad.json().error).toBe('invalid_grant');
    // zły verifier zużył kod
    const ok0 = await token({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier });
    expect(ok0.statusCode).toBe(400);

    const code2 = await authorize(cid, challenge);
    const ok = await token({ grant_type: 'authorization_code', client_id: cid, code: code2, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier });
    expect(ok.statusCode).toBe(200);
    const t = ok.json();
    expect(t.access_token).toMatch(/^exa_/);
    expect(t.refresh_token).toMatch(/^exr_/);
    expect(t.token_type).toBe('Bearer');
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).toMatchObject({ id: userId });
    const again = await token({ grant_type: 'authorization_code', client_id: cid, code: code2, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier });
    expect(again.json().error).toBe('invalid_grant');
  });
  it('deny redirects with access_denied', async () => {
    const cid = await newClient();
    const csrf = 'abc';
    const r = await app.inject({
      method: 'POST', url: '/oauth/authorize', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${csrf}` },
      payload: form({ csrf, client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, state: 's', decision: 'deny' }),
    });
    expect(new URL(r.headers.location as string).searchParams.get('error')).toBe('access_denied');
  });
  it('rejects a POST without a matching CSRF token', async () => {
    const cid = await newClient();
    const r = await app.inject({
      method: 'POST', url: '/oauth/authorize', headers: { ...FORM, cookie: sessionCookie },
      payload: form({ csrf: 'x', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, decision: 'allow' }),
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('refresh, revoke and /mcp', () => {
  const grant = async () => {
    const cid = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(cid, challenge);
    const t = (await token({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier })).json();
    return { cid, t };
  };
  it('rotates the refresh token and rejects the old one', async () => {
    const { cid, t } = await grant();
    const r = await token({ grant_type: 'refresh_token', client_id: cid, refresh_token: t.refresh_token });
    expect(r.statusCode).toBe(200);
    const n = r.json();
    expect(n.access_token).not.toBe(t.access_token);
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).toBeNull();
    expect(await auth.userFromToken(`Bearer ${n.access_token}`)).not.toBeNull();
    expect((await token({ grant_type: 'refresh_token', client_id: cid, refresh_token: t.refresh_token })).json().error).toBe('invalid_grant');
  });
  it('a revoked grant no longer authenticates', async () => {
    const { t } = await grant();
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).not.toBeNull();
    await app.inject({ method: 'POST', url: '/oauth/revoke', headers: FORM, payload: form({ token: t.refresh_token }) });
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).toBeNull();
  });
  it('lists and revokes own connections', async () => {
    const { t } = await grant();
    const list = (await app.inject({ url: '/api/connections', headers: { cookie: sessionCookie } })).json() as { id: number; client: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].client).toBe('Test client');
    expect((await app.inject({ url: '/api/connections' })).statusCode).toBe(401);
    const [g] = await dbmod.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, auth.sha256(t.access_token)));
    expect((await app.inject({ method: 'DELETE', url: `/api/connections/${g.id}`, headers: { cookie: sessionCookie } })).statusCode).toBe(200);
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).toBeNull();
  });
  it('/mcp: 401 with WWW-Authenticate without a token, accepts exa_ and sets firstMcpAt', async () => {
    const no = await app.inject({ method: 'POST', url: '/mcp', payload: {} });
    expect(no.statusCode).toBe(401);
    expect(String(no.headers['www-authenticate'])).toContain('resource_metadata="http://localhost:5173/.well-known/oauth-protected-resource"');
    const { t } = await grant();
    const res = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${t.access_token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(res.statusCode).not.toBe(401);
    const [g] = await dbmod.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, auth.sha256(t.access_token)));
    expect(g.firstMcpAt).not.toBeNull();
  });
});

describe('device flow', () => {
  const grantType = 'urn:ietf:params:oauth:grant-type:device_code';
  const deviceStart = async (cid: string) => (await app.inject({ method: 'POST', url: '/oauth/device_authorization', headers: FORM, payload: form({ client_id: cid }) })).json();
  /** Przepisanie kodu w formularzu (krok 1): zwraca stronę zgody i jej csrf. */
  const lookup = async (code: string, cookie = sessionCookie) => {
    const entry = await app.inject({ url: '/oauth/device', headers: { cookie } });
    const csrf = /name="csrf" value="([^"]+)"/.exec(entry.body)![1];
    const page = await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: `${cookie}; oauth_csrf=${csrf}` }, payload: form({ csrf, step: 'lookup', code }) });
    return { page, csrf2: /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? '' };
  };

  it('pending, slow_down, approved by typing the code, then a token', async () => {
    const cid = await newClient();
    const d = await deviceStart(cid);
    expect(d.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(d.verification_uri_complete).toBeUndefined();
    const poll = () => token({ grant_type: grantType, client_id: cid, device_code: d.device_code });
    expect((await poll()).json().error).toBe('authorization_pending');
    expect((await poll()).json().error).toBe('slow_down');
    await dbmod.db.update(schema.oauthDeviceCodes).set({ lastPollAt: new Date(Date.now() - 10_000) }).where(eq(schema.oauthDeviceCodes.userCode, d.user_code));

    expect((await app.inject({ url: '/oauth/device' })).statusCode).toBe(302);
    const { page, csrf2 } = await lookup(d.user_code);
    expect(page.body).toContain('is not verified');
    expect(page.body).toContain('Test client');
    const ok = await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${csrf2}` }, payload: form({ csrf: csrf2, code: d.user_code, decision: 'allow' }) });
    expect(ok.statusCode).toBe(200);
    const t = await poll();
    expect(t.statusCode).toBe(200);
    expect(t.json().access_token).toMatch(/^exa_/);
  });

  it('C2: the code from the URL is never used or pre-filled, with or without typed=1', async () => {
    const cid = await newClient();
    const d = await deviceStart(cid);
    for (const q of [`code=${d.user_code}`, `typed=1&code=${d.user_code}`]) {
      const r = await app.inject({ url: `/oauth/device?${q}`, headers: { cookie: sessionCookie } });
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('Test client');
      expect(r.body).not.toContain(d.user_code);
      expect(r.body).toContain('do not continue');
    }
  });

  it('a POST without the CSRF cookie of the same form is refused (no approve, no lookup)', async () => {
    const cid = await newClient();
    const d = await deviceStart(cid);
    const r = await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: sessionCookie }, payload: form({ csrf: 'x', code: d.user_code, decision: 'allow' }) });
    expect(r.statusCode).toBe(400);
    expect((await token({ grant_type: grantType, client_id: cid, device_code: d.device_code })).json().error).toBe('authorization_pending');
  });

  it('C2: deny deletes only the code of that form (csrf bound to the code)', async () => {
    const cid = await newClient();
    const mine = await deviceStart(cid);
    const other = await deviceStart(cid);
    const { csrf2 } = await lookup(mine.user_code);
    const r = await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${csrf2}` }, payload: form({ csrf: csrf2, code: other.user_code, decision: 'deny' }) });
    expect(r.statusCode).toBe(400);
    expect((await token({ grant_type: grantType, client_id: cid, device_code: other.device_code })).json().error).toBe('authorization_pending');
    const { csrf2: c3 } = await lookup(mine.user_code);
    await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${c3}` }, payload: form({ csrf: c3, code: mine.user_code, decision: 'deny' }) });
    expect((await token({ grant_type: grantType, client_id: cid, device_code: mine.device_code })).json().error).toBe('access_denied');
  });

  it('expired codes', async () => {
    const cid = await newClient();
    const e = await deviceStart(cid);
    await dbmod.db.update(schema.oauthDeviceCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthDeviceCodes.userCode, e.user_code));
    expect((await token({ grant_type: grantType, client_id: cid, device_code: e.device_code })).json().error).toBe('expired_token');
  });
});

describe('C1: a bearer token cannot approve consent', () => {
  const grant = async () => {
    const cid = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(cid, challenge);
    const t = (await token({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier })).json();
    return { cid, t };
  };
  it('GET and POST /oauth/authorize and /oauth/device are refused for exa_ tokens, token endpoints still work', async () => {
    const { cid, t } = await grant();
    const bearer = { authorization: `Bearer ${t.access_token}`, cookie: 'oauth_csrf=abc' };
    const q = form({ response_type: 'code', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expect((await app.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: bearer })).statusCode).toBe(403);
    const post = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { ...FORM, ...bearer }, payload: form({ csrf: 'abc', client_id: cid, redirect_uri: REDIRECT, code_challenge: pkce().challenge, decision: 'allow' }) });
    expect(post.statusCode).toBe(403);
    expect(post.headers.location).toBeUndefined();
    const d = (await app.inject({ method: 'POST', url: '/oauth/device_authorization', headers: FORM, payload: form({ client_id: cid }) })).json();
    expect((await app.inject({ method: 'GET', url: '/oauth/device', headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, ...bearer }, payload: form({ csrf: 'abc', code: d.user_code, decision: 'allow' }) })).statusCode).toBe(403);
    expect((await token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: cid, device_code: d.device_code })).json().error).toBe('authorization_pending');
    expect((await app.inject({ method: 'POST', url: '/oauth/revoke', headers: { ...FORM, authorization: bearer.authorization }, payload: form({ token: t.refresh_token }) })).statusCode).toBe(200);
  });
});

describe('the agent client only comes from pairing', () => {
  const AGENT = 'exponential-agent';
  beforeAll(async () => {
    await dbmod.db.insert(schema.oauthClients).values({ id: AGENT, name: 'Exponential agent', redirectUris: ['http://127.0.0.1/cb'] }).onConflictDoNothing();
  });
  it('device_authorization, device_code, authorize and authorization_code are refused', async () => {
    const d = await app.inject({ method: 'POST', url: '/oauth/device_authorization', headers: FORM, payload: form({ client_id: AGENT }) });
    expect(d.statusCode).toBe(400);
    expect(d.json().error).toBe('unauthorized_client');
    // Nawet wiersz device code wstawiony wprost nie da grantu ani nie da się zatwierdzić na stronie.
    await dbmod.db.insert(schema.oauthDeviceCodes).values({ deviceHash: auth.sha256('dev-agent'), userCode: 'BBBB-CCCC', clientId: AGENT, expiresAt: new Date(Date.now() + 60_000) });
    expect((await token({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: AGENT, device_code: 'dev-agent' })).json().error).toBe('unauthorized_client');
    const { page } = await (async () => {
      const entry = await app.inject({ url: '/oauth/device', headers: { cookie: sessionCookie } });
      const csrf = /name="csrf" value="([^"]+)"/.exec(entry.body)![1];
      return { page: await app.inject({ method: 'POST', url: '/oauth/device', headers: { ...FORM, cookie: `${sessionCookie}; oauth_csrf=${csrf}` }, payload: form({ csrf, code: 'BBBB-CCCC' }) }) };
    })();
    expect(page.body).not.toContain('wants access');
    const q = form({ response_type: 'code', client_id: AGENT, redirect_uri: 'http://127.0.0.1/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expect((await app.inject({ url: `/oauth/authorize?${q}`, headers: { cookie: sessionCookie } })).statusCode).toBe(400);
    expect((await token({ grant_type: 'authorization_code', client_id: AGENT, code: 'x', redirect_uri: 'http://127.0.0.1/cb', code_verifier: pkce().verifier })).json().error).toBe('unauthorized_client');
  });
  it("GET /api/connections leaves agent grants out", async () => {
    const dev = randomUUID();
    await dbmod.db.insert(schema.agents).values({ id: dev, userId, name: 'Win-PC' });
    const { issueGrant } = await import('../src/server/oauth.ts');
    const g = await issueGrant(AGENT, userId, '', dev);
    const g2 = await issueGrant(AGENT, userId, '', null);
    const list = (await app.inject({ url: '/api/connections', headers: { cookie: sessionCookie } })).json() as { id: number; client: string }[];
    const [row] = await dbmod.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, auth.sha256(g.access_token)));
    const [row2] = await dbmod.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.accessHash, auth.sha256(g2.access_token)));
    expect(list.find((c) => c.id === row.id || c.id === row2.id)).toBeUndefined();
    expect(list.every((c) => !('agent' in c) && !('computerName' in c))).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/connections/${row2.id}`, headers: { cookie: sessionCookie } })).statusCode).toBe(200);
  });
});

describe('reuse of codes and refresh tokens', () => {
  it('a reused auth code revokes the grant issued from it', async () => {
    const cid = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(cid, challenge);
    const body = { grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier };
    const t = (await token(body)).json();
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).not.toBeNull();
    expect((await token(body)).json().error).toBe('invalid_grant');
    expect(await auth.userFromToken(`Bearer ${t.access_token}`)).toBeNull();
    expect((await token({ grant_type: 'refresh_token', client_id: cid, refresh_token: t.refresh_token })).json().error).toBe('invalid_grant');
  });
  it('a replayed rotated refresh token revokes the successor grant', async () => {
    const cid = await newClient();
    const { verifier, challenge } = pkce();
    const code = await authorize(cid, challenge);
    const t = (await token({ grant_type: 'authorization_code', client_id: cid, code, redirect_uri: 'http://127.0.0.1:9999/callback', code_verifier: verifier })).json();
    const n = (await token({ grant_type: 'refresh_token', client_id: cid, refresh_token: t.refresh_token })).json();
    expect(await auth.userFromToken(`Bearer ${n.access_token}`)).not.toBeNull();
    expect((await token({ grant_type: 'refresh_token', client_id: cid, refresh_token: t.refresh_token })).json().error).toBe('invalid_grant');
    expect(await auth.userFromToken(`Bearer ${n.access_token}`)).toBeNull();
  });
});


describe('reserved agent name', () => {
  it('register rejects "Exponential agent" in any case and with spaces', async () => {
    for (const n of ['Exponential agent', '  exponential AGENT ']) {
      const r = await registerNamed(n);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('invalid_client_metadata');
    }
    expect((await registerNamed('Exponential agent 2')).statusCode).toBe(201);
  });
});
