/**
 * Wspólny parser wzmianek (serwer i web). Login to znaki [A-Za-z0-9._%+-], opcjonalnie z @domena.tld
 * (loginy z Google to adresy e-mail). Wzmianka musi stać na początku albo po znaku niebędącym słowem.
 */
export const SKIP = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+)/;
const USER_SRC = String.raw`(?<![\w@/.])@([A-Za-z0-9][A-Za-z0-9._%+-]*(?:@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)?)`;
const TAG_SRC = String.raw`(?<![\w&/#])#([A-Za-z0-9][A-Za-z0-9_-]*)`;
export const userRe = () => new RegExp(USER_SRC, 'g');
export const tagRe = () => new RegExp(TAG_SRC, 'g');
export const USER_TRAILING = /[.,_%+-]/;
export const TAG_TRAILING = /[_-]/;
/** Fragment przed kursorem, który otwiera podpowiedzi (@ lub #, potem znaki loginu/tagu). */
export const MENTION_TRIGGER = /(^|\s)([@#])([\w.%+@-]*)$/;

/** Dopasowanie bez rozróżniania wielkości liter; końcowa interpunkcja ("@rafal.") nie należy do nazwy. Zwraca wartość i długość użytej nazwy. */
export function findByName<T>(map: Map<string, T>, raw: string, trailing: RegExp): [T, number] | null {
  for (let n = raw; n; n = n.slice(0, -1)) {
    const hit = map.get(n.toLowerCase());
    if (hit) return [hit, n.length];
    if (!trailing.test(n.slice(-1))) break;
  }
  return null;
}
