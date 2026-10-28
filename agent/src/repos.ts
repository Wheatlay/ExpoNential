import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAuth, listProjects, type Project } from './api';
import { dataDir, loadConfig, updateConfig, type RepoEntry } from './config';
import type { Engine } from './engine';
import { log } from './log';
import { git, gitSafe, slug } from './util';

/** Error text when `path` is not a git clone of `githubRepo`; null when it is. */
export async function validateRepo(path: string, githubRepo: string | null | undefined): Promise<string | null> {
  if (!githubRepo) return 'the project has no GitHub repo set (Settings > project > GitHub repo)';
  if (!existsSync(path)) return `folder ${path} does not exist`;
  const remotes = await gitSafe(['-C', path, 'remote', '-v']);
  const want = githubRepo.toLowerCase();
  const ok = remotes.split('\n').some((l) => { const url = l.split(/\s+/)[1]; return !!url && slug(url) === want; });
  return ok ? null : `${path} is not a clone of ${githubRepo} (git remote -v does not list it)`;
}

// Same patterns as the Claude denylist (engine.ts), as basename regexes.
const SECRET_FILES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /\.pfx$/i, /\.p12$/i, /^secrets\./i, /^credentials/i];

/** Deletes secret-looking files inside a worktree (skips .git). Returns how many were removed. */
function scrubSecrets(root: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SECRET_FILES.some((re) => re.test(e.name))) { try { rmSync(p, { force: true }); n++; } catch { /* best effort */ } }
    }
  };
  walk(root);
  return n;
}

/**
 * Working directory for an analysis. Own clones run in a fresh detached worktree of the up-to-date branch.
 * Codex has no file denylist, so it NEVER runs in a user folder: always a temp worktree of the local HEAD (no fetch),
 * with secret-looking files deleted. Claude on a user folder runs in place.
 */
export async function prepareWorkdir(key: string, entry: RepoEntry, engine: Engine = 'claude'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const isClone = entry.source === 'clone';
  if (!isClone && engine !== 'codex') return { dir: entry.path, cleanup: async () => {} };
  let ref = 'HEAD';
  if (isClone) {
    await git(['-C', entry.path, 'fetch', '--prune', 'origin'], { timeout: 300000 });
    // TODO: /api/projects does not expose a deploy branch; the remote default branch is used.
    ref = await gitSafe(['-C', entry.path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    for (const c of ['origin/main', 'origin/master']) if (!ref && await gitSafe(['-C', entry.path, 'rev-parse', '--verify', c])) ref = c;
    if (!ref) throw new Error('cannot determine the default branch of the clone');
  }
  const tmp = join(dataDir(), 'tmp', `${key}-${Date.now()}`);
  mkdirSync(join(dataDir(), 'tmp'), { recursive: true });
  const cleanup = async () => {
    await gitSafe(['-C', entry.path, 'worktree', 'remove', '--force', tmp]);
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    await gitSafe(['-C', entry.path, 'worktree', 'prune']);
  };
  try {
    await git(['-C', entry.path, 'worktree', 'add', '--detach', tmp, ref], { timeout: 120000 });
    if (engine === 'codex') log(`${key}: removed ${scrubSecrets(tmp)} secret-looking files from the worktree`);
  } catch (e) { await cleanup(); throw e; }
  return { dir: tmp, cleanup };
}

/** Clones the project's GitHub repo into the data folder and maps the key to it (source clone). */
export async function cloneProject(key: string, githubRepo: string | null | undefined): Promise<string> {
  if (!githubRepo) throw new Error('the project has no GitHub repo set');
  const target = join(dataDir(), 'repos', githubRepo.replace('/', '-'));
  if (!existsSync(target)) {
    mkdirSync(join(dataDir(), 'repos'), { recursive: true });
    await git(['clone', `https://github.com/${githubRepo}.git`, target], { timeout: 900000 });
  }
  const problem = await validateRepo(target, githubRepo);
  if (problem) throw new Error(problem);
  updateConfig((c) => { c.repos[key] = { path: target, source: 'clone' }; });
  return target;
}

async function projectOf(key: string): Promise<Project> {
  const a = await getAuth();
  if (!a) throw new Error('not logged in, run: exponential-agent login');
  const p = (await listProjects(a)).find((x) => x.key === key.toUpperCase());
  if (!p) throw new Error(`no project ${key.toUpperCase()} on your account`);
  return p;
}

export async function cmdRepos(args: string[]) {
  const [sub, rawKey, path] = args;
  if (!sub) {
    const repos = loadConfig().repos;
    const keys = Object.keys(repos);
    if (!keys.length) console.log('No repos mapped. Use: repos set <KEY> <path> | repos clone <KEY>');
    for (const k of keys) console.log(`${k}  ${repos[k].path}  (${repos[k].source})`);
    return;
  }
  if (!rawKey || !/^[A-Za-z]{2,10}$/.test(rawKey)) throw new Error('usage: repos set <KEY> <path> | repos clone <KEY>');
  const key = rawKey.toUpperCase();
  const p = await projectOf(key);
  if (sub === 'set') {
    if (!path) throw new Error('usage: repos set <KEY> <path>');
    const full = resolve(path);
    const problem = await validateRepo(full, p.githubRepo);
    if (problem) throw new Error(problem);
    updateConfig((c) => { c.repos[key] = { path: full, source: 'manual' }; });
    console.log(`${key} -> ${full}`);
  } else if (sub === 'clone') {
    console.log(`${key} -> ${await cloneProject(key, p.githubRepo)}`);
  } else throw new Error('usage: repos set <KEY> <path> | repos clone <KEY>');
}
