import { useCallback, useRef } from 'react';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Okno dialogowe: fokus wchodzi do środka, Tab krąży w oknie, Escape wywołuje onClose (gdy podane), a po zamknięciu
 * fokus wraca na element, który otworzył okno. Użycie: `const ref = useModal(onClose); <div role="dialog" aria-modal="true" ref={ref}>`.
 * Zwraca ref-callback, więc działa też, gdy okno pojawia się dopiero po załadowaniu danych.
 */
export function useModal(onClose?: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeRef.current && !e.defaultPrevented) { closeRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', onKey);
    cleanup.current = () => {
      el.removeEventListener('keydown', onKey);
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);
}
