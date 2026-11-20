import { SKIP } from './mentions.ts';

/**
 * Wzorzec odwołania do zgłoszenia (pille w tekście i wzmianki w panelu): tylko klucze istniejących projektów
 * (inaczej UTF-8 czy ISO-9001 stałyby się linkami), dowolna wielkość liter, myślnik, spacja albo nic przed
 * numerem: CHUB-172, chub 172, chub172.
 */
export function issueRefPattern(keys: Iterable<string>) {
  const list = [...new Set(keys)];
  if (!list.length) return null;
  return new RegExp(`(?<![\\w/-])(${list.join('|')})[- ]?(\\d+)\\b`, 'gi');
}

/** Identyfikatory rozpoznane w tekście (poza kodem i linkami), bez powtórzeń, w kolejności wystąpienia. */
export function findIssueRefs(text: string, re: RegExp | null) {
  if (!re) return [];
  const ids = text.split(SKIP).filter((_, i) => i % 2 === 0)
    .flatMap((part) => [...part.matchAll(re)].map((m) => `${m[1].toUpperCase()}-${m[2]}`));
  return [...new Set(ids)];
}
