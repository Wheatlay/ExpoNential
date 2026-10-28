import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AGENT_VERSION = '0.1.2';

export type RepoEntry = { path: string; source: 'manual' | 'clone' | 'hook' };
export type Config = {
  url?: string;
  token?: string;
  oauth?: { access: string; refresh: string; expiresAt: number; clientId: string };
  deviceId?: string;
  engine?: 'claude' | 'codex';
  repos: Record<string, RepoEntry>;
  version?: string;
};

export const dataDir = () => join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'exponential-agent');

export function loadConfig(): Config {
  try {
    const c = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8')) as Config;
    return { ...c, repos: c.repos ?? {} };
  } catch { return { repos: {} }; }
}

/** Reads the fresh file, applies fn, writes atomically (the hook and the agent both write). */
export function updateConfig(fn: (c: Config) => void): Config {
  const c = loadConfig();
  fn(c);
  c.version = AGENT_VERSION;
  if (!c.deviceId) c.deviceId = randomUUID();
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, join(dir, 'config.json'));
  return c;
}
