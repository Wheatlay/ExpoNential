import { useEffect, useRef, useState } from 'react';
import { askConfirm } from './Confirm.tsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api, useIssue, useMe, useMeta, useSprints, useUpdateIssue, type IssueDetail, type IssuePatch, type Meta,
} from './api.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, isMenuOpen, Tooltip, type MenuSpec } from './menu.tsx';
import { assigneeMenu, labelMenu, priorityMenu, relationMenu, sprintLabel, sprintMenu, statusMenu, type PickTarget } from './pickers.tsx';
import { isAskedTo, type IssueRow, type RelatedIssue, type RelationKind } from './api.ts';
import { linkProps, navigate } from './router.ts';
import { openNewIssue } from './NewIssue.tsx';
import { copyText, toast } from './toast.ts';
import { timeAgo, fullDate } from './time.ts';
import { InlineCode } from './InlineCode.tsx';
import { agentHere, issuePrompt, runLocalAnalysis, simulateAgent, startOnPc, startWork } from './startWork.ts';
import { AnalysisView } from './AnalysisView.tsx';
import { Attachments, useAttachments } from './ImagePreviews.tsx';
import { ImageBlock } from './ImageBlock.tsx';
import { enterToSubmit } from './keys.ts';
import { rememberIssue } from './SidebarExtras.tsx';
import { ident } from './project.ts';
import { t, tn } from './i18n.ts';

export function Markdown({ text, empty }: { text: string; empty?: string }) {
  if (!text.trim()) return <div className="md empty">{empty ?? ''}</div>;
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{
        // Linki do innych zadań (/issue/ACME-…) nawigują w aplikacji, zewnętrzne w nowej karcie.
        img: ({ node: _n, src, alt }) => <ImageBlock src={typeof src === 'string' ? src : undefined} alt={alt} />,
        a: ({ node: _n, href, ...p }) => (href?.startsWith('/') ? <a {...p} {...linkProps(href)} /> : <a {...p} href={href} target="_blank" rel="noreferrer" />),
      }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function MarkdownField({ value, onSave, placeholder, minHeight }: {
  value: string; onSave: (v: string) => void; placeholder: string; minHeight?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Hooki przed warunkowym return (inaczej klik w pole zmienia liczbę hooków i React się wywraca).
  const att = useAttachments();
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  useEffect(() => { if (editing) { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [editing]);

  if (!editing) {
    return (
      <div className="editable" onClick={(e) => { if (!(e.target as HTMLElement).closest?.('a')) setEditing(true); }}>
        <Markdown text={value} empty={placeholder} />
      </div>
    );
  }
  const save = () => {
    setEditing(false);
    const next = att.urls.length ? att.withImages(draft) : draft;
    att.clear();
    if (next !== value) onSave(next);
  };
  const insert = (s: string) => {
    const el = ref.current!;
    const next = draft.slice(0, el.selectionStart) + s + draft.slice(el.selectionEnd);
    setDraft(next);
  };
  return (
    <div>
      <textarea
        ref={ref}
        className="md-edit"
        style={{ minHeight: minHeight ?? 160 }}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
          enterToSubmit(e, save, setDraft);
        }}
      />
      <Attachments urls={att.urls} onRemove={att.remove} />
      <div className="edit-actions">
        <span className="hint" style={{ marginRight: 'auto' }}>{t('Enter to save · Alt+Enter new line · paste images')}</span>
        <button className="btn sm" onClick={() => { setDraft(value); setEditing(false); }}>{t('Cancel')}</button>
        <button className="btn sm primary" onClick={save}>{t('Save')}</button>
      </div>
    </div>
  );
}

function TitleField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [draft]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="issue-title"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ''))}
      onBlur={() => { if (draft.trim() && draft !== value) onSave(draft); else setDraft(value); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLTextAreaElement).blur(); }}
    />
  );
}

