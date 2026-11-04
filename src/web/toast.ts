import { t } from './i18n.ts';

export type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'warn'; sticky?: boolean };
let listeners: ((t: Toast | null) => void)[] = [];
let seq = 0;
let shown = 0;

/** Zwraca id; toast z `sticky` zostaje, aż zawoła się dismissToast(id) (albo pokaże się inny toast). */
export function toast(text: string, kind: 'ok' | 'err' | 'warn' = 'ok', opts: { sticky?: boolean } = {}): number {
  const t: Toast = { id: ++seq, text, kind, sticky: opts.sticky };
  shown = t.id;
  listeners.forEach((l) => l(t));
  if (!opts.sticky) setTimeout(() => dismissToast(t.id), kind === 'ok' ? 2500 : 5000);
  return t.id;
}

/** Zamyka toast o tym id, o ile jest jeszcze na ekranie (nie zasłania nowszego). */
export function dismissToast(id: number) {
  if (shown !== id) return;
  shown = 0;
  listeners.forEach((l) => l(null));
}

export function onToast(fn: (t: Toast | null) => void) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/** Kopiowanie do schowka z widoczną porażką (brak uprawnień, http, odmowa przeglądarki). */
export function copyText(text: string, okMsg: string) {
  void navigator.clipboard.writeText(text).then(() => toast(okMsg), () => toast(
    text.length > 200 ? t('Could not copy to the clipboard.') : t('Could not copy to the clipboard. Copy it by hand: {text}', { text }), 'err'));
}
