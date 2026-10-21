import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

/** Kto z innych osób przeciąga teraz które zadanie i nad którą komórką boardu jest. */
export type Presence = { userId: number; name: string; number: number; statusId?: number; rowKey?: string; fx?: number; fy?: number; at: number };

let state: Presence[] = [];
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function receivePresence(e: { userId: number; name: string; number: number; statusId?: number; rowKey?: string; fx?: number; fy?: number; end?: boolean }) {
  state = state.filter((p) => p.userId !== e.userId);
  if (!e.end) state = [...state, { userId: e.userId, name: e.name, number: e.number, statusId: e.statusId, rowKey: e.rowKey, fx: e.fx, fy: e.fy, at: Date.now() }];
  emit();
}

// Zgubione "end" (zamknięta karta, utrata sieci) nie może zostawić ducha na zawsze.
setInterval(() => {
  const fresh = state.filter((p) => Date.now() - p.at < 4000);
  if (fresh.length !== state.length) { state = fresh; emit(); }
}, 1000);

export function usePresence() {
  return useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => state);
}

/** Wysyłanie własnej pozycji przy przeciąganiu: najwyżej co 150 ms, koniec zawsze. */
let last = 0;
let lastKey = '';
export function sendPresence(p: { number: number; statusId?: number; rowKey?: string; fx?: number; fy?: number; end?: boolean }) {
  const key = `${p.number}:${p.statusId}:${p.rowKey}:${p.fx}:${p.fy}:${p.end}`;
  const now = Date.now();
  if (!p.end && (key === lastKey && now - last < 1500 || now - last < 90)) return;
  last = now;
  lastKey = key;
  void api('/api/presence', { method: 'POST', body: p }).catch(() => {});
}
