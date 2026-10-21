import { LOCALE } from './i18n.ts';

/** Strefa instancji (APP_TIMEZONE, domyślnie UTC): w niej liczymy godziny spotkań i domyślne sprint review. */
export const TZ = process.env.APP_TIMEZONE || 'UTC';

try {
  new Intl.DateTimeFormat('en', { timeZone: TZ });
} catch {
  throw new Error(`Invalid APP_TIMEZONE "${TZ}": use an IANA time zone name such as "UTC" or "Europe/Warsaw"`);
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function parts(at: Date) {
  const o: Record<string, number> = {};
  for (const p of partsFmt.formatToParts(at)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Przesunięcie strefy instancji względem UTC w danej chwili (minuty). */
function offsetMinutes(at: Date) {
  const p = parts(at);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()) / 60000);
}

/** "2026-10-21" + "15:00" w strefie instancji -> chwila w UTC. */
export function zonedToUtc(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = new Date(guess - offsetMinutes(new Date(guess)) * 60000);
  // Druga iteracja trafia poprawnie także w dniu zmiany czasu.
  at = new Date(guess - offsetMinutes(at) * 60000);
  return at;
}

/** Data kalendarzowa w strefie instancji ("2026-10-21"). */
export function zonedDate(at: Date) {
  const p = parts(at);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** pl: "wtorek 21.10, 16:00"; en: "Tuesday 21 Oct, 16:00" (do wiadomości na Discordzie). */
export function formatDateTime(at: Date, locale: 'en' | 'pl' = LOCALE) {
  const pl = locale === 'pl';
  const o: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat(locale, {
    timeZone: TZ, weekday: 'long', day: '2-digit', month: pl ? '2-digit' : 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) if (p.type !== 'literal') o[p.type] = p.value;
  const date = pl ? `${o.day}.${o.month}` : `${o.day} ${o.month}`;
  return `${o.weekday} ${date}, ${o.hour}:${o.minute}`;
}

/** "16:00" (do powiadomień w przeglądarce). */
export function formatTime(at: Date) {
  const p = parts(at);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Sobota i niedziela cofają się na piątek ("2026-11-01" niedziela -> "2026-10-30"). */
export function lastWorkday(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  const back = at.getUTCDay() === 0 ? 2 : at.getUTCDay() === 6 ? 1 : 0;
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
}
