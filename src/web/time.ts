const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
import { useEffect, useState } from 'react';
import { locale, t } from './i18n.ts';

export function timeAgo(iso: string) {
  // Zawsze przeszłość: zegar telefonu spóźniony względem serwera dawał "za 1 minutę" przy właśnie zleconej analizie.
  const s = Math.min(0, (new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return t('just now');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  if (abs < 86400 * 60) return rtf.format(Math.round(s / (86400 * 7)), 'week');
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(iso: string) {
  return new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** Jak CLAIM_TTL_MIN na serwerze: po tylu minutach bez sygnału od agenta analiza liczy się jako utknięta. */
export const CLAIM_TTL_MIN = 30;

/** Data dla człowieka zawsze dd.mm.rrrr, niezależnie od języka przeglądarki. */
export function fmtDate(d: string | number | Date) {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
}
