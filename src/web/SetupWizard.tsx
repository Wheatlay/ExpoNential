import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryClient, useMe, useProjects, type Me } from './api.ts';
import { Icon } from './icons.tsx';
import { copyText, toast } from './toast.ts';
import { timeAgo } from './time.ts';
import { t } from './i18n.ts';

/**
 * Podłączenie AI: jedno okno, jeden reaktywny ekran (karta SetupWizard.md). Pytanie o cel ustawia zakres, drabina kroków
 * jest odhaczana na żywo z /api/me (aiStatus). Nie otwiera się samo. Wejścia: Ustawienia, kropka przy Settings
 * i podpowiedź (openAiHint) przy funkcji AI bez podłączenia.
 */
type Goal = 1 | 2 | 3;
type Snap = { open: boolean; goal: Goal | null };

let snap: Snap = { open: false, goal: null };
let subs: (() => void)[] = [];
const set = (s: Snap) => { snap = s; subs.forEach((f) => f()); };
const useSnap = () => useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => snap);

/** Najwyższy zrobiony poziom; gdy nic nie ma: 2. */
function defaultGoal(s?: Me['aiStatus']): Goal {
  if (s?.client && s.workTrace && s.agent) return 3;
  if (s?.client && s.workTrace) return 2;
  if (s?.client) return 1;
  return 2;
}

export function openSetupWizard(goal?: Goal) {
  closeAiHint();
  set({ open: true, goal: goal ?? null });
  // Świeży stan przed wyborem domyślnego celu (me jest cache'owane bez końca).
  void queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), staleTime: 0 }).then((me) => {
    if (snap.open && snap.goal == null) set({ open: true, goal: defaultGoal(me.aiStatus) });
  }, () => undefined);
}
function closeSetupWizard() { set({ open: false, goal: null }); }

/* ---------- podpowiedź przy funkcji AI bez podłączenia ---------- */
type Hint = { rect: DOMRect; kind: 'analyze' | 'start'; goal: Goal } | null;
let hint: Hint = null;
let hintSubs: (() => void)[] = [];
const setHint = (h: Hint) => { hint = h; hintSubs.forEach((f) => f()); };
function closeAiHint() { if (hint) setHint(null); }
/** Popover pod przyciskiem Analyze / Deep / Start work, gdy AI nie jest podłączone. */
export function openAiHint(anchor: HTMLElement, kind: 'analyze' | 'start', goal: Goal = 3) {
  setHint({ rect: anchor.getBoundingClientRect(), kind, goal });
}

function AiHint() {
  const h = useSyncExternalStore((fn) => { hintSubs.push(fn); return () => { hintSubs = hintSubs.filter((s) => s !== fn); }; }, () => hint);
  useEffect(() => {
    if (!h) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAiHint(); };
    const down = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.ai-hint')) closeAiHint(); };
    window.addEventListener('keydown', key);
    window.addEventListener('mousedown', down, true);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('mousedown', down, true); };
  }, [h]);
  if (!h) return null;
  const left = Math.max(8, Math.min(h.rect.left, window.innerWidth - 328));
  return (
    <div className="ai-hint" role="dialog" aria-label={t('Connect AI')} style={{ left, top: h.rect.bottom + 6 }}>
      <div className="ai-hint-title">{h.kind === 'analyze' ? t('Analysis is done by AI on your computer') : t('Work starts in your AI client')}</div>
      <div className="hint">{h.kind === 'analyze'
        ? t('Connect AI once and Analyze runs on your computer. Until then the request has nothing to pick it up.')
        : t('Connect AI once so your client can read this issue and report back.')}</div>
      <div className="ai-hint-actions">
        <button className="btn primary sm" autoFocus onClick={() => openSetupWizard(h.goal)}>{t('Connect AI')}</button>
        <button className="btn sm" onClick={closeAiHint}>{t('Not now')}</button>
      </div>
    </div>
  );
}

/* ---------- polecenia ---------- */
type ClientName = 'Claude Code' | 'Codex';
type Where = 'VS Code' | 'Cursor' | 'Terminal';
type AgentRepo = { project: string; path: string; source?: string; status?: string; error?: string | null };
type AgentRow = { id: string; name: string; computerName: string; label: string; online: boolean; outdated?: boolean; lastSeenAt: string | null; repos?: AgentRepo[] };

