import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useIssue } from './api.ts';
import { Icon } from './icons.tsx';
import { navigate, usePath } from './router.ts';
import { t } from './i18n.ts';

/**
 * Przewodnik po demo: dymek przyklejony do elementu z data-tour="…". Stan (krok, zakończenie)
 * w localStorage, współdzielony z paskiem DemoBanner ("Restart tour").
 */
type TourState = { step: number; done: boolean };
const KEY = 'demoTour';
export const TOUR_ISSUE = '/issue/ACME-12';

function load(): TourState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<TourState> | null;
    if (v && typeof v.step === 'number') return { step: Math.max(0, Math.min(STEP_COUNT - 1, v.step)), done: !!v.done };
  } catch { /* prywatne okno albo uszkodzony zapis */ }
  return { step: 0, done: false };
}

let state: TourState | null = null;
let subs: (() => void)[] = [];
const get = () => (state ??= load());
function set(next: TourState) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* prywatne okno */ }
  subs.forEach((s) => s());
}

/** Przewodnik od początku i na stronie zgłoszenia ACME-12. */
export function restartTour() {
  set({ step: 0, done: false });
  navigate(TOUR_ISSUE);
}

type Step = { page: 'issue' | 'review'; target: string; fallback?: string; text: string };
const steps = (): Step[] => [
  // Podczas analizy przycisk Analyze znika (zastępuje go "Waiting"): dymek trzyma się wtedy sekcji analizy.
  { page: 'issue', target: 'analyze', fallback: 'analysis', text: t('Meet ACME-12, a real-looking bug. Click Analyze — an AI agent reads the code and reports back. You stay in charge.') },
  { page: 'issue', target: 'analysis', text: t('The agent splits its findings into sections and asks you to decide. Pick an option — that\'s the human call.') },
  { page: 'issue', target: 'start-work', text: t('Start work hands the agent a ready prompt. In production this opens Claude Code; here, run the replay.') },
  { page: 'issue', target: 'activity', text: t('Watch the agent work: worklog, commits, deploy and change notes land on the issue in real time.') },
  { page: 'review', target: 'review', text: t('At the end of the sprint the human-readable change notes become your review — the report writes itself.') },
];
const STEP_COUNT = 5;

const findTarget = (step: Step) =>
  document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
  ?? (step.fallback ? document.querySelector<HTMLElement>(`[data-tour="${step.fallback}"]`) : null);

