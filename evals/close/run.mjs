// Eval skilla close-ticket w scenariuszu guzika "Close in Claude": świeża sesja bez rozmowy,
// fakty tylko ze zgłoszenia (commits) i z gita. Zbiera szkic HUMAN (krok 2) i tekst AI, który
// agent by zapisał. Klon repo (git clone --shared), bez zapisu do trackera.
//
//   node evals/close/run.mjs --variant baseline --runs 3 [--model sonnet] [--only PROJ-157]
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const variant = arg('variant', 'baseline');
const runs = Number(arg('runs', 3));
const model = arg('model', 'sonnet');
const effort = arg('effort', 'low');
const parallel = Number(arg('parallel', 4));
const only = arg('only');
const repo = path.resolve(arg('repo', process.env.TARGET_REPO ?? path.join(here, '../../../target-repo')));
const work = path.join(os.tmpdir(), 'tracker-evals');
const skillFile = path.join(here, 'variants', variant, 'SKILL.md');

const extDir = path.join(os.homedir(), '.vscode/extensions');
const ext = fs.readdirSync(extDir).filter((d) => /^anthropic\.claude-code-[\d.]+/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const claude = path.join(extDir, ext, 'resources/native-binary/claude.exe');

const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')).filter((f) => !only || only.split(',').includes(f.id));

function clone() {
  const dir = path.join(work, 'close', variant);
  if (!fs.existsSync(path.join(dir, '.git'))) execSync(`git clone -q --shared "${repo}" "${dir}"`);
  const sk = path.join(dir, '.claude/skills/close-ticket');
  fs.mkdirSync(sk, { recursive: true });
  fs.copyFileSync(skillFile, path.join(sk, 'SKILL.md'));
  return dir;
}

const evalSystem = (f) => `TRYB TESTOWY. Narzędzia MCP trackera są niedostępne.
Wynik mcp__tracker__get_issue dla ${f.id} jest taki:
<issue>
${JSON.stringify({ id: f.id, title: f.title, description: f.description, status: 'Testing', changeHuman: '', changeAi: '', commits: f.commits, worklog: [] }, null, 2)}
</issue>
Użytkownik nie odpowie na pytania. Wypisz szkic HUMAN, który pokazałbyś użytkownikowi, między liniami
<<<HUMAN i HUMAN>>>, a tekst pola AI, który zapisałbyś po akceptacji, między <<<AI i AI>>>. Nie czekaj na odpowiedź.`;

function runOne(cwd, f, i) {
  const out = path.join(here, 'results', variant, `${f.id}-${i}.json`);
  if (fs.existsSync(out)) return Promise.resolve();
  const args = ['-p', '--model', model, '--effort', effort, '--output-format', 'json',
    '--allowedTools', 'Skill,Read,Grep,Glob,Bash(git log:*),Bash(git show:*),Bash(git diff:*)',
    '--disallowedTools', 'Edit,Write,NotebookEdit,WebFetch,WebSearch',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--append-system-prompt', evalSystem(f)];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(claude, args, { cwd, env: { ...process.env, TRACKER_HOOKS: '0' } });
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (se += d));
    p.stdin.end(`Zamknij ${f.id} skillem close-ticket.`); // = DEFAULT_PROMPTS.close
    p.on('close', (code) => {
      let r = {};
      try { r = JSON.parse(so); } catch { r = { result: so }; }
      const grab = (k) => new RegExp(`<<<${k}\\s*\\n([\\s\\S]*?)\\n\\s*${k}>>>`).exec(r.result ?? '')?.[1].trim() ?? null;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ id: f.id, run: i, variant, model, code, ms: Date.now() - t0, cost: r.total_cost_usd,
        human: grab('HUMAN'), ai: grab('AI'), raw: r.result, stderr: se.slice(-2000) }, null, 2));
      console.log(`${variant} ${f.id}#${i} ${grab('HUMAN') ? 'ok' : 'BRAK'} ${Math.round((Date.now() - t0) / 1000)}s`);
      resolve();
    });
  });
}

const cwd = clone();
const jobs = fixtures.flatMap((f) => Array.from({ length: runs }, (_, i) => () => runOne(cwd, f, i)));
await Promise.all(Array.from({ length: parallel }, async () => { while (jobs.length) await jobs.shift()(); }));
