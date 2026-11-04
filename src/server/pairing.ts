/**
 * Pobranie agenta z parowaniem: /agent/download dokleja do exponential-agent.exe stopkę z adresem i jednorazowym tokenem
 * (JSON, uint32 LE długość JSON, "EXPCFG01"), a pobrany program wymienia token na grant OAuth bez logowania w terminalu.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull, ne, sql as dsql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.ts';
import { agentPairings, agentTombstones, agents, oauthClients, oauthGrants, apiTokens, users } from '../db/schema.ts';
import { createApiToken, sha256 } from './auth.ts';
import { AGENT_CLIENT_ID, AGENT_CLIENT_NAME, issueGrant } from './oauth.ts';
import { createAttemptLimiter } from './password.ts';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const PAIR_MS = 15 * 60_000;
const CACHE_MS = 3600e3;
const MAGIC = 'EXPCFG01';
export { AGENT_CLIENT_ID };
const DEFAULT_EXE_URL = 'https://github.com/Wheatlay/ExpoNential/releases/latest/download/exponential-agent.exe';

type Fetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, { redirect: 'follow', ...init });
let exeUrl = process.env.AGENT_EXE_URL || DEFAULT_EXE_URL;
let testSource = false;
let cache: { bytes: Buffer; etag: string | null; at: number; version: string } | null = null;

/** Wersja z adresu, pod który przekierowuje GitHub (…/download/agent-v0.4.0/…): trafia do nazwy pobieranego pliku. */
export const versionFromUrl = (u: string) => /agent-v(\d+\.\d+\.\d+)/.exec(u)?.[1] ?? '';

/** Tylko dla testów: podmiana pobierania z GitHuba. */
export function setAgentExeSource(opts: { fetcher?: Fetcher; url?: string } | null) {
  testSource = !!opts?.fetcher;
  fetcher = opts?.fetcher ?? ((url, init) => fetch(url, { redirect: 'follow', ...init }));
  exeUrl = opts?.url ?? (process.env.AGENT_EXE_URL || DEFAULT_EXE_URL);
  cache = null;
}

async function agentExe(): Promise<Buffer> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.bytes;
  // Wersja jest tylko w pierwszym przekierowaniu (latest -> /download/agent-vX/); dalej GitHub kieruje na serwer plików bez niej.
  let url = exeUrl;
  let version = versionFromUrl(url);
  if (!version && exeUrl === DEFAULT_EXE_URL && !testSource) {
    try {
      const head = await fetch(exeUrl, { method: 'HEAD', redirect: 'manual' });
      const loc = head.headers.get('location');
      if (loc) { version = versionFromUrl(loc); if (version) url = new URL(loc, exeUrl).toString(); }
    } catch { /* plik bez wersji w nazwie */ }
  }
  const res = await fetcher(url, cache?.etag ? { headers: { 'If-None-Match': cache.etag } } : undefined);
  if (res.status === 304 && cache) { cache.at = Date.now(); return cache.bytes; }
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  cache = { bytes: Buffer.from(await res.arrayBuffer()), etag: res.headers.get('etag'), at: Date.now(), version: version || versionFromUrl(res.url ?? '') };
  return cache.bytes;
}