export function DemoTour() {
  const s = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((x) => x !== fn); }; }, get);
  const path = usePath();
  const issue = useIssue(12).data;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Okno w przyciemnieniu: prostokąt celu z marginesem; null = przyciemniamy całość.
  const [hole, setHole] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [tick, setTick] = useState(0);

  const list = steps();
  const step = list[s.step];
  const onPage = step.page === 'issue' ? path.toLowerCase() === TOUR_ISSUE.toLowerCase() : path.startsWith('/review');
  const active = !s.done && onPage;

  // Cel przesuwa się, gdy rozwija się analiza albo strona się przewija: śledzimy go co klatkę,
  // żeby dymek jechał razem z nim zamiast doskakiwać z opóźnieniem.
  useEffect(() => {
    if (!active) return;
    let last = '';
    let id = requestAnimationFrame(function loop() {
      const r = findTarget(step)?.getBoundingClientRect();
      const key = r ? `${r.left}:${r.top}:${r.bottom}:${window.innerWidth}:${window.innerHeight}` : 'none';
      if (key !== last) { last = key; setTick((n) => n + 1); }
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [active, step.target]);

  // Krok 1 prosi o kliknięcie Analyze: kiedy analiza się skończy (znika "Waiting", są dane),
  // przechodzimy dalej sami. Tylko przy tej zmianie, żeby Back z kroku 2 dało się użyć.
  const wasWaiting = useRef(false);
  useEffect(() => {
    const waiting = !!issue?.analysisRequestedAt;
    if (wasWaiting.current && !waiting && issue?.analysisData && s.step === 0 && active) set({ step: 1, done: false });
    wasWaiting.current = waiting;
  }, [issue, s.step, active]);

  const scrolledFor = useRef<string>('');
  useLayoutEffect(() => {
    document.querySelectorAll('[data-tour-on]').forEach((e) => e.removeAttribute('data-tour-on'));
    if (!active) { setPos(null); return; }
    const el = findTarget(step);
    const h = box.current?.offsetHeight ?? 180;
    const w = box.current?.offsetWidth ?? 320;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el) { setHole(null); setPos({ left: Math.max(8, (vw - w) / 2), top: Math.max(8, (vh - h) / 2) }); return; }
    el.setAttribute('data-tour-on', '');
    if (scrolledFor.current !== `${s.step}:${path}`) { scrolledFor.current = `${s.step}:${path}`; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    const r = el.getBoundingClientRect();
    const pad = 6;
    setHole({ left: Math.max(0, r.left - pad), top: Math.max(0, r.top - pad), right: Math.min(vw, r.right + pad), bottom: Math.min(vh, r.bottom + pad) });
    let left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    let top = r.bottom + 10;
    if (top + h > vh - 8) top = r.top - 10 - h;
    if (top < 8) {
      // Cel nie mieści się z dymkiem nad ani pod sobą: stawiamy dymek obok (najpierw z prawej),
      // przy górnej krawędzi celu, żeby nie zasłaniał tego, w co trzeba kliknąć.
      top = Math.min(Math.max(8, r.top), vh - h - 8);
      if (r.right + 10 + w <= vw - 8) left = r.right + 10;
      else if (r.left - 10 - w >= 8) left = r.left - 10 - w;
      else top = Math.max(8, vh - h - 8); // brak miejsca z boku: dymek przy dolnej krawędzi
    }
    setPos({ left, top });
  }, [active, step.target, s.step, path, tick]);

  useEffect(() => () => { document.querySelectorAll('[data-tour-on]').forEach((e) => e.removeAttribute('data-tour-on')); }, []);

  if (!active) return null;

  const analysed = !!issue && (!!issue.analysisData || !!issue.analysis.trim() || !!issue.analysisRequestedAt);
  const decided = !!issue?.analysisData && (issue.analysisData.decisions.length === 0 || issue.analysisData.decisions.some((d) => d.choice));
  const blocked = s.step === 0 && !analysed ? t('Click Analyze first')
    : s.step === 1 && !decided ? t('Pick an option in the analysis first') : null;
  const last = s.step === STEP_COUNT - 1;

  const next = () => {
    if (last) { set({ step: s.step, done: true }); return; }
    set({ step: s.step + 1, done: false });
    if (list[s.step + 1].page !== step.page) navigate('/review');
  };
  const back = () => {
    set({ step: s.step - 1, done: false });
    if (list[s.step - 1].page !== step.page) navigate(TOUR_ISSUE);
  };

  // Przyciemnienie z czterech pasów wokół celu (jak w przewodniku Najemnika): przerwa między nimi
  // to okno na podświetlony element. Pasy nie łapią kliknięć ani przewijania.
  const dim = hole
    ? [{ left: 0, top: 0, right: 0, height: hole.top },
       { left: 0, top: hole.bottom, right: 0, bottom: 0 },
       { left: 0, top: hole.top, width: hole.left, height: hole.bottom - hole.top },
       { left: hole.right, top: hole.top, right: 0, height: hole.bottom - hole.top }]
    : [{ inset: 0 }];

  return (<>
    {dim.map((st, i) => <div key={i} className="demo-tour-dim" style={st} />)}
    <div className="demo-tour" ref={box} role="dialog" aria-label={t('Demo tour')} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
      <div className="demo-tour-kicker">{t('Demo tour')}</div>
      <div className="demo-tour-text">{step.text}</div>
      <div className="demo-tour-foot">
        <span className="hint"><Icon.sparkle size={12} /> {s.step + 1} / {STEP_COUNT}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => set({ step: s.step, done: true })}>{t('Skip tour')}</button>
        <button className="btn sm" disabled={s.step === 0} onClick={back}>{t('Back')}</button>
        <button className="btn sm primary" disabled={!!blocked} title={blocked ?? undefined} onClick={next}>{last ? t('Finish') : t('Next')}</button>
      </div>
    </div>
  </>);
}
