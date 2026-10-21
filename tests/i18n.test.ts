import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Każdy tekst z t('…') i tn(n, '…', '…') we froncie ma tłumaczenie w pl.ts (inaczej po polsku
 * zostałby angielski). Klucze czytamy z kodu, bo słownik importuje przeglądarkowy moduł.
 */
const dir = join(import.meta.dirname, '../src/web');
const str = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
const unquote = (s: string) => JSON.parse(s[0] === "'" ? `"${s.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : s) as string;

function usedKeys() {
  const keys = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && n !== 'pl.ts')) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(new RegExp(String.raw`\btn\([^,]+?,\s*${str}\s*,\s*${str}`, 'g'))) keys.add(`${unquote(m[1])}|${unquote(m[2])}`);
    for (const m of src.matchAll(new RegExp(String.raw`(?<![\w.])t\(\s*${str}`, 'g'))) keys.add(unquote(m[1]));
  }
  return keys;
}

function plKeys() {
  const src = readFileSync(join(dir, 'pl.ts'), 'utf8');
  return new Set([...src.matchAll(new RegExp(String.raw`^\s*${str}:`, 'gm'))].map((m) => unquote(m[1])));
}

describe('i18n', () => {
  it('pl.ts tłumaczy wszystkie teksty interfejsu', () => {
    const have = plKeys();
    const missing = [...usedKeys()].filter((k) => !have.has(k));
    expect(missing).toEqual([]);
  });
});