/** Stopka doklejana do pliku: JSON, jego długość (uint32 LE) i znacznik. */
export function pairingTrailer(config: { url: string; pairing: string; engine?: string; goal?: number }) {
  const json = Buffer.from(JSON.stringify(config), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return Buffer.concat([json, len, Buffer.from(MAGIC, 'ascii')]);
}

const limiter = createAttemptLimiter(60, 15 * 60_000);
const limited = (req: FastifyRequest, reply: FastifyReply) => {
  const key = `pair|${req.ip}`;
  if (limiter.blocked(key)) { void reply.code(429).send({ error: 'rate_limited' }); return true; }
  limiter.fail(key);
  return false;
};

const validPairing = (token: string) => and(eq(agentPairings.hash, sha256(token)), isNull(agentPairings.usedAt), gt(agentPairings.expiresAt, new Date()));

export async function registerPairing(app: FastifyInstance) {
  app.get<{ Querystring: { engine?: string; goal?: string } }>('/agent/download', async (req, reply) => {
    // Klient wybrany w kreatorze: instalator go pokazuje i ustawia jako silnik agenta.
    const engine = req.query.engine === 'codex' ? 'codex' : 'claude';
    // Cel z kreatora (1..3): instalator wie, do jakiego poziomu ma skonfigurować komputer.
    const g = Number.parseInt(req.query.goal ?? '', 10);
    const goal = g >= 1 && g <= 3 ? g : 3;
    if (req.authVia !== 'session' || !req.user) return reply.redirect('/login');
    let exe: Buffer;
    try { exe = await agentExe(); } catch (e) {
      req.log.error(e);
      return reply.code(502).type('text/html; charset=utf-8').header('Cache-Control', 'no-store')
        .send('<!doctype html><meta charset="utf-8"><title>Exponential</title><p>The agent could not be downloaded right now. Try again in a minute.</p>');
    }
    const token = `pair_${randomBytes(24).toString('base64url')}`;
    await db.insert(agentPairings).values({ hash: sha256(token), userId: req.user.id, expiresAt: new Date(Date.now() + PAIR_MS) });
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="exponential-agent${cache?.version ? '-' + cache.version : ''}.exe"`)
      .header('Cache-Control', 'no-store').send(Buffer.concat([exe, pairingTrailer({ url: BASE_URL, pairing: token, engine, goal })]));
  });

  app.get<{ Params: { pairing: string } }>('/api/agent/pair/:pairing', async (req, reply) => {
    if (limited(req, reply)) return;
    const [row] = await db.select({ name: users.name }).from(agentPairings).innerJoin(users, eq(users.id, agentPairings.userId))
      .where(and(validPairing(req.params.pairing.slice(0, 200)), eq(users.active, true)));
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return { user: { name: row.name } };
  });

  app.post('/api/agent/pair', async (req, reply) => {
    if (limited(req, reply)) return;
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { pairing?: unknown; name?: unknown; deviceId?: unknown };
    const deviceId = z.string().uuid().safeParse(b.deviceId).data ?? null;
    if (typeof b.pairing !== 'string' || !b.pairing) return reply.code(404).send({ error: 'Not found' });
    const [row] = await db.update(agentPairings).set({ usedAt: new Date() }).where(validPairing(b.pairing.slice(0, 200))).returning();
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const [u] = await db.select({ name: users.name, active: users.active }).from(users).where(eq(users.id, row.userId));
    if (!u?.active) return reply.code(404).send({ error: 'Not found' });
    await db.insert(oauthClients).values({ id: AGENT_CLIENT_ID, name: AGENT_CLIENT_NAME, redirectUris: ['http://127.0.0.1/cb'] }).onConflictDoNothing();
    // Świeże parowanie kasuje nagrobek ręcznie usuniętego komputera (ponowna instalacja działa od razu).
    await db.delete(agentTombstones).where(deviceId ? and(eq(agentTombstones.id, deviceId), eq(agentTombstones.userId, row.userId)) : eq(agentTombstones.userId, row.userId));
    // Nazwa komputera z agenta: wiersz agents powstaje (albo dostaje nazwę) już przy parowaniu, tylko dla własnego komputera użytkownika.
    const pcName = typeof b.name === 'string' ? b.name.trim().slice(0, 100) : '';
    if (deviceId && pcName) {
      // Zamiana, nie usunięcie: inne wiersze tego użytkownika z tą samą nazwą (bez nagrobka) tracą grant, klucze i wiersz.
      const same = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.userId, row.userId), ne(agents.id, deviceId), dsql`lower(trim(${agents.name})) = ${pcName.toLowerCase()}`));
      for (const o of same) {
        await db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.agentId, o.id), eq(oauthGrants.userId, row.userId), isNull(oauthGrants.revokedAt)));
        await db.delete(apiTokens).where(and(eq(apiTokens.agentId, o.id), eq(apiTokens.userId, row.userId)));
        await db.delete(agents).where(and(eq(agents.id, o.id), eq(agents.userId, row.userId)));
      }
      await db.insert(agents).values({ id: deviceId, userId: row.userId, name: pcName })
        .onConflictDoUpdate({ target: agents.id, set: { name: pcName }, setWhere: eq(agents.userId, row.userId) });
    }
    // Sieroty po starszych parowaniach (grant agenta bez komputera) nie mają już do czego należeć.
    await db.update(oauthGrants).set({ revokedAt: new Date() }).where(and(eq(oauthGrants.clientId, AGENT_CLIENT_ID), eq(oauthGrants.userId, row.userId), isNull(oauthGrants.agentId), isNull(oauthGrants.revokedAt)));
    const grant = await issueGrant(AGENT_CLIENT_ID, row.userId, '', deviceId);
    return reply.header('Cache-Control', 'no-store').send({ client_id: AGENT_CLIENT_ID, ...grant, user: { name: u.name } });
  });

  /**
   * Klucz MCP dla instalatora: agent (grant OAuth klienta exponential-agent) prosi o osobisty token trk_ dla klienta AI
   * na tym komputerze. Nazwa "<klient> · <komputer>"; ponowna instalacja zastępuje poprzedni token o tej nazwie na tym samym komputerze (grant musi mieć komputer).
   */
  app.post('/api/agent/mcp-key', async (req, reply) => {
    const m = /^Bearer\s+(exa_\S+)$/i.exec(req.headers.authorization ?? '');
    if (req.authVia !== 'token' || !req.user || !m) return reply.code(403).send({ error: 'Only the Exponential agent can create this key' });
    const [g] = await db.select({ clientId: oauthGrants.clientId, agentId: oauthGrants.agentId }).from(oauthGrants)
      .where(eq(oauthGrants.accessHash, sha256(m[1])));
    if (!g || g.clientId !== AGENT_CLIENT_ID) return reply.code(403).send({ error: 'Only the Exponential agent can create this key' });
    if (!g.agentId) return reply.code(400).send({ error: 'This agent grant has no computer; pair the agent again' });
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { client?: unknown; device?: unknown };
    if (typeof b.client !== 'string' || !b.client.trim() || b.client.length > 40 || typeof b.device !== 'string' || !b.device.trim() || b.device.length > 80) {
      return reply.code(400).send({ error: 'client (max 40) and device (max 80) are required' });
    }
    const name = `${b.client.trim()} · ${b.device.trim()}`;
    await db.delete(apiTokens).where(and(eq(apiTokens.userId, req.user.id), eq(apiTokens.agentId, g.agentId), eq(apiTokens.name, name)));
    const token = await createApiToken(req.user.id, name, g.agentId);
    return reply.header('Cache-Control', 'no-store').send({ token });
  });
}
