import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { getAuth, HttpError, listProjects, request, type Auth } from './api';
import { AGENT_VERSION, dataDir, loadConfig, updateConfig } from './config';
import { findEngine, MODELS, runEngine, type Engine } from './engine';
import { log } from './log';
import { cloneProject, prepareWorkdir, validateRepo } from './repos';
import { openUrl, pidAlive } from './util';

const KEY_RE = /^[A-Z]{2,10}-\d{1,6}$/;
const LOCK_MIN = 30;
const hhmm = () => new Date().toTimeString().slice(0, 5);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ServerRepo = { project: string; path?: string; source?: string; status?: string; error?: string };
let running = false;
let cloneAllowed: string[] = [];   // project keys the server lets this agent clone on its own
let lastErr = '';   // goes to the tracker with the next successful poll (Settings shows it next to the computer)

function activeAccount(): string | undefined {
  try { const a = readFileSync(join(dataDir(), 'active-account.txt'), 'utf8').trim(); return a && existsSync(a) ? a : undefined; } catch { return undefined; }
}

/** Another job started elsewhere (e.g. a second process) shows as a fresh *.lock file. */
function freshLocks(): boolean {
  try {
    return readdirSync(dataDir()).some((f) => f.endsWith('.lock') && f !== 'agent.lock' && Date.now() - statSync(join(dataDir(), f)).mtimeMs < LOCK_MIN * 60_000);
  } catch { return false; }
}

function singleInstance(): boolean {
  mkdirSync(dataDir(), { recursive: true });
  const f = join(dataDir(), 'agent.lock');
  try {
    const pid = Number(readFileSync(f, 'utf8'));
    if (pid && pid !== process.pid && pidAlive(pid)) return false;
  } catch { /* no lock */ }
  writeFileSync(f, String(process.pid));
  const drop = () => { try { rmSync(f, { force: true }); } catch { /* ignore */ } };
  process.on('exit', drop);
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { drop(); process.exit(0); });
  return true;
}

/** Server mapping wins for manually set entries; local hook/clone entries stay (they are reported with each poll). */
function mergeServerRepos(list: ServerRepo[]) {
  const cur = loadConfig().repos;
  const changes = list.filter((r) => {
    if (!r || !/^[A-Z]{2,10}$/.test(r.project) || !r.path) return false;
    const have = cur[r.project];
    if (r.source === 'manual' || r.source === 'set') return !have || have.path !== r.path || have.source !== 'manual';
    return !have && existsSync(r.path);   // hook/clone entry known only to the server (e.g. config was lost)
  });
  if (!changes.length) return;
  updateConfig((c) => {
    for (const r of changes) c.repos[r.project] = { path: r.path!, source: r.source === 'manual' || r.source === 'set' ? 'manual' : r.source === 'clone' ? 'clone' : 'hook' };
  });
  log(`mapping from server: ${changes.map((r) => r.project).join(', ')}`);
}

async function analyze(a: Auth, job: { key: string; deep: boolean }, deviceId: string) {
  const key = job.key;
  if (!KEY_RE.test(key)) throw new Error(`rejected key from server: ${key}`);
  const lock = join(dataDir(), `${key}.lock`);
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < LOCK_MIN * 60_000) { log(`${key} already running, skipping`); return; }
  writeFileSync(lock, String(process.pid));
  let claimed = false, failMsg = '';
  let cleanup = async () => {};
  try {
    let claim: { deep: boolean; model?: string };
    try {
      claim = await request(a, 'POST', `/api/issues/${key}/analyze/claim`, { deviceId, version: AGENT_VERSION, engine: loadConfig().engine ?? 'claude' });
    } catch (e) {
      const s = e instanceof HttpError ? e.status : 0;
      if (s === 409) { log(`${key} taken or no longer requested, skipping`); return; }
      if (s === 426) { log(`${key} skipped: agent version rejected by server`); return; }
      throw e;
    }
    claimed = true;
    const cfg = loadConfig();
    const engine: Engine = cfg.engine ?? 'claude';
    let model = claim.deep ? 'opus' : 'sonnet';
    if (claim.model && MODELS.includes(claim.model)) model = claim.model;

    // Never run in a folder that was not validated against the project's repo.
    const projectKey = key.replace(/-\d+$/, '');
    const project = (await listProjects(a)).find((p) => p.key === projectKey);
    let entry = cfg.repos[projectKey];
    if (!entry && cloneAllowed.includes(projectKey)) {
      log(`${projectKey}: no mapping, cloning (allowed by the server)`);
      await cloneProject(projectKey, project?.githubRepo);
      entry = loadConfig().repos[projectKey];
    }
    if (!entry) throw new Error(`no repo mapped for ${projectKey} (exponential-agent repos set ${projectKey} <path>)`);
    const problem = await validateRepo(entry.path, project?.githubRepo);
    if (problem) throw new Error(problem);
    const bin = findEngine(engine);
    if (!bin) throw new Error(`engine "${engine}" not found (PATH or VS Code extension)`);

    const q = claim.deep ? '?deep=1' : '';
    const res = await request<{ prompt: string; model?: string }>(a, 'GET', `/api/issues/${key}/prompt/analyze${q}`);
    if (res.model && MODELS.includes(res.model)) model = res.model;
    log(`start ${key} (${engine}, ${model})`);
    const wd = await prepareWorkdir(projectKey, entry, engine);
    cleanup = wd.cleanup;
    const code = await runEngine({ engine, bin, prompt: res.prompt, model, cwd: wd.dir, base: a.base, auth: a.auth, activeAccount: activeAccount() });
    log(`end ${key} (code ${code})`);
    if (code !== 0) failMsg = `${engine} exited with code ${code} (details in log.txt)`;
  } catch (e: any) {
    failMsg = e?.message ?? String(e);
    log(`error: ${failMsg}`);
  } finally {
    await cleanup().catch(() => {});
    try { rmSync(lock, { force: true }); } catch { /* ignore */ }
    // Release only after an error. After code 0 NOT: if the engine ran but saved nothing, the job should go to
    // Stalled, not back to the queue forever (every run is paid usage).
    if (claimed && failMsg) {
      lastErr = `${hhmm()} ${failMsg}`.slice(0, 300);
      try { await request(a, 'DELETE', `/api/issues/${key}/analyze/claim`, { deviceId, error: failMsg.slice(0, 2000) }); }
      catch (e: any) { log(`release: ${e.message}`); }
    }
  }
}

