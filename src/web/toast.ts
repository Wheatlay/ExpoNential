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
