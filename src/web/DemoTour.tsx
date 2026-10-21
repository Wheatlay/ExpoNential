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

type Step = { page: 'issue' | 'review'; target: string; text: string };
const steps = (): Step[] => [
  { page: 'issue', target: 'analyze', text: t('Meet ACME-12, a real-looking bug. Click Analyze — an AI agent reads the code and reports back. You stay in charge.') },
  { page: 'issue', target: 'analysis', text: t('The agent splits its findings into sections and asks you to decide. Pick an option — that\'s the human call.') },
  { page: 'issue', target: 'start-work', text: t('Start work hands the agent a ready prompt. In production this opens Claude Code; here, run the replay.') },
  { page: 'issue', target: 'activity', text: t('Watch the agent work: worklog, commits, deploy and change notes land on the issue in real time.') },
  { page: 'review', target: 'review', text: t('At the end of the sprint the human-readable change notes become your review — the report writes itself.') },
];
const STEP_COUNT = 5;

export function DemoTour() {
  const s = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((x) => x !== fn); }; }, get);
  const path = usePath();
  const issue = useIssue(12).data;
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [tick, setTick] = useState(0);

  const list = steps();
  const step = list[s.step];
  const onPage = step.page === 'issue' ? path.toLowerCase() === TOUR_ISSUE.toLowerCase() : path.startsWith('/review');
  const active = !s.done && onPage;

  // Elementy pojawiają się z opóźnieniem (dane, animacje): sprawdzamy ich położenie co chwilę.
  useEffect(() => {
    if (!active) return;
    const on = () => setTick((n) => n + 1);
    const id = setInterval(on, 400);
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);
    return () => { clearInterval(id); window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [active]);

  const scrolledFor = useRef<string>('');
  useLayoutEffect(() => {
    document.querySelectorAll('[data-tour-on]').forEach((e) => e.removeAttribute('data-tour-on'));
    if (!active) { setPos(null); return; }
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    const h = box.current?.offsetHeight ?? 180;
    const w = box.current?.offsetWidth ?? 320;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!el) { setPos({ left: Math.max(8, (vw - w) / 2), top: Math.max(8, (vh - h) / 2) }); return; }
    el.setAttribute('data-tour-on', '');
    if (scrolledFor.current !== `${s.step}:${path}`) { scrolledFor.current = `${s.step}:${path}`; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), Math.max(8, vw - w - 8));
    let top = r.bottom + 10;
    if (top + h > vh - 8) top = r.top - 10 - h;
    if (top < 8) top = Math.max(8, vh - h - 8); // za duży cel: dymek przy dolnej krawędzi
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

  return (
    <div className="demo-tour" ref={box} role="dialog" aria-label={t('Demo tour')} style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
      <div className="demo-tour-text">{step.text}</div>
      <div className="demo-tour-foot">
        <span className="hint"><Icon.sparkle size={12} /> {s.step + 1} / {STEP_COUNT}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => set({ step: s.step, done: true })}>{t('Skip tour')}</button>
        <button className="btn sm" disabled={s.step === 0} onClick={back}>{t('Back')}</button>
        <button className="btn sm primary" disabled={!!blocked} title={blocked ?? undefined} onClick={next}>{last ? t('Finish') : t('Next')}</button>
      </div>
    </div>
  );
}