export function IssuePage({ number }: { number: number }) {
  const q = useIssue(number);
  const meta = useMeta().data;
  const me = useMe().data;
  const sprints = useSprints().data?.sprints ?? [];
  const update = useUpdateIssue();
  const qc = useQueryClient();
  const propsRef = useRef<HTMLDivElement>(null);
  const [startOpen, setStartOpen] = useState(false);
  const issue = q.data;
  useEffect(() => { if (issue?.id) { void qc.invalidateQueries({ queryKey: ['issues'] }); rememberIssue(number); } }, [issue?.id, qc, number]);

  const save = (patch: IssuePatch) => update.mutate({ number, patch });

  const testingNames = (meta?.statuses ?? []).filter((s) => s.role === 'testing').map((s) => s.name);
  const target: PickTarget | null = issue ? {
    number, statusId: issue.statusId, priority: issue.priority, assigneeId: issue.assigneeId, labelIds: issue.labelIds,
    sprintId: issue.sprintId, hasChangeNotes: !!issue.changeHuman.trim() && !!issue.changeAi.trim(),
    wasTested: issue.activity.some((a) => a.payload.kind === 'status' && testingNames.includes(a.payload.to)),
  } : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!meta || !target || isMenuOpen()) return;
      const el = e.target as HTMLElement;
      if (el.closest?.('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const at = (sel: string) => (propsRef.current?.querySelector(sel) as HTMLElement | null) ?? { x: window.innerWidth / 2 - 120, y: 140 };
      const k = e.key.toLowerCase();
      if (k === 's') openMenu(at('[data-prop=status]'), statusMenu(meta, target, save));
      else if (k === 'p') openMenu(at('[data-prop=priority]'), priorityMenu(meta, target, save));
      else if (k === 'a') openMenu(at('[data-prop=assignee]'), assigneeMenu(meta, target, save, me?.id));
      else if (k === 'l') openMenu(at('[data-prop=labels]'), labelMenu(meta, target, save));
      else if (k === 'i' && me) save({ assigneeId: target.assigneeId === me.id ? null : me.id });
      else if (e.key === 'Escape') navigate('/');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (q.isError) return <div className="issue-page"><div className="issue-content"><h2>{t('{id} not found', { id: ident(number) })}</h2><a className="btn" {...linkProps('/')}>{t('Back to board')}</a></div></div>;
  if (!issue || !meta || !target) return <div className="issue-page" />;

  const status = meta.statuses.find((s) => s.id === issue.statusId)!;
  const assignee = meta.users.find((u) => u.id === issue.assigneeId);
  const creator = meta.users.find((u) => u.id === issue.creatorId);
  const sprint = sprints.find((s) => s.id === issue.sprintId);
  const subDone = issue.children.filter((c) => ['completed', 'canceled', 'duplicate'].includes(meta.statuses.find((s) => s.id === c.statusId)?.type ?? '')).length;

  const local = !!me?.localAgentAt;
  // Stare skrypty na PC: serwer i tak nie wyda im zlecenia, więc nie dajemy go złożyć (powód + skrót do aktualizacji obok).
  const outdated = !!me?.agentOutdated && local && !me?.demo;
  const outdatedReason = t('Your PC has old Exponential scripts. Update them first: Settings > Claude Code (or click Update needed).');
  // Bez podłączonego Claude Code link vscode:// albo nic nie otworzy, albo otworzy Claude bez dostępu do zgłoszenia:
  // zamiast udawać, że działa, prowadzimy do jednorazowego podłączenia.
  const connectFirst = async () => {
    const ok = await askConfirm({
      title: t('Connect Claude Code first?'),
      body: t('This account has no computer connected to Exponential yet. One PowerShell command in Settings > Claude Code connects it; without it Claude cannot read the issue.'),
      action: t('Open settings'), danger: false,
    });
    if (ok) navigate('/settings#claude');
  };
  const demo = !!me?.demo;
  const analyze = async (deep = false) => {
    if (demo) { await simulateAgent(number, 'analyze'); return; }
    // Na komputerze z agentem link tracker:// rusza od razu (local rezerwuje zlecenie dla tego PC na 60 s); gdzie indziej zlecenie czeka w kolejce.
    const here = agentHere(me);
    await api(`/api/issues/${ident(number)}/analyze`, { method: 'POST', body: { deep, local: here } });
    void qc.invalidateQueries({ queryKey: ['issue', number] });
    if (here) {
      runLocalAnalysis(number, deep);
      toast(deep ? t('Deep analysis started on your computer. It shows up here in a few minutes.') : t('Analysis started on your computer. It shows up here in a few minutes.'));
    } else if (local) toast(me?.agentOnline ? t('Queued. It runs on your PC in a moment.') : t('Queued. Your PC is offline, it runs when it is on.'));
    else toast(t('AI analysis requested. To have it run by itself on your computer, set up local analysis in Settings > Claude Code.'));
  };
  // Stan zlecenia: czeka (jest online PC, który je weźmie) / czeka na PC (nikt nie słucha) / biegnie na PC (claim).
  // Utknięte liczymy od ostatniego sygnału zajętego agenta (claim jest odświeżany), nie od zlecenia: kolejka przy wyłączonym PC to nie awaria.
  const claimedAt = issue.analysisRequestedAt ? issue.analysisClaimedAt : null;
  const stalled = !!claimedAt && Date.now() - new Date(claimedAt).getTime() > 15 * 60_000;
  // Nieudany przebieg nie wraca sam do kolejki: pokazujemy błąd i dajemy zlecić ponownie albo anulować.
  const failed = !!issue.analysisRequestedAt && !!issue.analysisFailedAt;
  const waitingForPc = !!issue.analysisRequestedAt && !claimedAt && !failed && !issue.analysisCanRun && !demo;
  const cancelAnalysis = async () => {
    await api(`/api/issues/${ident(number)}/analyze`, { method: 'DELETE' });
    void qc.invalidateQueries({ queryKey: ['issue', number] });
  };

  return (
    <div className="issue-page">
      <div className="issue-main">
        <div className="issue-content">
          {issue.parent && (
            <a className="hint" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginBottom: 10 }} {...linkProps(`/issue/${ident(issue.parent.number)}`)}>
              <Icon.parent size={13} /> {ident(issue.parent.number)} {issue.parent.title}
            </a>
          )}
          <TitleField value={issue.title} onSave={(title) => save({ title })} />
          <div className="issue-actions">
            {!demo && !!me?.localAgentAt && !agentHere(me) ? (
              // Telefon (albo przeglądarka bez agenta): polecenie leci do agenta na moim komputerze. Wyłączone z powodem, nie ukryte.
              <Tooltip text={outdated ? outdatedReason : me?.agentOnline ? null : t('Your PC is offline')}>
                <button className="btn sm start-btn" data-tour="start-work" disabled={outdated || !me?.agentOnline}
                  onClick={() => void startOnPc(number).catch((e: Error) => toast(e.message, 'err'))}>
                  <Icon.play size={12} /> {t('Start on my PC')}
                </button>
              </Tooltip>
            ) : (
              <button className="btn sm start-btn" data-tour="start-work" onClick={() => (demo ? setStartOpen(true) : local ? void startWork(number) : void connectFirst())} title={t('Opens Claude Code in VS Code with this issue, assigns you and moves it to In Progress')}>
                <Icon.play size={12} /> {t('Start work in Claude')}
              </button>
            )}
          </div>
          {startOpen && <DemoStartModal number={number} onClose={() => setStartOpen(false)} />}
          {issue.infoQuestion && (() => {
            const asked = meta.users.find((u) => u.id === issue.infoFromId);
            const by = meta.users.find((u) => u.id === issue.infoById);
            const mine = isAskedTo(issue, me?.id);
            return (
              <div className={`question-banner ${mine ? 'me' : ''}`}>
                <Icon.question size={16} />
                <div className="q-body">
                  <div className="q-who">{mine ? (asked ? t('Question for you') : t('Question for everyone')) : t('Waiting for {name}', { name: asked?.name ?? t('anyone') })}{by ? ` · ${t('asked by {name}', { name: by.name })}` : ''}</div>
                  <div className="q-text">{issue.infoQuestion}</div>
                </div>
                {!mine && <button className="btn sm" onClick={() => save({ infoFromId: null })} title={t('Close the question without an answer')}>{t('Close question')}</button>}
                {mine && <AnswerBox number={number} />}
              </div>
            );
          })()}
          <div style={{ marginTop: 14 }}>
            {/* Opis z etykietą i ramką, żeby było widać, że to pole (i że to nie odpowiedź na pytanie). */}
            <div className="desc-field">
              <div className="desc-label">{t('Description')}</div>
              <MarkdownField value={issue.description} onSave={(description) => save({ description })} placeholder={t('Add description… (click to edit, paste screenshots)')} />
            </div>
          </div>

          {/* ---- sub-issues ---- */}
          <hr className="issue-sep" />
          <SubIssues issue={issue} meta={meta} done={subDone} />
          <hr className="issue-sep" />

          {/* ---- pola AI: zwijane paski z podglądem (wariant C) ---- */}
          <div className="section fold-group">
            <FoldBar id="analysis" tour="analysis" badge={<span className="badge ai">AI</span>} name={t('Problem analysis')}
              preview={issue.analysisRequestedAt ? t('Waiting for Claude…') : analysisPreview(issue) || t('No analysis yet')}
              meta={issue.analysisUpdatedAt ? timeAgo(issue.analysisUpdatedAt) : ''}
              tools={<span style={{ display: 'inline-flex', gap: 4 }}>
                {/* Kolejka zespołu jest domyślnie wyłączona; gdy włączona, widać to przy analizie, bo zmienia, czyj PC ją uruchomi. */}
                {issue.teamQueue && !demo && <span className="pill" title={t("Team queue is on: any teammate's PC that is online can run this analysis. Change it in project settings > AI prompts.")}>{t('Team queue')}</span>}
                {/* Czeka, a mój PC ma stare skrypty: to zwykle prawdziwa przyczyna, więc mówimy o niej tutaj, nie tylko w Ustawieniach. */}
                {outdated && !issue.analysisClaimedAt && (
                  <span className="pill stalled" role="button" title={t('Your PC has old Exponential scripts, so it may not pick this up. Click to open Settings > Claude Code and run the update command.')}
                    onClick={(e) => { e.stopPropagation(); navigate('/settings#claude'); }}>{t('Update needed')}</span>
                )}
                {issue.analysisRequestedAt && <>
                  <span className={`pill ${failed || stalled || waitingForPc ? 'stalled' : 'ai'}`}
                    title={failed ? t('The analysis failed on the PC: {error}. Analyze again or cancel.', { error: issue.analysisError || '?' })
                      : stalled ? t('No analysis after 15 minutes: the agent did not start or stopped. Analyze again or cancel.')
                      : waitingForPc ? t('No computer with the agent is online for this request. It runs when one is on.') : undefined}>
                    <Icon.sparkle size={12} /> {failed ? t('Failed') : stalled ? t('Stalled') : waitingForPc ? t('Waiting for a PC')
                      : claimedAt ? t('Running on {name}', { name: issue.analysisClaimedDeviceName ?? t('a PC') }) : t('Waiting')}{issue.analysisDeep ? ` · ${t('Deep')}` : ''} · {timeAgo(failed ? issue.analysisFailedAt! : claimedAt ?? issue.analysisRequestedAt)}</span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); void cancelAnalysis(); }}>{t('Cancel')}</button>
                </>}
                {(!issue.analysisRequestedAt || stalled || failed) && <>
                    {!issue.analysisRequestedAt && issue.analysisResultDeep && issue.analysisUpdatedAt && <span className="pill ai done" title={t('Deeper analysis with a stronger model: slower and more expensive')}>{t('Deep')}</span>}
                    <Tooltip text={outdated ? outdatedReason : null}>
                      <button className="btn sm ai-btn" data-tour="analyze" disabled={outdated} title={outdated ? undefined : local ? t('Runs Claude on your computer, read-only') : t('Marks the issue for analysis by Claude')}
                        onClick={(e) => { e.stopPropagation(); void analyze(); }}><Icon.sparkle size={13} /> {issue.analysis ? t('Re-analyze') : t('Analyze')}</button>
                    </Tooltip>
                    {demo && <button className="btn sm ai-btn" disabled title={t('Disabled in the demo')} onClick={(e) => e.stopPropagation()}>{t('Deep')}</button>}
                    {!demo && local && <Tooltip text={outdated ? outdatedReason : null}>
                      <button className="btn sm ai-btn" disabled={outdated} title={outdated ? undefined : t('Deeper analysis with a stronger model: slower and more expensive')} onClick={(e) => { e.stopPropagation(); void analyze(true); }}>{t('Deep')}</button>
                    </Tooltip>}
                </>}
                  </span>}>
              <div className="panel ai">
                {issue.analysisData
                  ? <AnalysisView issue={issue} data={issue.analysisData} />
                  : demo && issue.analysisRequestedAt && !issue.analysis.trim()
                  ? <div className="analyzing"><Icon.sparkle size={14} /> {t('Agent is analyzing…')}</div>
                  : <MarkdownField value={issue.analysis} onSave={(analysis) => save({ analysis })}
                  placeholder={issue.analysisRequestedAt ? t('Claude will write the analysis here.') : local ? t('No analysis yet. Analyze runs Claude on your computer and writes it here in a few minutes.')
                    : t('No analysis yet. Click Analyze and Claude will look at the problem and the code. Tip: set up local analysis in Settings > Claude Code (one command) and it runs by itself.')} minHeight={120} />}
              </div>
            </FoldBar>
            <FoldBar id="human" badge={<span className="badge human">HUMAN</span>} name={t('What changed')}
              preview={firstLine(issue.changeHuman) || t('Short summary for people, one change per line')}
              meta={lineCount(issue.changeHuman)} required={!issue.changeHuman.trim()}>
              <div className="panel human">
                <MarkdownField value={issue.changeHuman} onSave={(changeHuman) => save({ changeHuman })}
                  placeholder={t('Short summary for people: one change per line. Written by the close-ticket skill.')} minHeight={100} />
              </div>
            </FoldBar>
            <FoldBar id="tech" badge={<span className="badge tech">TECH</span>} name={t('Change log')}
              preview={techSummary(issue.changeAi) || t('Commits, files, reasons, verification')}
              meta="" required={!issue.changeAi.trim()}>
              <div className="panel tech">
                <MarkdownField value={issue.changeAi} onSave={(changeAi) => save({ changeAi })}
                  placeholder={t('Detailed description of every change for the next agent: commits, files, reasons, verification.')} minHeight={140} />
              </div>
            </FoldBar>
          </div>

          <Activity issue={issue} meta={meta} meId={me?.id} />
        </div>
      </div>

      {/* ---- właściwości ---- */}
      <aside className="props-panel" ref={propsRef}>
        <div className="props-group">
          <h4>{t('Properties')}</h4>
          <button className="prop" data-prop="status" onClick={(e) => openMenu(e.currentTarget, statusMenu(meta, target, save))}>
            <StatusIcon status={status} fraction={startedFraction(meta.statuses, status)} /> {status.name}
          </button>
          <button className="prop" data-prop="priority" onClick={(e) => openMenu(e.currentTarget, priorityMenu(meta, target, save))}>
            <PriorityIcon priority={issue.priority} /> <span className={issue.priority ? '' : 'hint'}>{issue.priority ? t(meta.priorities[issue.priority]) : t('Set priority')}</span>
          </button>
          <button className="prop" data-prop="assignee" onClick={(e) => openMenu(e.currentTarget, assigneeMenu(meta, target, save, me?.id))}>
            <Avatar user={assignee} size={16} /> <span className={assignee ? '' : 'hint'}>{assignee?.name ?? t('Assign')}</span>
          </button>
          <button className="prop" data-prop="sprint" onClick={(e) => openMenu(e.currentTarget, sprintMenu(sprints, target, save))}>
            <Icon.sprint size={15} /> <span className={sprint ? '' : 'hint'}>{sprint ? sprintLabel(sprint) : t('Add to sprint')}</span>
          </button>
        </div>
        <div className="props-group">
          <h4>{t('Labels')}</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center' }} data-prop="labels">
            {issue.labelIds.map((id) => meta.labels.find((l) => l.id === id)).map((l) => l && (
              <span key={l.id} className="label-chip"><span className="dot" style={{ background: l.color }} />{l.name}</span>
            ))}
            <button className="icon-btn" title={t('Change labels (L)')} onClick={(e) => openMenu(e.currentTarget, labelMenu(meta, target, save))}><Icon.plus size={14} /></button>
          </div>
        </div>
        <div className="props-group">
          <h4>{t('Parent')}</h4>
          <button className="prop muted" onClick={(e) => {
            const all = qc.getQueryData<{ number: number; title: string }[]>(['issues']) ?? [];
            openMenu(e.currentTarget, {
              searchable: true, placeholder: t('Set parent issue…'),
              items: [
                { key: 'none', label: t('No parent'), checked: !issue.parent, onSelect: () => save({ parentNumber: null }) },
                ...all.filter((i) => i.number !== number).sort((a, b) => b.number - a.number).map((i) => ({
                  key: `i${i.number}`, label: `${ident(i.number)} ${i.title}`, checked: issue.parent?.number === i.number,
                  onSelect: () => save({ parentNumber: i.number }),
                })),
              ],
            });
          }}>
            <Icon.parent size={14} /> {issue.parent ? `${ident(issue.parent.number)}` : t('Set parent')}
          </button>
        </div>
        <Relations issue={issue} meta={meta} />
        {issue.commits.length > 0 && (
          <div className="props-group">
            <h4>{t('Commits')}</h4>
            {issue.commits.map((c) => (
              <a key={c.sha} className="prop" href={c.url} target="_blank" rel="noreferrer" title={c.message}>
                <Icon.commit size={14} />
                <code style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.sha.slice(0, 7)}</code>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400 }}>{c.message.split('\n')[0]}</span>
                {c.deployedAt && <span title={t('Deployed {when}', { when: fullDate(c.deployedAt) })} style={{ color: 'var(--success-text)', marginLeft: 'auto' }}><Icon.rocket size={13} /></span>}
              </a>
            ))}
          </div>
        )}
        <div className="props-group hint">
          {t('Created by {name}', { name: creator?.name ?? t('unknown') })} · <span title={fullDate(issue.createdAt)}>{timeAgo(issue.createdAt)}</span>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button className="btn sm" onClick={() => copyText(`${location.origin}/issue/${ident(number)}`, t('Link copied'))}><Icon.link size={13} /> {t('Copy link')}</button>
            <button className="btn sm" onClick={() => copyText(`${ident(number)}`, t('ID copied'))}><Icon.copy size={13} /> ID</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function SubIssues({ issue, meta, done }: { issue: IssueDetail; meta: Meta; done: number }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const update = useUpdateIssue();
  const qc = useQueryClient();
  const upd = (n: number) => (patch: IssuePatch) => update.mutate({ number: n, patch }, { onSettled: () => void qc.invalidateQueries({ queryKey: ['issue', issue.number] }) });
  const subMenu = (c: IssueDetail['children'][number], tg: PickTarget): MenuSpec => ({
    searchable: false,
    items: [
      { key: 'open', label: t('Open'), icon: <Icon.chevronRight size={14} />, onSelect: () => navigate(`/issue/${ident(c.number)}`) },
      { key: 'tab', label: t('Open in new tab'), icon: <Icon.link size={14} />, onSelect: () => void window.open(`/issue/${ident(c.number)}`, '_blank') },
      { key: 'sep', separator: true },
      { key: 'status', label: t('Status'), kbd: ['S'], icon: <StatusIcon status={meta.statuses.find((s) => s.id === c.statusId)!} />, submenu: () => statusMenu(meta, tg, upd(c.number)) },
      { key: 'priority', label: t('Priority'), kbd: ['P'], icon: <PriorityIcon priority={c.priority} colored={false} />, submenu: () => priorityMenu(meta, tg, upd(c.number)) },
      { key: 'assignee', label: t('Assignee'), kbd: ['A'], icon: <Icon.user size={14} />, submenu: () => assigneeMenu(meta, tg, upd(c.number)) },
      { key: 'sep2', separator: true },
      { key: 'copy', label: t('Copy ID'), icon: <Icon.copy size={14} />, onSelect: () => copyText(`${ident(c.number)}`, t('ID copied')) },
      { key: 'detach', label: t('Remove from parent'), icon: <Icon.parent size={14} />, onSelect: () => upd(c.number)({ parentNumber: null }) },
    ],
  });
  const add = async () => {
    if (!title.trim()) return;
    await api('/api/issues', { method: 'POST', body: { title, parentNumber: issue.number, assigneeId: issue.assigneeId, sprintId: issue.sprintId } });
    setTitle('');
    void qc.invalidateQueries({ queryKey: ['issue', issue.number] });
  };
  if (!issue.children.length && !adding) {
    return (
      <div className="section" style={{ marginTop: 18 }}>
        <button className="btn sm" onClick={() => setAdding(true)}><Icon.sub size={13} /> {t('Add sub-issue')}</button>
      </div>
    );
  }
  return (
    <div className="section">
      <div className="section-head">
        {t('Sub-issues')} <span className="hint">{done}/{issue.children.length}</span>
        <span className="tools">
          <Tooltip text={t('Open the full new-issue form')}><button className="icon-btn" onClick={() => openNewIssue({ parentNumber: issue.number, assigneeId: issue.assigneeId })}><Icon.edit size={14} /></button></Tooltip>
          <button className="icon-btn" title={t('Add sub-issue')} onClick={() => setAdding(true)}><Icon.plus size={14} /></button>
        </span>
      </div>
      {issue.children.map((c) => {
        const st = meta.statuses.find((s) => s.id === c.statusId)!;
        const tg: PickTarget = { number: c.number, statusId: c.statusId, priority: c.priority, assigneeId: c.assigneeId, labelIds: [], sprintId: null, hasChangeNotes: c.hasChangeNotes };
        return (
          <a key={c.number} className="sub-row" {...linkProps(`/issue/${ident(c.number)}`)}
            onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, subMenu(c, tg)); }}>
            <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.currentTarget, statusMenu(meta, tg, upd(c.number))); }}>
              <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} />
            </button>
            <span className="id">{ident(c.number)}</span>
            <span className="t"><InlineCode text={c.title} /></span>
            <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.currentTarget, assigneeMenu(meta, tg, upd(c.number))); }}>
              <Avatar user={meta.users.find((u) => u.id === c.assigneeId)} size={18} />
            </button>
          </a>
        );
      })}
      {adding && (
        <div className="sub-add">
          <Icon.sub size={14} />
          <input autoFocus placeholder={t('Sub-issue title, Enter to add')} value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void add(); if (e.key === 'Escape') { setAdding(false); setTitle(''); } }}
            onBlur={() => { if (!title.trim()) setAdding(false); }} />
        </div>
      )}
    </div>
  );
}

