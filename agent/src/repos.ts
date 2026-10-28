import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAuth, listProjects, type Project } from './api';
import { dataDir, loadConfig, updateConfig, type RepoEntry } from './config';
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

/** Working directory for an analysis. Own clones run in a fresh detached worktree of the up-to-date branch; user folders in place. */
export async function prepareWorkdir(key: string, entry: RepoEntry): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  if (entry.source !== 'clone') return { dir: entry.path, cleanup: async () => {} };
  await git(['-C', entry.path, 'fetch', '--prune', 'origin'], { timeout: 300000 });
  // TODO: /api/projects does not expose a deploy branch; the remote default branch is used.
  let ref = await gitSafe(['-C', entry.path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  for (const c of ['origin/main', 'origin/master']) if (!ref && await gitSafe(['-C', entry.path, 'rev-parse', '--verify', c])) ref = c;
  if (!ref) throw new Error('cannot determine the default branch of the clone');
  const tmp = join(dataDir(), 'tmp', `${key}-${Date.now()}`);
  mkdirSync(join(dataDir(), 'tmp'), { recursive: true });
  await git(['-C', entry.path, 'worktree', 'add', '--detach', tmp, ref], { timeout: 120000 });
  return {
    dir: tmp,
    cleanup: async () => {
      await gitSafe(['-C', entry.path, 'worktree', 'remove', '--force', tmp]);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      await gitSafe(['-C', entry.path, 'worktree', 'prune']);
    },
  };
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
    updateConfig((c) => { c.repos[key] = { path: full, source: 'set' }; });
    console.log(`${key} -> ${full}`);
  } else if (sub === 'clone') {
    if (!p.githubRepo) throw new Error('the project has no GitHub repo set');
    const target = join(dataDir(), 'repos', p.githubRepo.replace('/', '-'));
    if (!existsSync(target)) {
      mkdirSync(join(dataDir(), 'repos'), { recursive: true });
      execFileSync('git', ['clone', `https://github.com/${p.githubRepo}.git`, target], { stdio: 'inherit' });
    }
    const problem = await validateRepo(target, p.githubRepo);
    if (problem) throw new Error(problem);
    updateConfig((c) => { c.repos[key] = { path: target, source: 'clone' }; });
    console.log(`${key} -> ${target}`);
  } else throw new Error('usage: repos set <KEY> <path> | repos clone <KEY>');
}
