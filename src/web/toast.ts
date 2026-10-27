import { t } from './i18n.ts';

type Toast = { id: number; text: string; kind: 'ok' | 'err' | 'warn' };
let listeners: ((t: Toast | null) => void)[] = [];
let seq = 0;

export function toast(text: string, kind: 'ok' | 'err' | 'warn' = 'ok') {
  const t = { id: ++seq, text, kind };
  listeners.forEach((l) => l(t));
  setTimeout(() => listeners.forEach((l) => l(null)), kind === 'ok' ? 2500 : 5000);
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
