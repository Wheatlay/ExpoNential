import { useSyncExternalStore } from 'react';

/**
 * Bieżący projekt: każde zapytanie API niesie go w nagłówku X-Project, a identyfikatory
 * zadań (WEB-12) bierzemy stąd. Zmiana projektu czyści cache i przemontowuje widoki.
 */
const STORAGE = 'currentProject';
const listeners = new Set<() => void>();

function initial() {
  const m = /^\/issue\/([a-z]{2,6})-\d+/i.exec(location.pathname);
  if (m) return m[1].toUpperCase();
  try { return localStorage.getItem(STORAGE) ?? ''; } catch { return ''; }
}

let current = initial();

export function getProjectKey() {
  return current;
}

export function useProjectKey() {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => current);
}

/** Przełącza projekt; czyszczeniem cache zajmuje się subskrybent w api.ts. */
export function setProjectKey(key: string) {
  const k = key.toUpperCase();
  if (k === current) return;
  current = k;
  try { localStorage.setItem(STORAGE, k); } catch { /* prywatne okno */ }
  for (const fn of listeners) fn();
}

export function onProjectChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** "ACME-12" dla bieżącego projektu. */
export function ident(number: number, key = current) {
  return `${key}-${number}`;
}

export function issuePath(number: number, key = current) {
  return `/issue/${ident(number, key)}`;
}
