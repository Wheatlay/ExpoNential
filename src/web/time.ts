const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
import { locale, t } from './i18n.ts';

export function timeAgo(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
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
