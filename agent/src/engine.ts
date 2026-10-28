import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_VERSION, dataDir } from './config';
import { logFile } from './log';
import { extensionClaude, whichBin } from './util';

// Plugin files (plugin/ of the repo) are embedded at build time by scripts/build.mjs: { 'relative/path': 'text' }.
declare const __PLUGIN_FILES__: Record<string, string>;

/** Extracts the bundled plugin to <dataDir>/plugin-<version>/ (once per agent version) and returns that path. */
export function ensurePlugin(): string {
  const dir = join(dataDir(), `plugin-${AGENT_VERSION}`);
  if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(__PLUGIN_FILES__)) {
    const f = join(tmp, ...rel.split('/'));
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text, 'utf8');
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}

export type Engine = 'claude' | 'codex';
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];

export function findEngine(engine: Engine): string | null {
  const onPath = whichBin(engine);
  if (onPath) return onPath;
  return engine === 'claude' ? extensionClaude() : null;
}

// Issue text is written by every project member, so it is untrusted (prompt injection). Read/Grep/Glob are NOT
// allowed explicitly: without consent they only work inside the repo. Secrets in the repo are denied too.
const ALLOWED = 'Skill,mcp__tracker__get_procedure,mcp__tracker__get_issue,mcp__tracker__list_comments,mcp__tracker__list_issues,mcp__tracker__set_analysis';
const SECRETS = ['**/.env*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12'];
const DENIED = `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,${SECRETS.map((s) => `Read(${s}),Grep(${s})`).join(',')}`;

export type RunOpts = { untrusted?: boolean; engine: Engine; bin: string; prompt: string; model: string; cwd: string; base: string; auth: string; activeAccount?: string };

/** Runs the engine non-interactively in cwd, prompt on stdin, output appended to the log. Resolves with the exit code. */
export function runEngine(o: RunOpts): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, TRACKER_HOOKS: '0' };   // a background session leaves no worklog
  let args: string[];
  if (o.engine === 'claude') {
    // Only the tracker MCP, none of the user's other servers.
    const mcpFile = join(dataDir(), 'mcp.json');
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { tracker: { type: 'http', url: `${o.base}/mcp`, headers: { Authorization: o.auth } } } }), { mode: 0o600 });
    // A 'clone' repo comes from the project's githubRepo, which a project admin controls: its .claude/settings*.json, hooks
    // and .mcp.json must not run on this machine. So only user settings load; --strict-mcp-config ignores every
    // MCP source except our --mcp-config. Own folders (manual/hook) keep project settings.
    args = ['-p', '--model', o.model, '--plugin-dir', ensurePlugin(), '--allowedTools', ALLOWED, '--disallowedTools', DENIED,
      '--setting-sources', o.untrusted ? 'user' : 'project', '--strict-mcp-config', '--mcp-config', mcpFile];
    if (o.activeAccount) env.CLAUDE_CONFIG_DIR = o.activeAccount;
  } else {
    // TODO(verify): codex config keys for streamable-HTTP MCP with a bearer token (bearer_token_env_var).
    // The token goes through the environment, not the command line. The Claude denylist has no codex equivalent:
    // read-only sandbox only prevents writes, secrets in the repo stay readable.
    env.EXPONENTIAL_AGENT_TOKEN = o.auth.replace(/^Bearer /i, '');
    args = ['exec', '--sandbox', 'read-only',
      '-c', `mcp_servers.tracker.url=${JSON.stringify(`${o.base}/mcp`)}`,
      '-c', 'mcp_servers.tracker.bearer_token_env_var="EXPONENTIAL_AGENT_TOKEN"', '-'];
  }
  return new Promise((resolve) => {
    const isCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(o.bin);
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const p = isCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[o.bin, ...args].map(q).join(' ')}"`], { cwd: o.cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(o.bin, args, { cwd: o.cwd, env, windowsHide: true });
    const out = createWriteStream(logFile(), { flags: 'a' });
    p.stdout.pipe(out, { end: false });
    p.stderr.pipe(out, { end: false });
    const timer = setTimeout(() => { out.write('agent: timeout 30 min, killing\n'); p.kill(); }, 30 * 60_000);
    p.on('error', (e) => { clearTimeout(timer); out.write(`agent: spawn error ${e.message}\n`); out.end(); resolve(-1); });
    p.on('close', (code) => { clearTimeout(timer); out.end(); resolve(code ?? -1); });
    p.stdin.on('error', () => { /* process exited early */ });
    p.stdin.end(o.prompt, 'utf8');
  });
}
