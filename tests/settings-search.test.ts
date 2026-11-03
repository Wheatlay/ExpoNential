/**
 * Wyszukiwarka ustawień (SEARCH w Settings.tsx) musi znać każde ustawienie, które widać w Ustawieniach.
 * Czyste parsowanie źródeł, bez bazy (jak tests/i18n.test.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(__dirname, '..', 'src', 'web');
const read = (f: string) => readFileSync(join(WEB, f), 'utf8');
// Sekcje Ustawień renderują się z tych plików (Settings.tsx jest sam sobie największą sekcją).
const FILES = ['Settings.tsx', 'ProjectTags.tsx', 'Notifications.tsx'];
const sources = FILES.map((f) => ({ f, src: read(f) }));
const settings = read('Settings.tsx');

// Wpisy SEARCH: blok od "const SEARCH" do zamykającego "];".
const searchBlock = settings.slice(settings.indexOf('const SEARCH: SearchEntry[] = ['));
const searchBody = searchBlock.slice(0, searchBlock.indexOf('\n];'));
const entries = [...searchBody.matchAll(/to: '([^']+)'(?:, target: '([^']+)')?/g)].map((m) => ({ to: m[1], target: m[2] ?? null }));
const targets = new Set(entries.flatMap((e) => (e.target ? [e.target] : [])));

// Identyfikatory sekcji z `groups` w Settings().
const sectionIds = [...settings.matchAll(/\{ id: '([a-z]+)', name: /g)].map((m) => m[1]);

// Literały w id={…} bez porównań (id={env === 'prod' ? 'deploy-prod' : …} daje tylko id).
const literals = (expr: string) => [...expr.replace(/===\s*'[^']*'/g, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

// id= na elemencie z klasą s-card albo s-row (JSX w tym kodzie trzyma otwarcie elementu w jednej linii).
function cardIds(src: string) {
  const ids = new Set<string>();
  for (const line of src.split('\n')) {
    if (!/className="[^"]*\bs-(card|row)\b/.test(line)) continue;
    const m = line.match(/\bid=(?:"([^"]+)"|\{([^}]*)\})/);
    if (!m) continue;
    // id={cond ? 'a' : 'b'}: bierzemy każdy literał; id={zmienna} nie ma literału (patrz row('…') niżej).
    if (m[1]) ids.add(m[1]);
    else for (const lit of literals(m[2])) ids.add(lit);
  }
  return ids;
}
// Notifications.tsx składa wiersze helperem row('id', …), a id trafia do <div className="s-row" id={id}>.
function helperRowIds(src: string) {
  return [...src.matchAll(/\brow\('([a-z-]+)'/g)].map((m) => m[1]);
}
// Wszystkie id=, także na elementach bez klasy karty (cel podświetlenia może być czymkolwiek, ale musi istnieć).
function allIds(src: string) {
  const ids = new Set<string>(helperRowIds(src));
  for (const m of src.matchAll(/\bid=(?:"([^"]+)"|\{([^}]*)\})/g)) {
    if (m[1]) ids.add(m[1]);
    else for (const lit of literals(m[2])) ids.add(lit);
  }
  return ids;
}

describe('settings search index', () => {
  it('has entries and sections', () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(sectionIds.length).toBeGreaterThan(5);
  });

  it('every section has a SEARCH entry', () => {
    const covered = new Set(entries.map((e) => e.to));
    const missing = sectionIds.filter((id) => !covered.has(id));
    expect(missing, `Sections without a SEARCH entry (add one in src/web/Settings.tsx): ${missing.join(', ')}`).toEqual([]);
  });

  it('every s-card / s-row id is a SEARCH target', () => {
    const ids = new Set<string>();
    for (const { src } of sources) { cardIds(src).forEach((i) => ids.add(i)); helperRowIds(src).forEach((i) => ids.add(i)); }
    const missing = [...ids].filter((id) => !targets.has(id));
    expect(missing, `Settings cards/rows with id but no SEARCH entry (add target in src/web/Settings.tsx SEARCH): ${missing.join(', ')}`).toEqual([]);
  });

  it('every SEARCH target exists in the sources', () => {
    const ids = new Set<string>();
    for (const { src } of sources) allIds(src).forEach((i) => ids.add(i));
    const missing = [...targets].filter((id) => !ids.has(id));
    expect(missing, `SEARCH targets with no matching id= in the settings sources: ${missing.join(', ')}`).toEqual([]);
  });
});
