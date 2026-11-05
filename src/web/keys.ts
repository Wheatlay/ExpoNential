import { useLayoutEffect, useRef } from 'react';
import { t } from './i18n.ts';

/** Pole rośnie z treścią zamiast przewijać się w środku; po wyczyszczeniu (wysłanie) wraca do min-height z CSS. */
export function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

const ENTER_KEY = 'expo.enterSends';
/** Ustawienie (Wygląd): true = Enter wysyła/zapisuje, false = Enter to nowa linia, Ctrl/Cmd+Enter wysyła. Per przeglądarka. */
export function enterSends(): boolean { try { return localStorage.getItem(ENTER_KEY) !== '0'; } catch { return true; } }
export function setEnterSends(v: boolean) { try { localStorage.setItem(ENTER_KEY, v ? '1' : '0'); } catch { /* prywatne okno */ } }

/** Podpowiedź klawiszy zgodna z ustawieniem; jedno miejsce dla wszystkich pól. */
export function keyHint(kind: 'send' | 'save' | 'ask' | 'newline'): string {
  const e = enterSends();
  switch (kind) {
    case 'send': return e ? t('Enter to send, Alt+Enter new line') : t('Ctrl+Enter to send');
    case 'save': return e ? t('Enter saves · Alt+Enter new line') : t('Ctrl+Enter saves');
    case 'ask': return e ? t('Enter to ask, Alt+Enter new line') : t('Ctrl+Enter to ask');
    default: return e ? t('Alt+Enter new line') : '';
  }
}

/**
 * Enter zatwierdza, Alt+Enter (albo Shift+Enter) wstawia nową linię.
 * Alt+Enter sam z siebie nie dodaje znaku w textarea, więc wstawiamy go ręcznie.
 */
export function enterToSubmit(e: React.KeyboardEvent<HTMLTextAreaElement>, submit: () => void, setValue?: (v: string) => void) {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
  if (!enterSends()) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); submit(); }
    return; // Enter = natywnie nowa linia
  }
  if (e.altKey) {
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const next = value.slice(0, a) + '\n' + value.slice(b);
    if (setValue) setValue(next);
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 1; });
    return;
  }
  if (e.shiftKey) return; // natywnie nowa linia
  e.preventDefault();
  submit();
}