function eventText(p: IssueDetail['activity'][number]['payload'], meta: Meta) {
  switch (p.kind) {
    case 'created': return <>{t('created the issue')}</>;
    case 'status': return <>{t('changed status from')} <b>{p.from ?? '—'}</b> {t('to')} <b>{p.to}</b></>;
    case 'assignee': return p.to ? <>{t('assigned to')} <b>{p.to}</b></> : <>{t('removed assignee')} <b>{p.from}</b></>;
    case 'priority': return <>{t('set priority to')} <b>{t(meta.priorities[p.to])}</b></>;
    case 'labels': return <>{p.added.length > 0 && <>{t('added')} <b>{p.added.join(', ')}</b> </>}{p.removed.length > 0 && <>{t('removed')} <b>{p.removed.join(', ')}</b></>}</>;
    case 'field': return <>{t('edited')} {{ title: t('the title'), description: t('the description'), analysis: t('the AI analysis'), change_human: t('the HUMAN change notes'), change_ai: t('the AI change log') }[p.field] ?? p.field}</>;
    case 'analysis_requested': return <>{t('requested')} <b>{p.deep ? t('a deep AI analysis') : t('an AI analysis')}</b></>;
    case 'analysis_claimed': return <>{t('started the analysis on')} <b>{p.device}</b></>;
    case 'decision': return p.answer
      ? <>{t('decided')} „{p.question}”: <b>{p.answer}</b></>
      : <>{t('cleared the decision')} „{p.question}”</>;
    case 'sprint': return p.to ? <>{t('moved to')} <b>{p.to}</b></> : <>{t('removed from sprint')}</>;
    case 'parent': return p.to ? <>{t('set parent to')} <a {...linkProps(`/issue/${ident(p.to)}`)}><b>{ident(p.to)}</b></a></> : <>{t('removed parent')}</>;
    case 'commit': return <>{p.author} {t('committed')} <a href={p.url} target="_blank" rel="noreferrer"><code>{p.sha.slice(0, 7)}</code> {p.message}</a></>;
    case 'question': return <>{t('asked')} <b>{p.to}</b>: {p.question}</>;
    case 'answered': return <>{t('answered the question')}{p.backTo ? <>, {t('back to')} <b>{p.backTo}</b></> : ''}</>;
    case 'relation': {
      const verb = { waits_on: t('waits on'), blocks: t('blocks'), related: t('is related to') }[p.relation];
      return <>{p.action === 'added' ? t('marked that this issue') : t('removed:')} {verb} <a {...linkProps(`/issue/${ident(p.other)}`)}><b>{ident(p.other)}</b></a></>;
    }
    case 'deploy': return <>{t('changes were')} <b style={{ color: 'var(--success-text)' }}>{t('deployed')}</b> (<code>{p.sha.slice(0, 7)}</code>)</>;
    case 'worklog': return (
      <details className="worklog">
        <summary>{t('worked in Claude Code')}{p.repo ? <> {t('on')} <b>{p.repo}</b></> : ''}: {tn(p.files.length, '{n} file', '{n} files')}, {tn(p.commits.length, '{n} commit', '{n} commits')}</summary>
        {p.prompts.length > 0 && <><h5>{t('Asked')}</h5><ul>{p.prompts.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
        {p.commits.length > 0 && <><h5>{t('Commits')}</h5><ul>{p.commits.map((c) => <li key={c.sha}><code>{c.sha.slice(0, 7)}</code> {c.message}</li>)}</ul></>}
        {p.files.length > 0 && <><h5>{t('Files')}</h5><ul>{p.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul></>}
      </details>
    );
  }
}

function eventIcon(p: IssueDetail['activity'][number]['payload']) {
  if (p.kind === 'commit') return <Icon.commit size={14} />;
  if (p.kind === 'deploy') return <span style={{ color: 'var(--success-text)' }}><Icon.rocket size={14} /></span>;
  if (p.kind === 'analysis_requested' || p.kind === 'analysis_claimed') return <span style={{ color: 'var(--ai-text)' }}><Icon.sparkle size={14} /></span>;
  if (p.kind === 'worklog') return <span style={{ color: 'var(--ai-text)' }}><Icon.cursor size={14} /></span>;
  return null;
}

function Activity({ issue, meta, meId }: { issue: IssueDetail; meta: Meta; meId?: number }) {
  const [body, setBody] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['issue', issue.number] });

  type Entry = { at: string; kind: 'event'; e: IssueDetail['activity'][number] } | { at: string; kind: 'comment'; c: IssueDetail['comments'][number] };
  const entries: Entry[] = [
    ...issue.activity.filter((e) => e.payload.kind !== 'field' || showAll).map((e) => ({ at: e.createdAt, kind: 'event' as const, e })),
    ...issue.comments.filter((c) => !c.replyToId).map((c) => ({ at: c.createdAt, kind: 'comment' as const, c })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const hiddenEdits = issue.activity.filter((e) => e.payload.kind === 'field').length;

  const att = useAttachments();
  const send = async () => {
    if (!body.trim() && !att.urls.length) return;
    await api(`/api/issues/${ident(issue.number)}/comments`, { method: 'POST', body: { body: att.withImages(body) } });
    setBody('');
    att.clear();
    refresh();
  };

  return (
    <div className="activity" data-tour="activity">
      <h3 style={{ display: 'flex', alignItems: 'center' }}>
        {t('Activity')}
        {hiddenEdits > 0 && <button className="hint" style={{ marginLeft: 'auto', fontWeight: 400 }} onClick={() => setShowAll((s) => !s)}>{showAll ? tn(hiddenEdits, 'Hide {n} edit', 'Hide {n} edits') : tn(hiddenEdits, 'Show {n} edit', 'Show {n} edits')}</button>}
      </h3>
      {entries.map((en) => {
        if (en.kind === 'event') {
          const actor = meta.users.find((u) => u.id === en.e.actorId);
          return (
            <div key={`e${en.e.id}`} className="event">
              <span className="ev-icon">{eventIcon(en.e.payload) ?? <Avatar user={actor} size={16} />}</span>
              <span>{en.e.payload.kind !== 'commit' && en.e.payload.kind !== 'deploy' && <b>{actor?.name ?? t('System')} </b>}{en.e.viaAi && <><span className="badge ai">AI</span> </>}{eventText(en.e.payload, meta)} · <span title={fullDate(en.at)}>{timeAgo(en.at)}</span></span>
            </div>
          );
        }
        const c = en.c;
        const author = meta.users.find((u) => u.id === c.authorId);
        const own = c.authorId === meId;
        return (
          <div key={`c${c.id}`} className={`comment ${issue.comments.some((r) => r.replyToId === c.id) || issue.infoCommentId === c.id ? 'thread' : ''} ${issue.lastSeenAt && c.createdAt > issue.lastSeenAt && c.authorId !== meId ? 'new' : ''}`}>
            <div className="comment-head">
              <Avatar user={author} size={20} />
              <b>{author?.name ?? t('Unknown')}</b>
              {issue.lastSeenAt && c.createdAt > issue.lastSeenAt && c.authorId !== meId && <span className="badge new">{t('New')}</span>}
              <span className="when" title={fullDate(c.createdAt)}>{timeAgo(c.createdAt)}{c.updatedAt !== c.createdAt && new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000 ? ` ${t('(edited)')}` : ''}</span>
              {own && (
                <span className="tools">
                  <button className="icon-btn" title={t('Edit')} onClick={() => setEditing(c.id)}><Icon.edit size={14} /></button>
                  <button className="icon-btn" title={t('Delete')} onClick={() => void askConfirm({ title: t('Delete this comment?') }).then((ok) => { if (ok) void api(`/api/comments/${c.id}`, { method: 'DELETE' }).then(refresh); })}><Icon.trash size={14} /></button>
                </span>
              )}
            </div>
            {editing === c.id
              ? <CommentEditor initial={c.body} onCancel={() => setEditing(null)} onSave={async (b) => { await api(`/api/comments/${c.id}`, { method: 'PATCH', body: { body: b } }); setEditing(null); refresh(); }} />
              : <Markdown text={c.body} />}
            {/* Odpowiedzi podpięte pod komentarz (np. odpowiedź na pytanie z Need Info). */}
            {issue.comments.filter((r) => r.replyToId === c.id).map((r) => {
              const ra = meta.users.find((u) => u.id === r.authorId);
              return (
                <div key={r.id} className="reply">
                  <div className="comment-head">
                    <span className="badge answer">{t('Answer')}</span>
                    <Avatar user={ra} size={18} />
                    <b>{ra?.name ?? t('Unknown')}</b>
                    <span className="when" title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
                  </div>
                  <Markdown text={r.body} />
                </div>
              );
            })}
            {issue.infoCommentId === c.id && issue.infoQuestion && <div className="reply waiting"><span className="badge req">{t('Waiting for answer')}</span></div>}
          </div>
        );
      })}
      <div className="composer">
        <textarea
          placeholder={t('Leave a comment… (Enter to send, Alt+Enter new line)')}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => { e.stopPropagation(); enterToSubmit(e, () => void send(), setBody); }}
        />
        <Attachments urls={att.urls} onRemove={att.remove} />
        <div className="row">
          <button className="btn sm primary" disabled={!body.trim() && !att.urls.length} onClick={() => void send()}><Icon.arrowUp size={13} /> {t('Comment')}</button>
        </div>
      </div>
    </div>
  );
}

function CommentEditor({ initial, onSave, onCancel }: { initial: string; onSave: (b: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <div>
      <textarea className="md-edit" style={{ minHeight: 100 }} autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onCancel(); enterToSubmit(e, () => onSave(v), setV); }} />
      <div className="edit-actions">
        <button className="btn sm" onClick={onCancel}>{t('Cancel')}</button>
        <button className="btn sm primary" disabled={!v.trim()} onClick={() => onSave(v)}>{t('Save')}</button>
      </div>
    </div>
  );
}

/** Relacje w panelu: "Waiting on" na czerwono, gdy blokujące zadanie nie jest zamknięte. */
function Relations({ issue, meta }: { issue: IssueDetail; meta: Meta }) {
  const qc = useQueryClient();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['issue', issue.number] }); void qc.invalidateQueries({ queryKey: ['issues'] }); };
  const remove = (kind: RelationKind, other: number) =>
    void api(`/api/issues/${ident(issue.number)}/relations`, { method: 'DELETE', body: { kind, other } }).then(refresh);
  const groups: [RelationKind, string, RelatedIssue[]][] = [
    ['waits_on', t('Waiting on'), issue.relations.waitingOn],
    ['blocks', t('Blocks'), issue.relations.blocking],
    ['related', t('Related'), issue.relations.related],
  ];
  const any = groups.some(([, , l]) => l.length);
  return (
    <div className="props-group">
      <h4 style={{ display: 'flex', alignItems: 'center' }}>
        {t('Relations')}
        <button className="icon-btn" style={{ marginLeft: 'auto', width: 22, height: 22 }} title={t('Add relation')}
          onClick={(e) => openMenu(e.currentTarget, relationMenu(qc.getQueryData<IssueRow[]>(['issues']) ?? [], issue.number, refresh))}>
          <Icon.plus size={13} />
        </button>
      </h4>
      {!any && <div className="hint" style={{ padding: '0 8px' }}>{t('None')}</div>}
      {groups.map(([kind, label, list]) => list.length > 0 && (
        <div key={kind} style={{ marginBottom: 6 }}>
          <div className="hint" style={{ padding: '2px 8px' }}>{label}</div>
          {list.map((r) => {
            const st = meta.statuses.find((s) => s.id === r.statusId)!;
            const blocking = kind === 'waits_on' && r.open;
            return (
              <div key={r.number} className={`relation-row ${blocking ? 'blocking' : ''}`}>
                <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} size={12} />
                <a {...linkProps(`/issue/${ident(r.number)}`)} title={r.title}>{ident(r.number)} <span>{r.title}</span></a>
                <button className="icon-btn" title={t('Remove relation')} onClick={() => remove(kind, r.number)}><Icon.close size={12} /></button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Pierwsza niepusta linia bez znaczników markdown, do podglądu w zwiniętym pasku. */
/** Podgląd zwiniętej analizy: werdykt / stan obecny / odpowiedź zamiast linii "Typ:". */
function analysisPreview(issue: IssueDetail) {
  const s = issue.analysisData?.sections;
  return (s && (s.verdict || s.current || s.answer)) || firstLine(issue.analysis);
}
function firstLine(md: string) {
  const line = md.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean);
  return line ?? '';
}
function lineCount(md: string) {
  const n = md.split('\n').filter((l) => l.trim()).length;
  return n ? tn(n, '{n} line', '{n} lines') : '';
}
/** "4 commits · scope exclusions · verification" z sekcji, które skill close-ticket zawsze pisze. */
function techSummary(md: string) {
  if (!md.trim()) return '';
  const commits = new Set(md.match(/\b[0-9a-f]{7,40}\b/g) ?? []).size;
  const parts = [commits ? tn(commits, '{n} commit', '{n} commits') : ''];
  if (/poza zakresem|wyłącz|out of scope/i.test(md)) parts.push(t('scope exclusions'));
  if (/weryfikacj|verification|test/i.test(md)) parts.push(t('verification'));
  return parts.filter(Boolean).join(' · ') || firstLine(md);
}

/** Zwijany pasek: jedna linia podglądu, rozwinięcie zapamiętane w przeglądarce. */
function FoldBar({ id, tour, badge, name, preview, meta, required, tools, children }: {
  id: string; tour?: string; badge: React.ReactNode; name: string; preview: string; meta: string; required?: boolean; tools?: React.ReactNode; children: React.ReactNode;
}) {
  const key = `fold.${id}`;
  // Demo: analiza otwarta od początku (tam dzieje się pokaz), o ile nikt jej nie zwinął.
  const demoOpen = !!useMe().data?.demo && id === 'analysis';
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? demoOpen : v === '1'; } catch { return demoOpen; } });
  const toggle = () => setOpen((o) => { try { localStorage.setItem(key, o ? '0' : '1'); } catch { /* prywatne okno */ } return !o; });
  return (
    <div className={`fold ${open ? 'open' : ''}`} data-tour={tour}>
      <div className="fold-bar" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        <span className="fold-caret"><Icon.caret /></span>
        {badge}
        <span className="fold-name">{name}</span>
        <span className="fold-preview">{open ? '' : preview}</span>
        {required && <span className="badge req" title={t('Expected before Done (not enforced)')}>{t('Missing')}</span>}
        {meta && <span className="hint">{meta}</span>}
        {tools}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** Odpowiedź na pytanie z Need Info prosto z banera: komentarz zamyka pytanie i przywraca status. */
function AnswerBox({ number }: { number: number }) {
  const [v, setV] = useState('');
  const qc = useQueryClient();
  const att = useAttachments();
  const send = async () => {
    if (!v.trim() && !att.urls.length) return;
    await api(`/api/issues/${ident(number)}/comments`, { method: 'POST', body: { body: att.withImages(v) } });
    setV('');
    att.clear();
    void qc.invalidateQueries({ queryKey: ['issue', number] });
    void qc.invalidateQueries({ queryKey: ['issues'] });
    toast(t('Answer sent, question closed'));
  };
  return (
    <div className="answer-box">
      <textarea placeholder={t('Your answer… (Enter to send, Alt+Enter new line)')} value={v} onChange={(e) => setV(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => { e.stopPropagation(); enterToSubmit(e, () => void send(), setV); }} />
      <button className="btn sm primary" disabled={!v.trim() && !att.urls.length} onClick={() => void send()}>{t('Answer')}</button>
      <Attachments urls={att.urls} onRemove={att.remove} />
    </div>
  );
}

/** Demo: "Start work" pokazuje gotowy prompt i odtwarza pracę agenta zamiast otwierać VS Code. */
function DemoStartModal({ number, onClose }: { number: number; onClose: () => void }) {
  const prompt = useQuery({ queryKey: ['prompt', number, 'start'], queryFn: () => issuePrompt(number, 'start'), staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const ok = await simulateAgent(number, 'work');
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal guard demo-start" role="dialog" aria-label={t('Start work with Claude Code')} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <div className="guard-head">
          <span className="guard-icon"><Icon.play size={16} /></span>
          <div>
            <div className="guard-title">{t('Start work with Claude Code')}</div>
          </div>
        </div>
        <pre className="demo-prompt">{prompt.data ?? (prompt.isError ? t('Could not load the prompt') : t('Loading…'))}</pre>
        <div className="hint">{t('In production this opens Claude Code in VS Code with the prompt above.')}</div>
        <div className="foot">
          <button className="btn" disabled={!prompt.data} onClick={() => copyText(prompt.data ?? '', t('Copied'))}><Icon.copy size={13} /> {t('Copy')}</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn primary" disabled={busy} onClick={() => void run()}><Icon.play size={12} /> {t('Run the agent (replay)')}</button>
        </div>
      </div>
    </div>
  );
}
