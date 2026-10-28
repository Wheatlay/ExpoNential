import { execFileSync } from 'node:child_process';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'ExponentialAgent';

/** Command that starts this agent: the SEA executable itself, or node + the bundled script when run from source. */
function selfCommand(): string {
  let sea = false;
  try { sea = (require('node:sea') as { isSea(): boolean }).isSea(); } catch { /* not a SEA build */ }
  return sea ? `"${process.execPath}" start` : `"${process.execPath}" "${process.argv[1]}" start`;
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
    execFileSync('reg', ['add', KEY, '/v', NAME, '/t', 'REG_SZ', '/d', selfCommand(), '/f'], { stdio: 'ignore', windowsHide: true });
    console.log('Autostart on.');
  } else {
    try { execFileSync('reg', ['delete', KEY, '/v', NAME, '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* was not set */ }
    console.log('Autostart off.');
  }
}