const AGENT_EXE = 'https://github.com/Wheatlay/ExpoNential/releases/latest/download/exponential-agent.exe';
const BASE = () => location.origin;
const claudeCmd = () => `claude mcp add --transport http --scope user tracker ${BASE()}/mcp`;
const codexCmds = () => [`codex mcp add tracker --url ${BASE()}/mcp`, 'codex mcp login tracker'];
const cursorLink = () => `cursor://anysphere.cursor-deeplink/mcp/install?name=tracker&config=${btoa(JSON.stringify({ url: `${BASE()}/mcp` }))}`;
const pluginCmds = () => [`claude plugin marketplace add ${BASE()}/agent/marketplace.json`, 'claude plugin install tracker@tracker'];
const agentCmds = () => [`exponential-agent login --url ${BASE()}`, 'exponential-agent autostart on'];

const dmy = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };

function Cmd({ lines }: { lines: string[] }) {
  return (
    <div className="wiz-cmd">
      <code className="wiz-cmd-text">{lines.map((l) => <div key={l}>{l}</div>)}</code>
      <button className="icon-btn" aria-label={t('Copy')} title={t('Copy')} onClick={() => copyText(lines.join('\n'), t('Copied'))}><Icon.copy size={13} /></button>
    </div>
  );
}

function Wait({ text, hintText, slow }: { text: string; hintText: string; slow: boolean }) {
  return (
    <>
      <span className="wiz-wait"><span className="wiz-pulse" aria-hidden="true" />{text}</span>
      {slow && <span className="hint">{t('Not working?')} {hintText}</span>}
    </>
  );
}

const useNarrow = () => useSyncExternalStore(
  (fn) => { const m = matchMedia('(max-width: 760px)'); m.addEventListener('change', fn); return () => m.removeEventListener('change', fn); },
  () => matchMedia('(max-width: 760px)').matches,
);

const GOALS: { n: Goal; title: () => string; sub: () => string }[] = [
  { n: 1, title: () => t('Ask about and update issues'), sub: () => t('Your AI client reads and changes issues for you.') },
  { n: 2, title: () => t('…and have issues record my work'), sub: () => t('Claude Code leaves a log of its work in each issue.') },
  { n: 3, title: () => t("…and have AI work while I'm away"), sub: () => t('Analyses and Start work run on your computer without you.') },
];

