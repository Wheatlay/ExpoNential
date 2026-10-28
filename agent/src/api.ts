import { loadConfig, updateConfig } from './config';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type Auth = { base: string; auth: string };

/** POST to an OAuth endpoint (form-encoded per RFC 6749/8628, or JSON for registration). */
export async function oauthPost(base: string, path: string, body: Record<string, unknown>, asJson = false): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': asJson ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: asJson ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
  if (!res.ok && !json.error) throw new HttpError(res.status, `${path}: HTTP ${res.status}`);
  return json;
}

/** Base URL and Authorization header from config; refreshes an expired OAuth access token. Null = not logged in. */
export async function getAuth(): Promise<Auth | null> {
  const cfg = loadConfig();
  if (!cfg.url) return null;
  const base = cfg.url.replace(/\/+$/, '');
  if (cfg.token) return { base, auth: `Bearer ${cfg.token}` };
  const o = cfg.oauth;
  if (!o) return null;
  if (o.expiresAt - 60_000 > Date.now()) return { base, auth: `Bearer ${o.access}` };
  const r = await oauthPost(base, '/oauth/token', { grant_type: 'refresh_token', refresh_token: o.refresh, client_id: o.clientId });
  if (!r.access_token) throw new Error(`Token refresh failed (${r.error || 'unknown'}), run: exponential-agent login`);
  updateConfig((c) => {
    c.oauth = { access: r.access_token, refresh: r.refresh_token || o.refresh, expiresAt: Date.now() + (Number(r.expires_in) || 3600) * 1000, clientId: o.clientId };
  });
  return { base, auth: `Bearer ${r.access_token}` };
}

export async function request<T = any>(a: Auth, method: string, path: string, body?: unknown, timeoutMs = 60000): Promise<T> {
  const res = await fetch(`${a.base}${path}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: a.auth, 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = '';
    try { msg = JSON.parse(text).error ?? ''; } catch { /* plain */ }
    throw new HttpError(res.status, `${method} ${path}: HTTP ${res.status}${msg ? ` ${String(msg).slice(0, 150)}` : ''}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type Project = { key: string; githubRepo: string | null };
export const listProjects = (a: Auth) => request<Project[]>(a, 'GET', '/api/projects');
