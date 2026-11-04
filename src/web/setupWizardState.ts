import { useSyncExternalStore } from 'react';
import { api, queryClient, type Me } from './api.ts';

/**
 * Podłączenie AI: jedno okno, jeden reaktywny ekran (karta SetupWizard.md). Pytanie o cel ustawia zakres, drabina kroków
 * jest odhaczana na żywo z /api/me (aiStatus). Nie otwiera się samo. Wejścia: Ustawienia, kropka przy Settings
 * i podpowiedź (openAiHint) przy funkcji AI bez podłączenia.
 */
export type Goal = 1 | 2 | 3;
export type Snap = { open: boolean; goal: Goal | null; step: Goal | null };

export let snap: Snap = { open: false, goal: null, step: null };
let subs: (() => void)[] = [];
export const set = (s: Snap) => { snap = s; subs.forEach((f) => f()); };
export const useSnap = () => useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => snap);

/** Najwyższy zrobiony poziom; gdy nic nie ma: 2. */
export function defaultGoal(s?: Me['aiStatus']): Goal {
  if (s?.client && s.workTrace && s.agent) return 3;
  if (s?.client && s.workTrace) return 2;
  if (s?.client) return 1;
  return 2;
}

/** step: krok rozwinięty od razu (np. 3 dla komputera ze starym instalatorem). */
export function openSetupWizard(goal?: Goal, step?: Goal) {
  closeAiHint();
  set({ open: true, goal: goal ?? null, step: step ?? null });
  // Świeży stan przed wyborem domyślnego celu (me jest cache'owane bez końca).
  void queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), staleTime: 0 }).then((me) => {
    if (snap.open && snap.goal == null) set({ ...snap, goal: defaultGoal(me.aiStatus) });
  }, () => undefined);
}
export function closeSetupWizard() { set({ open: false, goal: null, step: null }); }

/* ---------- podpowiedź przy funkcji AI bez podłączenia ---------- */
export type Hint = { rect: DOMRect; kind: 'analyze' | 'start'; goal: Goal; anyway?: () => void; reason?: string } | null;
let hint: Hint = null;
let hintSubs: (() => void)[] = [];
const setHint = (h: Hint) => { hint = h; hintSubs.forEach((f) => f()); };
export function closeAiHint() { if (hint) setHint(null); }
/** Popover pod przyciskiem Analyze / Deep / Start work, gdy AI nie jest podłączone. */
export function openAiHint(anchor: HTMLElement, kind: 'analyze' | 'start', goal: Goal = 3, anyway?: () => void, reason?: string) {
  setHint({ rect: anchor.getBoundingClientRect(), kind, goal, anyway, reason });
}
export const useHint = () => useSyncExternalStore((fn) => { hintSubs.push(fn); return () => { hintSubs = hintSubs.filter((s) => s !== fn); }; }, () => hint);

/** Okno albo podpowiedź jest otwarte: dopiero wtedy ładujemy ciężki kod kreatora (SetupWizard.tsx). */
export const useWizardActive = () => { const open = useSnap().open; const hint = useHint(); return open || !!hint; };
