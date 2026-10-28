import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

/** Runs git with an argument array (no shell). Resolves trimmed stdout; rejects with stderr text. */
export function git(args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, timeout: opts.timeout ?? 30000, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error((errOut || err.message).trim().slice(0, 300)));
      else resolve(out.trim());
    });
  });
}

export const gitSafe = (args: string[], opts: { cwd?: string; timeout?: number } = {}) => git(args, opts).catch(() => '');

/** Opens a URL with the default handler (browser or vscode://). No cmd.exe, so no % or & parsing. */
export function openUrl(url: string) {
  if (!/^https?:[/][/]/i.test(url)) { console.log(`Not opening a non-http(s) address, open it yourself if you trust it: ${url}`); return; }
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  p.on('error', () => { /* no handler available */ });
  p.unref();
}

/** First match for a program name on PATH (on Windows: .exe, then .cmd/.bat). */
export function whichBin(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const e of exts) {
      const f = join(dir, name + e);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

const verCmp = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

/** Newest bundled claude binary from the VS Code / Cursor extension. */
export function extensionClaude(): string | null {
  let best: { v: string; f: string } | null = null;
  for (const root of [join(homedir(), '.vscode', 'extensions'), join(homedir(), '.cursor', 'extensions')]) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      const m = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/.exec(n);
      if (!m) continue;
      const f = join(root, n, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (existsSync(f) && (!best || verCmp(m[1], best.v) > 0)) best = { v: m[1], f };
    }
  }
  return best?.f ?? null;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/** "owner/name" (lowercase) from a git remote URL (https or ssh). */
export const slug = (url: string) => url.replace(/^.*?github\.com[:/]/i, '').replace(/^[^:]+:/, '').replace(/\.git$|\/+$/g, '').toLowerCase();