export function SetupWizardHost() {
  const { open, goal: picked } = useSnap();
  const meNow = useMe().data;
  const qc = useQueryClient();
  const narrow = useNarrow();
  const live = open && !!meNow && !meNow.demo;
  // Ten sam klucz co useMe: odświeżanie co 3 s tylko, gdy okno jest otwarte; reszta aplikacji dostaje świeży stan za darmo.
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), retry: false, staleTime: Infinity, refetchInterval: open ? 3000 : false }).data ?? meNow;
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/api/agents'), enabled: live, refetchInterval: live ? 3000 : false });
  const projects = useProjects(live);

  const [client, setClient] = useState<ClientName>('Claude Code');
  const [where, setWhere] = useState<Where>('VS Code');
  const [slow, setSlow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [path, setPath] = useState('');

  useEffect(() => {
    if (!open) return;
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSetupWizard(); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [open]);

  const ai = me?.aiStatus;
  const goal: Goal = picked ?? defaultGoal(ai);
  const done: Record<Goal, boolean> = { 1: !!ai?.client, 2: !!ai?.workTrace, 3: !!ai?.agent };
  const claude = client === 'Claude Code';
  // Ślad pracy dotyczy tylko Claude Code: przy Codex krok jest wyszarzony i nie liczy się do postępu.
  const off2 = !claude && !done[2];
  const needed = ([1, 2, 3] as Goal[]).filter((n) => n <= goal && !(n === 2 && off2));
  const doneCount = needed.filter((n) => done[n]).length;
  const current = needed.find((n) => !done[n]) ?? null;
  // Kliknięty krok (np. agent przed śladem pracy albo drugi klient po pierwszym) wygrywa z bieżącym.
  const [pickedStep, setPickedStep] = useState<Goal | null>(null);
  const openStep = pickedStep && needed.includes(pickedStep) ? pickedStep : current;
  const full = doneCount === needed.length;

  // Po 2 minutach czekania na krok pokazujemy typowe przyczyny.
  useEffect(() => {
    setSlow(false);
    if (!open || current == null) return;
    const id = setTimeout(() => setSlow(true), 120_000);
    return () => clearTimeout(id);
  }, [open, current]);

  if (!open) return <AiHint />;

  // Done przy pełnym celu zapisuje setupDoneAt na serwerze (na telefonie: gdy wszystkie trzy poziomy są zrobione).
  const finish = () => {
    if (narrow ? ([1, 2, 3] as Goal[]).every((n) => done[n]) : full) void api('/api/me/setup-done', { method: 'PUT' }).then(() => qc.invalidateQueries({ queryKey: ['me'] }));
    closeSetupWizard();
  };
  const savePath = (a: AgentRow, project: string) => {
    void api(`/api/agents/${a.id}/repos`, { method: 'PUT', body: { project, path: path.trim() } })
      .then(() => { toast(t('Saved')); setEditing(null); void qc.invalidateQueries({ queryKey: ['agents'] }); })
      .catch((e: Error) => toast(e.message, 'err'));
  };

  const clientHint = where === 'Cursor' ? t('Restart Cursor and check that tracker is enabled in its MCP settings.')
    : claude ? t('In Claude Code run /mcp and choose Authenticate for tracker.') : t('Run codex mcp login tracker and finish the sign-in in the browser.');

  const stepTitle: Record<Goal, string> = { 1: t('Connect a client'), 2: t('Turn on work trace'), 3: t('Agent on this computer') };
  const doneText: Record<Goal, string> = {
    1: `${ai?.clientName ?? t('Client')} · ${ai?.clientAt ? t('connected {when}', { when: timeAgo(ai.clientAt) }) : t('connected')}`,
    2: t('Work trace is on'),
    3: t('A computer is online and up to date'),
  };

  const step1 = (
    <>
      <div className="wiz-tabs">
        <div className="seg" role="group" aria-label={t('Client')}>
          {(['Claude Code', 'Codex'] as ClientName[]).map((c) => <button key={c} className={client === c ? 'on' : ''} onClick={() => setClient(c)}>{c}</button>)}
        </div>
        <div className="seg" role="group" aria-label={t('Where')}>
          {(['VS Code', 'Cursor', 'Terminal'] as Where[]).map((w) => <button key={w} className={where === w ? 'on' : ''} onClick={() => setWhere(w)}>{w}</button>)}
        </div>
      </div>
      {where === 'Cursor' && <div className="wiz-line"><a className="btn primary" href={cursorLink()}>{t('Open in Cursor')}</a><span className="hint">{t('Use a command instead')}</span></div>}
      <Cmd lines={claude ? [claudeCmd()] : codexCmds()} />
      <Wait text={t('Waiting for the first call…')} hintText={clientHint} slow={slow} />
    </>
  );

  const step2 = (
    <>
      <Cmd lines={pluginCmds()} />
      <span className="hint">{t('Restart Claude Code after installing, then work on an issue.')}</span>
      <Wait text={t('Waiting for the first session with an issue number…')} hintText={t('Restart Claude Code and start work on any issue; the plugin loads on start.')} slow={slow} />
    </>
  );

  const rows = (a: AgentRow) => (projects.data ?? []).map((p) => {
    const rp = a.repos?.find((r) => r.project === p.key);
    const k = `${a.id}:${p.key}`;
    return (
      <div key={k} className="wiz-repo">
        <b>{p.key}</b>
        {editing === k
          ? <input className="input grow" autoFocus value={path} aria-label={t('Path')} onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') savePath(a, p.key); if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }} />
          : rp ? <code className="grow">{rp.path}</code> : <span className="hint grow">{t('no repo')}</span>}
        {rp?.status && rp.status !== 'ok' && editing !== k && <span className="hint" title={rp.error ?? undefined}>{rp.status}</span>}
        {editing === k
          ? <button className="btn sm primary" onClick={() => savePath(a, p.key)}>{t('Save')}</button>
          : <button className="btn sm" onClick={() => { setEditing(k); setPath(rp?.path ?? ''); }}>{rp ? t('Change') : t('Choose folder')}</button>}
      </div>
    );
  });

  const step3 = (
    <>
      <div className="wiz-line">
        <a className="btn primary" href={AGENT_EXE} download><Icon.download size={13} /> {t('Download exponential-agent.exe')}</a>
      </div>
      <span className="wiz-warn">{t('Windows may warn about an unsigned file: choose More info, then Run anyway.')}</span>
      <Cmd lines={agentCmds()} />
      {(agents.data ?? []).map((a) => (
        <div key={a.id} className="wiz-computer">
          <div className="wiz-line">
            <b className="grow">{a.label || a.computerName || t('Unnamed computer')}</b>
            {a.online ? <span className="wiz-ok">{t('online')}</span> : <span className="hint">{a.lastSeenAt ? t('last seen {when}', { when: timeAgo(a.lastSeenAt) }) : t('never seen')}</span>}
          </div>
          {rows(a)}
        </div>
      ))}
      <Wait text={t('Waiting for the agent to come online…')} hintText={t('Run exponential-agent login again and check that the program is running.')} slow={slow} />
    </>
  );
  const bodies: Record<Goal, ReactNode> = { 1: step1, 2: step2, 3: step3 };

  const level = (n: Goal) => ([1, 2, 3] as Goal[]).filter((x) => x <= n).every((x) => done[x]);

  return (
    <>
      <div className="backdrop">
        <div className={`modal wiz${narrow ? ' phone' : ''}`} role="dialog" aria-label={t('Connect AI to Exponential')} onKeyDown={(e) => e.stopPropagation()}>
          <div className="wiz-head">
            <div className="wiz-head-text">
              <h2 className="wiz-title">{t('Connect AI to Exponential')}</h2>
              <p className="wiz-lead">{t('Pick what you want AI for. Only the steps you need are shown.')}</p>
            </div>
            <button className="icon-btn" aria-label={t('Close')} title={t('Close')} onClick={closeSetupWizard}><Icon.close size={14} /></button>
          </div>

          <div className="wiz-body">
            {narrow ? (
              <>
                <div className="wiz-goals" role="list">
                  {GOALS.map((g) => (
                    <div key={g.n} role="listitem" className="wiz-goal static">
                      <span className={`wiz-mark${level(g.n) ? ' done' : ''}`} aria-hidden="true">{level(g.n) && <Icon.check size={12} />}</span>
                      <span className="grow"><span className="wiz-goal-title">{g.title()}</span><span className="hint">{g.sub()}</span></span>
                      <span className={level(g.n) ? 'wiz-ok' : 'hint'}>{level(g.n) ? t('Done') : t('Not set up')}</span>
                    </div>
                  ))}
                </div>
                <p className="hint">{t('Connecting is done on a computer, in Settings > Claude Code. From the phone you can request analyses; your computer runs them when it is on.')}</p>
              </>
            ) : (
              <>
                <fieldset className="wiz-goals">
                  <legend className="wiz-label">{t('What do you want AI for?')}</legend>
                  {GOALS.map((g) => (
                    <label key={g.n} className={`wiz-goal${goal === g.n ? ' on' : ''}`}>
                      <input type="radio" name="wiz-goal" checked={goal === g.n} onChange={() => set({ open: true, goal: g.n })} />
                      <span className="grow"><span className="wiz-goal-title">{g.title()}</span><span className="hint">{g.sub()}</span></span>
                    </label>
                  ))}
                </fieldset>
                <ol className="wiz-ladder">
                  {([1, 2, 3] as Goal[]).map((n) => {
                    const beyond = n > goal;
                    const disabled = beyond || (n === 2 && off2);
                    const isDone = done[n];
                    const isCur = openStep === n;
                    const reason = beyond ? t('Not needed for this goal') : t('Claude Code only');
                    return (
                      <li key={n} className={`wiz-step${isDone ? ' done' : ''}${isCur ? ' cur' : ''}${disabled && !isDone ? ' off' : ''}`}>
                        <span className="wiz-mark" aria-hidden="true">{isDone && <Icon.check size={12} />}</span>
                        <div className="wiz-step-main">
                          <div className="wiz-step-head">
                            {disabled ? <b>{stepTitle[n]}</b>
                              : <button type="button" className="wiz-step-toggle" aria-expanded={isCur} onClick={() => setPickedStep(isCur ? null : n)}>{stepTitle[n]}</button>}
                            {isDone && <span className="wiz-ok">{doneText[n]}</span>}
                            {!isDone && disabled && <span className="hint">{reason}</span>}
                          </div>
                          {isCur && <div className="wiz-step-body">{bodies[n]}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </div>

          <div className="foot wiz-foot">
            {!narrow && (
              <div className="wiz-progress">
                <span className="wiz-bar" aria-hidden="true"><span style={{ width: `${needed.length ? (doneCount / needed.length) * 100 : 0}%` }} /></span>
                <span className="hint">{t('{n} of {total}', { n: doneCount, total: needed.length })}</span>
              </div>
            )}
            <span className="spacer" />
            <button className="btn" onClick={closeSetupWizard}>{t('Later')}</button>
            <button className="btn primary" onClick={finish}>{t('Done')}</button>
          </div>
        </div>
      </div>
      <AiHint />
    </>
  );
}
