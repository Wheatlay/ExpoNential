import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'ExponentialAgent';
const vbsPath = () => join(dataDir(), 'start-hidden.vbs');

/** Program and arguments that start this agent: the SEA executable itself, or node + the bundled script when run from source. */
function selfParts(): string[] {
  let sea = false;
  try { sea = (require('node:sea') as { isSea(): boolean }).isSea(); } catch { /* not a SEA build */ }
  return sea ? [process.execPath, 'start'] : [process.execPath, process.argv[1], 'start'];
}

/** Writes start-hidden.vbs (starts the agent with no console window) and returns its path. */
function writeVbs(): string {
  const cmd = selfParts().map((p, i, a) => (i === a.length - 1 ? p : `""${p}""`)).join(' ');
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(vbsPath(), `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "${cmd}", 0, False\r\nSet sh = Nothing\r\n`);
  return vbsPath();
}

/** `start --detach`: run the agent hidden and return. */
export function startDetached() {
  if (process.platform === 'win32') {
    const p = spawn('wscript.exe', [writeVbs()], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
  } else {
    const [bin, ...rest] = selfParts();
    spawn(bin, rest, { detached: true, stdio: 'ignore' }).unref();
  }
  console.log('Agent started in the background.');
}

export function autostartState(): string {
  if (process.platform !== 'win32') return 'not supported on this OS yet';
  try {
    const out = execFileSync('reg', ['query', KEY, '/v', NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return `on (${out.split(/REG_SZ\s+/)[1]?.trim() ?? ''})`;
  } catch { return 'off'; }
}

export function cmdAutostart(arg?: string) {
  if (arg !== 'on' && arg !== 'off') throw new Error('usage: autostart on|off');
  if (process.platform !== 'win32') { console.log('TODO: autostart is implemented for Windows only (use systemd --user / launchd yourself for now).'); return; }
  if (arg === 'on') {
    const vbs = writeVbs();
    execFileSync('reg', ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'], { stdio: 'ignore', windowsHide: true });
    console.log('Autostart on.');
  } else {
    try { execFileSync('reg', ['delete', KEY, '/v', NAME, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* was not set */ }
    try { rmSync(vbsPath(), { force: true }); } catch { /* ignore */ }
    console.log('Autostart off.');
  }
}
