import { rmSync } from 'node:fs';
import { getAuth, request } from './api';
import { autostartState, cmdAutostart, startDetached } from './autostart';
import { AGENT_VERSION, dataDir, loadConfig, updateConfig } from './config';
import { findEngine, type Engine } from './engine';
import { runHook } from './hook';
import { cmdLogin } from './login';
import { cmdRepos } from './repos';
import { cmdStart } from './start';

const HELP = `exponential-agent ${AGENT_VERSION}
  login [--url URL] [--token TOKEN]   sign in (device flow when no token)
  start [--detach]                    run the poll loop (--detach: hidden, in the background)
  status                              show url, account, engine, repos, autostart
  engine claude|codex                 choose the AI engine
  repos | repos set <KEY> <path> | repos clone <KEY>
  hook <Event>                        Claude Code hook (reads JSON on stdin)
  autostart on|off                    start at Windows logon
  uninstall --yes                     remove autostart and ${'<dataDir>'}`;

async function status() {
  const cfg = loadConfig();
  console.log(`version:   ${AGENT_VERSION}`);
  console.log(`data dir:  ${dataDir()}`);
  console.log(`url:       ${cfg.url ?? '(not set, run: login)'}`);
  let account = '(not logged in)';
  try {
    const a = await getAuth();
    if (a) { const me = await request(a, 'GET', '/api/me', undefined, 10000); account = `${me.name ?? ''} ${me.email ? `<${me.email}>` : ''}`.trim() || 'ok'; }
  } catch (e: any) { account = `error: ${e.message}`; }
  console.log(`account:   ${account}`);
  console.log(`deviceId:  ${cfg.deviceId ?? '(not generated yet)'}`);
  const engine: Engine = cfg.engine ?? 'claude';
  console.log(`engine:    ${engine} -> ${findEngine(engine) ?? 'NOT FOUND'}`);
  const keys = Object.keys(cfg.repos);
  console.log(`repos:     ${keys.length ? '' : '(none)'}`);
  for (const k of keys) console.log(`  ${k}  ${cfg.repos[k].path}  (${cfg.repos[k].source})`);
  console.log(`autostart: ${autostartState()}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'login': return cmdLogin(args);
    case 'start': return args.includes('--detach') ? startDetached() : cmdStart();
    case 'status': return status();
    case 'engine': {
      const e = args[0];
      if (e !== 'claude' && e !== 'codex') { console.log(`engine: ${loadConfig().engine ?? 'claude'} (usage: engine claude|codex)`); return; }
      const bin = findEngine(e);
      if (!bin) throw new Error(`${e} not found on PATH${e === 'claude' ? ' or in the VS Code / Cursor extension' : ''}`);
      updateConfig((c) => { c.engine = e; });
      console.log(`engine: ${e} (${bin})`);
      return;
    }
    case 'repos': return cmdRepos(args);
    case 'autostart': return cmdAutostart(args[0]);
    case 'uninstall':
      if (!args.includes('--yes')) { console.log(`This removes autostart and deletes ${dataDir()} (config, token, logs, clones). Re-run with --yes.`); return; }
      cmdAutostart('off');
      rmSync(dataDir(), { recursive: true, force: true });
      console.log(`Deleted ${dataDir()}.`);
      return;
    default: console.log(HELP);
  }
}

if (process.argv[2] === 'hook') {
  runHook(process.argv[3]).finally(() => process.exit(0));
} else {
  main().then(() => { if (process.argv[2] !== 'start') process.exit(0); }).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