async function startJob(a: Auth, job: { id: number }, deviceId: string) {
  try {
    const claim = await request<{ key: string }>(a, 'POST', `/api/agent/start-jobs/${Math.trunc(job.id)}/claim`, { deviceId });
    if (!KEY_RE.test(claim.key)) throw new Error(`rejected key from server: ${claim.key}`);
    const mk = (p: string) => `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(p)}`;
    const max = 1900;   // Windows truncates longer links
    let link = mk((await request<{ prompt: string }>(a, 'GET', `/api/issues/${claim.key}/prompt/start`)).prompt);
    if (link.length > max) link = mk((await request<{ prompt: string }>(a, 'GET', `/api/issues/${claim.key}/prompt/start?compact=1`)).prompt);
    if (link.length > max) link = mk(`Working on ${claim.key}. Full data: get_issue ${claim.key}.`);
    log(`start work ${claim.key}`);
    openUrl(link);
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return;   // someone was first or the job expired
    throw e;
  }
}

export async function cmdStart() {
  if (!singleInstance()) { console.log('Agent is already running.'); return; }
  log(`start (PID ${process.pid}, v${AGENT_VERSION})`);
  let delay = 2, errLogged = false;
  for (;;) {
    try {
      const cfg = loadConfig();   // fresh each round: login/repos changes work without a restart
      if (!cfg.deviceId) throw new Error('no deviceId in config.json (run: exponential-agent login)');
      const a = await getAuth();
      if (!a) throw new Error('not logged in (run: exponential-agent login)');
      const busy = running || freshLocks();
      const qs = new URLSearchParams({
        deviceId: cfg.deviceId, name: hostname(), busy: busy ? '1' : '0', version: cfg.version ?? AGENT_VERSION, engine: cfg.engine ?? 'claude',
        // Mapping with paths and sources ({KEY: {path, source}}), so the server can show and route by it.
        repos: JSON.stringify(Object.fromEntries(Object.entries(cfg.repos).map(([k, r]) => [k, { path: r.path, source: r.source }]))),
      });
      if (lastErr) qs.set('error', lastErr.slice(0, 300));
      const res = await request<{ jobs?: Array<{ kind: string; key: string; deep?: boolean; id?: number }>; repos?: ServerRepo[]; cloneAllowed?: string[] }>(a, 'GET', `/api/agent/work?${qs}`);
      lastErr = '';   // the server received it
      cloneAllowed = Array.isArray(res.cloneAllowed) ? res.cloneAllowed.filter((k) => typeof k === 'string') : [];
      if (Array.isArray(res.repos)) mergeServerRepos(res.repos);
      delay = 2; errLogged = false;
      const job = busy ? undefined : res.jobs?.[0];
      if (job?.kind === 'analyze') {
        log(`analysis ${job.key}`);
        running = true;
        // Not awaited: the loop keeps polling (busy=1) so the server keeps the claim fresh during a long run.
        analyze(a, { key: job.key, deep: !!job.deep }, cfg.deviceId).catch((e) => log(`error: ${e.message}`)).finally(() => { running = false; });
      } else if (job?.kind === 'start' && job.id !== undefined) {
        try { await startJob(a, { id: job.id }, cfg.deviceId); }
        catch (e: any) { lastErr = `${hhmm()} could not open VS Code: ${e.message}`; log(lastErr); }
      }
      // No pause after a successful poll: the server holds the request (long poll). Only guards against a tight loop.
      if (!busy && !job) await sleep(200);
      else if (busy) await sleep(2000);
    } catch (e: any) {
      lastErr = `${hhmm()} ${e.message}`;
      if (!errLogged) { log(`error: ${e.message}`); errLogged = true; }
      await sleep(delay * 1000);
      delay = Math.min(delay * 2, 60);
    }
  }
}
