/** Parsowanie wpisanej godziny (24h) i daty (dd.mm.rrrr); bez Reacta, żeby dało się testować. */

export const pad = (n: number) => String(n).padStart(2, '0');

/** "9" -> 09:00, "930" -> 09:30, "9:5" -> 09:05, "21.15" -> 21:15; null gdy to nie godzina. */
export function parseTime(raw: string): string | null {
  const t = raw.trim().replace(/[.,\s]/g, ':');
  const m = /^(\d{1,2})(?::?(\d{1,2}))?$/.exec(t.includes(':') ? t : t.length > 2 ? `${t.slice(0, -2)}:${t.slice(-2)}` : t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? `${pad(h)}:${pad(min)}` : null;
}

/** "21.10.2026", "21.10", "21/10/26" -> 2026-10-21; null gdy to nie data. */
export function parseDate(raw: string, fallbackYear = new Date().getFullYear()): string | null {
  const m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(raw.trim());
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : fallbackYear;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  if (d.getDate() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
