import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useModal } from './modal.ts';
import { closeAiHint, closeSetupWizard, defaultGoal, openSetupWizard, set, snap, useHint, useSnap, type Goal } from './setupWizardState.ts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useMe, useProjects } from './api.ts';
import { Icon } from './icons.tsx';
import { copyText, toast } from './toast.ts';
import { Tooltip } from './menu.tsx';
import { timeAgo } from './time.ts';
import { t } from './i18n.ts';

/* ---------- podpowiedź przy funkcji AI bez podłączenia ---------- */
function AiHint() {
  const h = useHint();
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
      <Tooltip text={h.kind === 'analyze'
        ? t('Connect AI once and Analyze runs on your computer. Until then the request has nothing to pick it up.')
        : t('Connect AI once so your client can read this issue and report back.')}>
        <div className="ai-hint-title">{h.kind === 'analyze' ? t('Analysis is done by AI on your computer') : t('Work starts in your AI client')}</div>
      </Tooltip>
      <div className="ai-hint-actions">
        <button className="btn primary sm" autoFocus onClick={() => openSetupWizard(h.goal)}>{t('Connect AI')}</button>
        {h.anyway && <button className="btn sm" onClick={() => { const f = h.anyway; closeAiHint(); f?.(); }}>{t('Request anyway')}</button>}
        <button className="btn sm" onClick={closeAiHint}>{t('Not now')}</button>
      </div>
    </div>
  );
}

