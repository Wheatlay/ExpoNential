// Eval skilla analyze-tracker-ticket: puszcza agenta tak jak lokalny runner (scripts/local-agent),
// ale na kopii repo sprzed poprawki i z treścią zgłoszenia w poleceniu (bez MCP: zgłoszenie
// w trackerze zawiera już rozwiązanie). Analiza idzie na wyjście, nie do trackera.
//
//   node evals/analysis/run.mjs --variant baseline --runs 3 [--model sonnet] [--only PROJ-181] [--parallel 4]
//
// Wymaga: repo projektu (--repo albo TARGET_REPO, domyślnie ../target-repo), claude.exe z rozszerzenia VS Code.
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
const work = path.resolve(arg('work', path.join(os.tmpdir(), 'tracker-evals')));
const skillFile = path.join(here, 'variants', variant, 'SKILL.md');
if (!fs.existsSync(skillFile)) throw new Error(`brak ${skillFile}`);

const extDir = path.join(os.homedir(), '.vscode/extensions');
const ext = fs.readdirSync(extDir).filter((d) => /^anthropic\.claude-code-[\d.]+/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const claude = path.join(extDir, ext, 'resources/native-binary/claude.exe');

const fixtures = JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')).filter((f) => !only || only.split(',').includes(f.id));

/** Repo w stanie sprzed poprawki, ze skillem wariantu. Bez .git: agent nie zajrzy w historię. */
function snapshot(f) {
  const dir = path.join(work, 'snaps', variant, f.id);
  if (!fs.existsSync(path.join(dir, '.done'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const fwd = (s) => s.replaceAll(path.sep, '/');
    execSync(`git -C "${fwd(repo)}" archive ${f.base} | tar -x -C "${fwd(dir)}"`, { stdio: 'inherit', shell: 'bash' });
    fs.writeFileSync(path.join(dir, '.done'), f.base);
  }
  const sk = path.join(dir, '.claude/skills/analyze-tracker-ticket');
  fs.rmSync(sk, { recursive: true, force: true });
  fs.mkdirSync(sk, { recursive: true });
  fs.copyFileSync(skillFile, path.join(sk, 'SKILL.md'));
  return dir;
}

const issueText = (f) => [
  `id: ${f.id}`, `title: ${f.title}`, 'status: Todo', `description: ${f.description || '(pusty)'}`,
  'analysis: (brak)', 'comments: (brak)',
].join('\n');

// Uwaga: sformułowania typu "wypisz dokładnie tekst" w system prompcie wyzwalały filtr API
// (reasoning_extraction), więc dane idą w zwykłym poleceniu, a wynik w tagu.
const structured = fs.readFileSync(skillFile, 'utf8').includes('"sections"');
const evalSystem = () => structured
  ? 'Serwer MCP trackera nie jest podłączony w tej sesji. Dane zgłoszenia są w poleceniu użytkownika, a argumenty wywołania set_analysis oddajesz w odpowiedzi jako JSON w tagu <set_analysis>.'
  : 'Serwer MCP trackera nie jest podłączony w tej sesji. Dane zgłoszenia są w poleceniu użytkownika, a gotową analizę oddajesz w odpowiedzi w tagu <analysis>, zamiast wywołania set_analysis.';
// Fill with your project's labels (comma-separated).
const LABELS = '';
const evalPrompt = (f) => `Użyj skilla analyze-tracker-ticket dla ${f.id}.

Tracker jest dziś offline, więc tu jest to, co zwróciłyby get_issue, list_comments i list_issue_labels:
<issue>
${issueText(f)}
</issue>
<labels>${LABELS}</labels>`;

function runOne(f, i) {
  const out = path.join(here, 'results', variant, `${f.id}-${i}.json`);
  if (fs.existsSync(out)) return Promise.resolve();
  const cwd = snapshot(f);
  const args = ['-p', '--model', model, '--effort', effort, '--output-format', 'json',
    '--allowedTools', 'Skill', '--disallowedTools', 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--append-system-prompt', evalSystem()];
  const prompt = evalPrompt(f); // pierwsze zdanie = DEFAULT_PROMPTS.analyze
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(claude, args, { cwd, env: { ...process.env, TRACKER_HOOKS: '0' } });
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d));
    p.stderr.on('data', (d) => (se += d));
    p.stdin.end(prompt);
    p.on('close', (code) => {
      let r = {};
      try { r = JSON.parse(so); } catch { r = { result: so, parseError: true }; }
      const m = structured
        ? /<set_analysis>\s*(?:```json)?\s*([\s\S]*?)\s*(?:```)?\s*<\/set_analysis>/.exec(r.result ?? '')
        : /<analysis>\s*([\s\S]*?)\s*<\/analysis>/.exec(r.result ?? '');
      if (!m) { console.log(`${variant} ${f.id}#${i} BRAK ANALIZY: ${(r.result ?? '').slice(0, 120).replace(/\s+/g, ' ')}`); return resolve(); }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({
        id: f.id, run: i, variant, model, code, ms: Date.now() - t0, cost: r.total_cost_usd, turns: r.num_turns,
        analysis: m ? m[1].trim() : null, raw: r.result, stderr: se.slice(-2000),
      }, null, 2));
      console.log(`${variant} ${f.id}#${i} ${m ? 'ok' : 'BRAK ANALIZY'} ${Math.round((Date.now() - t0) / 1000)}s $${r.total_cost_usd?.toFixed(2)}`);
      resolve();
    });
  });
}

const jobs = fixtures.flatMap((f) => Array.from({ length: runs }, (_, i) => () => runOne(f, i)));
for (const f of fixtures) snapshot(f); // przed równoległością: tar do tego samego katalogu
await Promise.all(Array.from({ length: parallel }, async () => { while (jobs.length) await jobs.shift()(); }));
