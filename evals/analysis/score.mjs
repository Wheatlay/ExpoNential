// Ocena wyników run.mjs. Metryki obiektywne + sędzia LLM, który zna prawdziwą poprawkę.
//   node evals/analysis/score.mjs baseline v1 [--judge] [--model sonnet]
// Wynik: tabela median na wariant i evals/analysis/results/<wariant>/score.json.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const variants = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'sonnet' && a !== 'opus' && a !== 'haiku');
const judge = process.argv.includes('--judge');
const judgeModel = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'sonnet';
const fixtures = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(here, 'fixtures.json'), 'utf8')).map((f) => [f.id, f]));
const work = path.join(os.tmpdir(), 'tracker-evals');

const extDir = path.join(os.homedir(), '.vscode/extensions');
const ext = fs.readdirSync(extDir).filter((d) => /^anthropic\.claude-code-[\d.]+/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
const claude = path.join(extDir, ext, 'resources/native-binary/claude.exe');

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };

/** Ścieżki plików wspomniane w tekście (z opcjonalnym :linia). */
function refs(text) {
  const re = /([\w.@-]+(?:\/[\w.@-]+)*\.(?:php|ts|tsx|html|py|mjs|js|yaml|yml|json|scss|css|sql))(?::(\d+))?/g;
  return [...text.matchAll(re)].map((m) => ({ path: m[1], line: m[2] ? Number(m[2]) : null }));
}

/** Plik w snapshocie: pełna ścieżka albo jednoznaczny sufiks. */
function resolveIn(snap, p, index) {
  if (fs.existsSync(path.join(snap, p))) return p;
  const hits = index.filter((f) => f.endsWith('/' + p) || f === p);
  return hits.length ? hits[0] : null;
}
const indexCache = {};
function fileIndex(snap) {
  if (indexCache[snap]) return indexCache[snap];
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'vendor', '.git', '.angular', 'dist'].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      e.isDirectory() ? walk(path.join(d, e.name), r) : out.push(r);
    }
  };
  walk(snap, '');
  return (indexCache[snap] = out);
}

function metrics(r, variant) {
  const f = fixtures[r.id];
  const a = r.analysis ?? '';
  const snap = path.join(work, 'snaps', variant, r.id);
  const idx = fileIndex(snap);
  const rs = refs(a);
  const resolved = rs.map((x) => ({ ...x, file: resolveIn(snap, x.path, idx) }));
  const files = [...new Set(resolved.map((x) => x.file).filter(Boolean))];
  const lineOk = resolved.filter((x) => x.file && x.line).filter((x) => {
    const n = fs.readFileSync(path.join(snap, x.file), 'utf8').split('\n').length;
    return x.line <= n;
  }).length;
  const truth = f.truthFiles;
  const hit = truth.filter((t) => files.includes(t));
  return {
    words: a.split(/\s+/).filter(Boolean).length,
    sections: (a.match(/^##\s/gm) || []).length,
    refs: rs.length,
    badRefs: resolved.filter((x) => !x.file).length,
    linesInRange: rs.filter((x) => x.line).length ? lineOk / rs.filter((x) => x.line).length : null,
    recall: hit.length / truth.length,
    precision: files.length ? files.filter((x) => truth.includes(x)).length / files.length : 0,
    emDash: (a.match(/—/g) || []).length,
  };
}

const JUDGE = (f, a) => `Oceniasz analizę zgłoszenia, którą napisał agent PRZED naprawą. Znasz prawdziwą poprawkę.
Zgłoszenie: ${f.id} "${f.title}"
Opis: ${f.description || '(pusty)'}

Prawdziwa poprawka (tematy commitów):
${f.fixCommits.map((c) => '- ' + c).join('\n')}
Zmienione pliki: ${f.truthFiles.join(', ')}

Analiza do oceny:
<analysis>
${a}
</analysis>

Odbiorca analizy to programista, który za chwilę bierze zadanie. Oceń w skali 1-5:
- trafnosc: czy wskazana przyczyna/zakres i proponowane rozwiązanie zgadzają się z prawdziwą poprawką
- konkretnosc: czy da się od razu działać (konkretne miejsca i zmiany), a nie ogólniki
- zwiezlosc: stosunek informacji do długości; 5 = nic do wycięcia, 1 = połowa to wata/powtórzenia
- watа: wypisz max 3 krótkie cytaty fragmentów, które są zbędne
Odpowiedz WYŁĄCZNIE JSON-em: {"trafnosc":n,"konkretnosc":n,"zwiezlosc":n,"wata":["..."]}`;

function judgeOne(f, a) {
  const p = spawnSync(claude, ['-p', '--model', judgeModel, '--output-format', 'json', '--tools', '',
    '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { input: JUDGE(f, a), encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 1 << 24 });
  try {
    const r = JSON.parse(p.stdout).result;
    return JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
  } catch { return null; }
}

const rows = [];
for (const v of variants) {
  const dir = path.join(here, 'results', v);
  const scorePath = path.join(dir, 'score.json');
  const prev = fs.existsSync(scorePath) ? JSON.parse(fs.readFileSync(scorePath, 'utf8')) : {};
  const all = [];
  for (const file of fs.readdirSync(dir).filter((x) => /^[A-Z]+-\d+-\d+\.json$/.test(x)).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const m = r.analysis ? metrics(r, v) : null;
    let j = prev[file]?.judge ?? null;
    if (judge && r.analysis && !j) { j = judgeOne(fixtures[r.id], r.analysis); process.stderr.write('.'); }
    prev[file] = { id: r.id, ok: !!r.analysis, cost: r.cost, sec: Math.round(r.ms / 1000), ...m, judge: j };
    all.push(prev[file]);
  }
  fs.writeFileSync(scorePath, JSON.stringify(prev, null, 2));
  const col = (k) => median(all.map((x) => x[k]));
  const jcol = (k) => median(all.map((x) => x.judge?.[k]));
  rows.push({
    variant: v, n: all.length, ok: all.filter((x) => x.ok).length, words: col('words'), sections: col('sections'),
    refs: col('refs'), badRefs: all.reduce((s, x) => s + (x.badRefs ?? 0), 0), recall: col('recall')?.toFixed(2),
    precision: col('precision')?.toFixed(2), trafnosc: jcol('trafnosc'), konkret: jcol('konkretnosc'), zwiezl: jcol('zwiezlosc'),
    costUsd: all.reduce((s, x) => s + (x.cost ?? 0), 0).toFixed(2), sec: col('sec'),
  });
  // Per zgłoszenie: mediana słów i recall, żeby widać było, gdzie wariant pomaga.
  const byId = {};
  for (const x of all) (byId[x.id] ??= []).push(x);
  console.log(`\n${v}: ` + Object.entries(byId).map(([id, xs]) => `${id} w=${median(xs.map((x) => x.words))} r=${median(xs.map((x) => x.recall))?.toFixed(2)} t=${median(xs.map((x) => x.judge?.trafnosc))}`).join(' | '));
}
console.table(rows);