/* ---------- polecenia ---------- */
type ClientName = 'Claude Code' | 'Codex' | 'Cursor';
type Where = 'VS Code' | 'Cursor' | 'Terminal';
type AgentRepo = { project: string; path: string; source?: string; status?: string; error?: string | null };
type AgentRow = { id: string; name: string; computerName: string; label: string; online: boolean; outdated?: boolean; lastSeenAt: string | null; repos?: AgentRepo[] };

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
    <span className="wiz-wait">
      <span className="wiz-pulse" aria-hidden="true" />{text}
      {slow && <Tooltip text={`${t('Not working?')} ${hintText}`}><span className="wiz-info" tabIndex={0} role="img" aria-label={t('Not working?')}><Icon.question size={13} /></span></Tooltip>}
    </span>
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
  const { open, goal: picked, step: pickedStep } = useSnap();
  const meNow = useMe().data;
  const qc = useQueryClient();
  const narrow = useNarrow();
  const live = open && !!meNow && !meNow.demo;
  const modalRef = useModal();
  // Odpytujemy tylko /api/agents (co 5 s, nie w ukrytej karcie); /api/me odświeża się po powrocie do okna przeglądarki.
  const me = meNow;
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<AgentRow[]>('/api/agents'), enabled: live, refetchInterval: live ? () => (document.hidden ? false : 5000) : false });
  useEffect(() => {
    if (!live) return;
    const f = () => { void qc.invalidateQueries({ queryKey: ['me'] }); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [live, qc]);
  const projects = useProjects(live);

  const [client, setClient] = useState<ClientName>('Claude Code');
  const [where, setWhere] = useState<Where>('VS Code');
  const [slow, setSlow] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [manual, setManual] = useState(false);
  // Wejście na konkretny krok (np. "Wybierz folder" przy komputerze) rozwija sekcję ręczną, gdzie ten krok jest.
  useEffect(() => { if (open && pickedStep) setManual(true); }, [open, pickedStep]);

  useEffect(() => {
    if (!open) return;
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSetupWizard(); };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [open]);

  const ai = me?.aiStatus;
  const goal: Goal = picked ?? defaultGoal(ai);
  const cursor = client === 'Cursor';
  // Przy Cursorze krok 1 jest zrobiony dopiero, gdy podłączonym klientem jest Cursor (nie Claude Code).
  const done: Record<Goal, boolean> = { 1: cursor ? ai?.clientName === 'Cursor' : !!ai?.client, 2: !!ai?.workTrace, 3: !!ai?.agent };
  const claude = client === 'Claude Code';
  // Ślad pracy dotyczy tylko Claude Code: przy Codex krok jest wyszarzony i nie liczy się do postępu.
  const off2 = !claude && !done[2];
  // Asystent Cursora łączy się sam (link instalacyjny, logowanie OAuth); ślad pracy i agent wymagają Claude Code albo Codex.
  const needed = ([1, 2, 3] as Goal[]).filter((n) => n <= goal && !(n === 2 && off2) && !(n > 1 && cursor));
  const doneCount = needed.filter((n) => done[n]).length;
  const current = needed.find((n) => !done[n]) ?? null;
  // Kliknięty krok (np. agent przed śladem pracy albo drugi klient po pierwszym) wygrywa z bieżącym.
  const setStep = (n: Goal | null) => set({ ...snap, step: n });
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
  const complete = narrow ? ([1, 2, 3] as Goal[]).every((n) => done[n]) : full;
  const finish = () => {
    if (complete) void api('/api/me/setup-done', { method: 'PUT' }).then(() => qc.invalidateQueries({ queryKey: ['me'] }));
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
      {(where === 'Cursor' || cursor) && <div className="wiz-line"><a className="btn primary" href={cursorLink()}>{t('Open in Cursor')}</a>{!cursor && <span className="hint">{t('Use a command instead')}</span>}</div>}
      {!cursor && <Cmd lines={claude ? [claudeCmd()] : codexCmds()} />}
      <Wait text={t('Waiting for the first call…')} hintText={clientHint} slow={slow} />
    </>
  );

  const step2 = (
    <>
      <Cmd lines={pluginCmds()} />
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
        <a className="btn primary" href={`/agent/download?engine=${client === 'Codex' ? 'codex' : 'claude'}&goal=${goal}`}><Icon.download size={13} /> {t('Download and run')}</a>
        <Tooltip text={t('Windows may warn about an unsigned file: More info, then Run anyway.')}>
          <span className="wiz-info" tabIndex={0} role="img" aria-label={t('Windows may warn about an unsigned file: More info, then Run anyway.')}><Icon.question size={14} /></span>
        </Tooltip>
        <button type="button" className="wiz-link" aria-expanded={terminal} onClick={() => setTerminal(!terminal)}>{t('Use the terminal')}</button>
      </div>
      {terminal && <Cmd lines={agentCmds()} />}
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

  const chipText: Record<Goal, string> = { 1: ai?.clientName ?? t('Client'), 2: t('Work trace'), 3: t('Agent') };
  const level = (n: Goal) => ([1, 2, 3] as Goal[]).filter((x) => x <= n).every((x) => done[x]);

  return (
    <>
      <div className="backdrop">
        <div className={`modal wiz${narrow ? ' phone' : ''}`} role="dialog" aria-modal="true" aria-label={t('Connect AI to Exponential')} ref={modalRef} tabIndex={-1} onKeyDown={(e) => e.stopPropagation()}>
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
                <p className="hint">{t('Connect on a computer, in Settings > My AI. From the phone you can request analyses; your computer runs them when it is on.')}</p>
              </>
            ) : (
              <>
                <fieldset className="wiz-goals">
                  <legend className="wiz-label">{t('What do you want AI for?')}</legend>
                  {GOALS.map((g) => (
                    <label key={g.n} className={`wiz-goal${g.n <= goal ? ' on' : ''}`}>
                      {/* Poziomy są narastające: wyższy cel zawiera niższe; odznaczenie najwyższego cofa o jeden. */}
                      <input type="checkbox" checked={g.n <= goal} onChange={() => set({ ...snap, open: true, goal: (g.n === goal && g.n > 1 ? g.n - 1 : g.n) as Goal })} />
                      <span className="grow"><span className="wiz-goal-title">{g.title()}</span><span className="hint">{g.sub()}</span></span>
                    </label>
                  ))}
                </fieldset>
                <div className="wiz-steps">
                  {/* Domyślna ścieżka: jeden instalator (klient, plik, status poziomów na żywo); ręczne kroki za przełącznikiem. */}
                  <section className="wiz-block" aria-label={t('Download and run')}>
                    <div className="seg" role="group" aria-label={t('Client')}>
                      {(['Claude Code', 'Codex', 'Cursor'] as ClientName[]).map((c) => <button key={c} className={client === c ? 'on' : ''} onClick={() => setClient(c)}>{c}</button>)}
                    </div>
                    {cursor ? (
                      <div className="wiz-line">
                        <a className="btn primary" href={cursorLink()}>{t('Open in Cursor')}</a>
                        <Tooltip text={t('Cursor adds tracker and asks you to sign in. Work trace and the agent need Claude Code or Codex.')}>
                          <span className="wiz-info" tabIndex={0} role="img" aria-label={t('Cursor adds tracker and asks you to sign in. Work trace and the agent need Claude Code or Codex.')}><Icon.question size={14} /></span>
                        </Tooltip>
                      </div>
                    ) : (
                    <div className="wiz-line">
                      <a className="btn primary" href={`/agent/download?engine=${client === 'Codex' ? 'codex' : 'claude'}&goal=${goal}`}><Icon.download size={13} /> {t('Download and run')}</a>
                      <Tooltip text={t('Windows may warn about an unsigned file: More info, then Run anyway.')}>
                        <span className="wiz-info" tabIndex={0} role="img" aria-label={t('Windows may warn about an unsigned file: More info, then Run anyway.')}><Icon.question size={14} /></span>
                      </Tooltip>
                    </div>
                    )}
                    {([1, 2, 3] as Goal[]).filter((n) => n <= goal).map((n) => needed.includes(n) ? (
                      <div key={n} className="wiz-line">
                        <span className={`wiz-mark${done[n] ? ' done' : ''}`} aria-hidden="true">{done[n] && <Icon.check size={12} />}</span>
                        <span className="grow">{chipText[n]}</span>
                        {done[n] ? <span className="wiz-ok">{t('Done')}</span> : <span className="wiz-wait"><span className="wiz-pulse" aria-hidden="true" />{t('Waiting')}</span>}
                      </div>
                    ) : cursor ? (
                      // Poziom niedostępny dla Cursora: wyszarzony z powodem, nie ukryty.
                      <Tooltip key={n} text={t('Cursor supports only step 1. Work trace and the agent need Claude Code or Codex.')}>
                        <div className="wiz-line wiz-off" aria-disabled="true">
                          <span className="wiz-mark" aria-hidden="true" />
                          <span className="grow">{chipText[n]}</span>
                          <span className="hint">{t('Unavailable')}</span>
                        </div>
                      </Tooltip>
                    ) : null)}
                  </section>
                  <button type="button" className="wiz-link" aria-expanded={manual} onClick={() => setManual(!manual)}>{t('Other ways to connect')}</button>
                  {manual && <>
                  {/* Kroki celu jako zakładki (ten sam przełącznik co wybór klienta): widać, że da się klikać i który jest otwarty. */}
                  {needed.length > 1 && (
                    <div className="seg wiz-steptabs" role="tablist" aria-label={t('Steps')}>
                      {needed.map((n) => (
                        <button key={n} type="button" role="tab" aria-selected={openStep === n} className={openStep === n ? 'on' : ''} title={done[n] ? doneText[n] : stepTitle[n]} onClick={() => setStep(n)}>
                          {done[n] ? <span className="wiz-chip-check"><Icon.check size={12} /></span> : <span className="wiz-chip-n">{n}</span>}{chipText[n]}
                        </button>
                      ))}
                    </div>
                  )}
                  {openStep && (
                    <section className="wiz-block" aria-label={stepTitle[openStep]}>
                      <div className="wiz-block-head">
                        <span className={`wiz-mark${done[openStep] ? ' done' : ' cur'}`} aria-hidden="true">{done[openStep] ? <Icon.check size={12} /> : openStep}</span>
                        <b>{stepTitle[openStep]}</b>
                      </div>
                      <div className="wiz-step-body">{bodies[openStep]}</div>
                    </section>
                  )}
                  </>}
                </div>
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
            <button className="btn primary" onClick={finish}>{complete ? t('Done') : t('Close')}</button>
          </div>
        </div>
      </div>
      <AiHint />
    </>
  );
}
