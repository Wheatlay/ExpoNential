import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';
import { logFile } from './log';
import { extensionClaude, whichBin } from './util';

export type Engine = 'claude' | 'codex';
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];

export function findEngine(engine: Engine): string | null {
  const onPath = whichBin(engine);
  if (onPath) return onPath;
  return engine === 'claude' ? extensionClaude() : null;
}

// Issue text is written by every project member, so it is untrusted (prompt injection). Read/Grep/Glob are NOT
// allowed explicitly: without consent they only work inside the repo. Secrets in the repo are denied too.
const ALLOWED = 'Skill,mcp__tracker__get_issue,mcp__tracker__list_comments,mcp__tracker__list_issues,mcp__tracker__set_analysis';
const SECRETS = ['**/.env*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12'];
const DENIED = `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,${SECRETS.map((s) => `Read(${s}),Grep(${s})`).join(',')}`;

export type RunOpts = { engine: Engine; bin: string; prompt: string; model: string; cwd: string; base: string; auth: string; activeAccount?: string };

/** Runs the engine non-interactively in cwd, prompt on stdin, output appended to the log. Resolves with the exit code. */
export function runEngine(o: RunOpts): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, TRACKER_HOOKS: '0' };   // a background session leaves no worklog
  let args: string[];
  if (o.engine === 'claude') {
    // Only the tracker MCP, none of the user's other servers.
    const mcpFile = join(dataDir(), 'mcp.json');
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { tracker: { type: 'http', url: `${o.base}/mcp`, headers: { Authorization: o.auth } } } }), { mode: 0o600 });
    args = ['-p', '--model', o.model, '--plugin-url', `${o.base}/agent/plugin.zip`, '--allowedTools', ALLOWED, '--disallowedTools', DENIED,
      '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', mcpFile];
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
