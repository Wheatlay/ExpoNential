// Ocena wyników evals/close/run.mjs: reguły HUMAN sprawdzane mechanicznie, hashe w polu AI
// sprawdzane w gicie, sędzia LLM porównuje szkic HUMAN z wersją zatwierdzoną przez człowieka.
//   node evals/close/score.mjs baseline v1 [--judge]
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const variants = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const judge = process.argv.includes('--judge');
const repo = process.env.TARGET_REPO ?? path.join(here, '../../../target-repo');
const fixtures = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')).map((f) => [f.id, f]));

const extDir = path.join(os.homedir(), '.vscode/extensions');
const ext = fs.readdirSync(extDir).filter((d) => /^anthropic\.claude-code-[\d.]+/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const claude = path.join(extDir, ext, 'resources/native-binary/claude.exe');
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** Naruszenia reguł HUMAN ze skilla, po jednej etykiecie na złamaną regułę w linii. */
function humanViolations(h) {
  const lines = h.split('\n').map((l) => l.trim()).filter(Boolean);
  const v = [];
  if (lines.length > 6) v.push(`linii:${lines.length}`);
  for (const l of lines) {
    if (/^[-*•\d]+[.)]?\s/.test(l)) v.push('punktor');
    if (/—/.test(l)) v.push('em-dash');
    if (/\b[a-z]+[A-Z]\w*|`/.test(l) || /\.(php|ts|tsx|py|html|yaml)\b|\bendpoint|\bkolumn\w* w bazie|\bmigracj|\bAPI\b|\bcommit/i.test(l)) v.push('identyfikator');
    if (/przez któr|dzięki czemu|więc |aby |żeby |ponieważ|bo /i.test(l)) v.push('narracja');
    if ((l.match(/[.!?](\s|$)/g) || []).length > 1) v.push('wiele-zdań');
    if (l.split(/\s+/).length > 22) v.push('długie');
  }
  return { lines: lines.length, v };
}

function badHashes(ai) {
  const hs = [...new Set((ai.match(/(?<![-\w])[0-9a-f]{7,40}(?![-\w])/g) || []).filter((h) => /\d/.test(h) && /[a-f]/.test(h)))];
  return { hashes: hs.length, bad: hs.filter((h) => { try { // bez ^{commit}: execSync na Windows idzie przez cmd.exe, gdzie ^ to znak ucieczki
      return execSync(`git -C "${repo}" cat-file -t ${h}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() !== 'commit'; } catch { return true; } }) };
}

const JUDGE = (f, h) => `Porównujesz szkic notatki "co się zmieniło" (dla ludzi, nie programistów) z wersją, którą zatwierdził człowiek.
Zgłoszenie: ${f.id} "${f.title}"
Wersja zatwierdzona (wzorzec):
<ref>
${f.humanReference}
</ref>
Szkic:
<draft>
${h}
</draft>
Oceń 1-5:
- pokrycie: czy szkic mówi o tych samych zmianach co wzorzec (nic ważnego nie brakuje)
- poziom: czy jest równie wysokopoziomowy i zrozumiały dla nie-programisty (5 = jak wzorzec, 1 = techniczny żargon)
- zwiezlosc: 5 = równie krótki i bez zbędnych linii jak wzorzec
- poprawki: ile linii człowiek musiałby przepisać lub usunąć (liczba)
Odpowiedz WYŁĄCZNIE JSON-em: {"pokrycie":n,"poziom":n,"zwiezlosc":n,"poprawki":n}`;

function judgeOne(f, h) {
  const p = spawnSync(claude, ['-p', '--model', 'sonnet', '--output-format', 'json', '--tools', '',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { input: JUDGE(f, h), encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 1 << 24 });
  try { const r = JSON.parse(p.stdout).result; return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1)); } catch { return null; }
}

const rows = [];
for (const v of variants) {
  const dir = path.join(here, 'results', v);
  const scorePath = path.join(dir, 'score.json');
  const prev = fs.existsSync(scorePath) ? JSON.parse(fs.readFileSync(scorePath, 'utf8')) : {};
  const all = [];
  for (const file of fs.readdirSync(dir).filter((x) => /^[A-Z]+-\d+-\d+\.json$/.test(x)).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const hv = r.human ? humanViolations(r.human) : null;
    const hb = r.ai ? badHashes(r.ai) : null;
    let j = prev[file]?.judge ?? null;
    if (judge && r.human && !j) { j = judgeOne(fixtures[r.id], r.human); process.stderr.write('.'); }
    prev[file] = { id: r.id, ok: !!r.human && !!r.ai, cost: r.cost, hLines: hv?.lines, violations: hv?.v, aiWords: r.ai?.split(/\s+/).length,
      hashes: hb?.hashes, badHashes: hb?.bad, judge: j };
    all.push(prev[file]);
  }
  fs.writeFileSync(scorePath, JSON.stringify(prev, null, 2));
  const counts = {};
  for (const x of all) for (const k of x.violations ?? []) counts[k] = (counts[k] ?? 0) + 1;
  const jc = (k) => median(all.map((x) => x.judge?.[k]));
  rows.push({ variant: v, n: all.length, ok: all.filter((x) => x.ok).length, hLines: median(all.map((x) => x.hLines)),
    violPerRun: (all.reduce((s, x) => s + (x.violations?.length ?? 0), 0) / all.length).toFixed(1),
    badHashes: all.reduce((s, x) => s + (x.badHashes?.length ?? 0), 0), aiWords: median(all.map((x) => x.aiWords)),
    pokrycie: jc('pokrycie'), poziom: jc('poziom'), zwiezl: jc('zwiezlosc'), poprawki: jc('poprawki'),
    costUsd: all.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2) });
  console.log(v, JSON.stringify(counts));
}
console.table(rows);
