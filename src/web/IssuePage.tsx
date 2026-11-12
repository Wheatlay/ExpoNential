import { useEffect, useRef, useState } from 'react';
import { ErrorState } from './states.tsx';
import { useModal } from './modal.ts';
import { askConfirm } from './Confirm.tsx';
import { openAiHint } from './setupWizardState.ts';
import { Markdown, MentionHint } from './Markdown.tsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api, useIssue, useMe, useMeta, useProjects, useSprints, useUpdateIssue, type IssueDetail, type IssuePatch, type Meta,
} from './api.ts';
import { waitReasonText } from './analysisWait.ts';
import { openAgentRepos } from './settingsNav.ts';
import { analysisToast } from './analysisToast.ts';
import { collapseImages, expandImages } from './paste.ts';
import { useProjectKey } from './project.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, isMenuOpen, Tooltip, type MenuSpec } from './menu.tsx';
import { assigneeMenu, issueStatusIcon, labelMenu, priorityMenu, relationMenu, sprintLabel, sprintMenu, statusMenu, type PickTarget } from './pickers.tsx';
import { ApiError, isAskedTo, type IssueRow, type RelatedIssue, type RelationKind } from './api.ts';
import { linkProps, navigate } from './router.ts';
import { openNewIssue } from './NewIssue.tsx';
import { copyText, toast } from './toast.ts';
import { CLAIM_TTL_MIN, timeAgo, fullDate } from './time.ts';
import { InlineCode } from './InlineCode.tsx';
import { isTouchDevice, issuePrompt, simulateAgent, startOnPc, startWork, useEditorName } from './startWork.ts';
import { AnalysisView } from './AnalysisView.tsx';
import { Attachments, useAttachments } from './ImagePreviews.tsx';
import { ImageBlock } from './ImageBlock.tsx';
import { enterToSubmit, keyHint, useAutoGrow } from './keys.ts';
import { useMentionAutocomplete } from './MentionInput.tsx';
import { PersonLink, profileContextMenu } from './PersonCard.tsx';
import { rememberIssue } from './SidebarExtras.tsx';
import { ident } from './project.ts';
import { t, tn } from './i18n.ts';

/** Zmiana wartości, której nie wywołała ta karta (np. cudza edycja przez SSE): krótka poświata, żeby było widać, że coś się zmieniło. */
function useRemoteFlash(value: string, own: React.MutableRefObject<string | null>, skip = false) {
  const [on, setOn] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    if (skip || own.current === value) return;
    setOn(true);
    const id = setTimeout(() => setOn(false), 1300);
    return () => clearTimeout(id);
  }, [value, own, skip]);
  return on;
}

export function MarkdownField({ value, onSave, placeholder, size, flash }: {
  value: string; onSave: (v: string) => void; placeholder: string; size?: 'sm' | 'md'; flash?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => collapseImages(value).text);
  // Obrazki w polu edycji to krótkie ![image 1]; pełny adres wraca przy zapisie.
  const images = useRef<Record<string, string>>(collapseImages(value).map);
  const own = useRef<string | null>(null);
  const flashing = useRemoteFlash(value, own, editing || !flash);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Hooki przed warunkowym return (inaczej klik w pole zmienia liczbę hooków i React się wywraca).
  const att = useAttachments();
  const mention = useMentionAutocomplete(ref, draft, setDraft);
  useEffect(() => { if (!editing) { const c = collapseImages(value); images.current = c.map; setDraft(c.text); } }, [value, editing]);
  useEffect(() => { if (editing) { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [editing]);

  if (!editing) {
    return (
      <div className={`editable ${flashing ? 'remote-flash' : ''}`} onClick={(e) => { if (!(e.target as HTMLElement).closest?.('a, .user-mention, .tag-mention')) setEditing(true); }}>
        <Markdown text={value} empty={placeholder} />
      </div>
    );
  }
  const save = () => {
    setEditing(false);
    const expanded = expandImages(draft, images.current);
    const next = att.urls.length ? att.withImages(expanded) : expanded;
    att.clear();
    if (next !== value) { own.current = next; onSave(next); }
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
        className={`md-edit ${size ? `md-${size}` : ''}`}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => {
          e.stopPropagation();
          mention.onKeyDown(e);
          if (e.defaultPrevented) return;
          if (e.key === 'Escape') { setDraft(value); setEditing(false); }
          enterToSubmit(e, save, setDraft);
        }}
      />
      <MentionHint text={draft} />
      {mention.popup}
      <Attachments urls={att.urls} onRemove={att.remove} />
      <div className="edit-actions">
        <span className="hint edit-hint">{keyHint('save')}</span>
        <button className="btn sm" onClick={() => { setDraft(value); setEditing(false); }}>{t('Cancel')}</button>
        <button className="btn sm primary" onClick={save}>{t('Save')}</button>
      </div>
    </div>
  );
}

function TitleField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const own = useRef<string | null>(null);
  const flashing = useRemoteFlash(value, own);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [draft]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`issue-title ${flashing ? 'remote-flash' : ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ''))}
      onBlur={() => { if (draft.trim() && draft !== value) { own.current = draft; onSave(draft); } else setDraft(value); }}
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
  const projects = useProjects().data;
  const pkey = useProjectKey();
  const editorName = useEditorName();
  const canEditProject = !!me?.isAdmin || projects?.find((p) => p.key === pkey)?.role === 'admin';
  const issue = q.data;
  useEffect(() => { if (issue?.id) { void qc.invalidateQueries({ queryKey: ['issues'] }); rememberIssue(number); } }, [issue?.id, qc, number]);

  const save = (patch: IssuePatch) => update.mutate({ number, patch });

  const testingNames = (meta?.statuses ?? []).filter((s) => s.role === 'testing').map((s) => s.name);
  const curStatus = meta?.statuses.find((s) => s.id === issue?.statusId);
  const envNow = issue && (curStatus?.role === 'testing' || curStatus?.type === 'completed') ? deployedEnvOf(issue.commits) : null;
  const target: PickTarget | null = issue ? {
    number, statusId: issue.statusId, priority: issue.priority, assigneeId: issue.assigneeId, labelIds: issue.labelIds,
    sprintId: issue.sprintId, hasChangeNotes: !!issue.changeHuman.trim() && !!issue.changeAi.trim(), changeNotesStale: issue.changeNotesStale,
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

  if (q.isError && !issue) {
    if (q.error instanceof ApiError && q.error.status === 404) return <div className="issue-page"><div className="issue-content"><div className="empty-block"><b>{t('{id} not found', { id: ident(number) })}</b><a className="btn" {...linkProps('/')}>{t('Back to board')}</a></div></div></div>;
    return <div className="issue-page"><div className="issue-content"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div></div>;
  }
  if (!issue || !meta || !target) return <div className="issue-page" />;

  const status = meta.statuses.find((s) => s.id === issue.statusId)!;
  const assignee = meta.users.find((u) => u.id === issue.assigneeId);
  const creator = meta.users.find((u) => u.id === issue.creatorId);
  const sprint = sprints.find((s) => s.id === issue.sprintId);
  const subDone = issue.children.filter((c) => ['completed', 'canceled', 'duplicate'].includes(meta.statuses.find((s) => s.id === c.statusId)?.type ?? '')).length;

  const local = !!me?.hasAgent;
  // Stare skrypty na PC: serwer i tak nie wyda im zlecenia, więc nie dajemy go złożyć (powód + skrót do aktualizacji obok).
  const outdated = !!me?.agentOutdated && local && !me?.demo;
  const outdatedReason = t('This PC has an old agent. Update it first (Settings › My AI).');
  // Bez podłączonego AI link edytora albo nic nie otworzy, albo otworzy klienta bez dostępu do zgłoszenia: zamiast błędu
  // popover pod przyciskiem prowadzi do kreatora z celem tej funkcji.
  const ai = me?.aiStatus;
  const aiMissing = !!ai && !local && (!ai.client || !ai.agent);
  const demo = !!me?.demo;
  // Projekt bez repo: analiza nie ma czego czytać. Wyszarzone z powodem; admin projektu klika podpowiedź i trafia do ustawień.
  const noRepo = !demo && !issue.projectHasRepo;
  const noRepoTip = t('Set the repo in project settings');
  const goRepoSettings = () => { if (canEditProject) navigate('/settings#project'); };
  const analyze = async (deep = false, anchor?: HTMLElement): Promise<void> => {
    if (demo) { await simulateAgent(number, 'analyze'); return; }
    if (noRepo) { toast(noRepoTip, 'warn'); return; }
    // Kolejka zespołu: zlecenie weźmie komputer kogoś z zespołu, więc bez podpowiedzi. Inaczej (kolejka wyłączona, brak własnego agenta)
    // nic nie podejmie zlecenia, więc zamiast zlecenia mimo to podpowiedź pokazuje powód.
    if (aiMissing && anchor && !issue.teamQueue) { openAiHint(anchor, 'analyze', 3, undefined, waitReasonText('queue_off')); return; }
    // Zlecenie czeka w kolejce, agent bierze je sam.
    try {
      await api(`/api/issues/${ident(number)}/analyze`, { method: 'POST', body: { deep } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && e.message === 'no_repo') { toast(noRepoTip, 'warn'); void qc.invalidateQueries({ queryKey: ['issue', number] }); return; }
      throw e;
    }
    void qc.invalidateQueries({ queryKey: ['issue', number] });
    if (local) analysisToast(number, me?.agentOnline ? t('Queued. It runs on your PC in a moment.') : t('Queued. Your PC is offline, it runs when it is on.'));
    else analysisToast(number, t('AI analysis requested. A PC with the agent runs it.'));
  };
  // Stan zlecenia: czeka (jest online PC, który je weźmie) / czeka na PC (nikt nie słucha) / biegnie na PC (claim).
  // Utknięte liczymy od ostatniego sygnału zajętego agenta (claim jest odświeżany), nie od zlecenia: kolejka przy wyłączonym PC to nie awaria.
  const claimedAt = issue.analysisRequestedAt ? issue.analysisClaimedAt : null;
  const stalled = !!claimedAt && Date.now() - new Date(claimedAt).getTime() > CLAIM_TTL_MIN * 60_000;
  // Nieudany przebieg nie wraca sam do kolejki: pokazujemy błąd i dajemy zlecić ponownie albo anulować.
  const failed = !!issue.analysisRequestedAt && !!issue.analysisFailedAt;
  const waitingForPc = !!issue.analysisRequestedAt && !claimedAt && !failed && !issue.analysisCanRun && !demo;
  const noRepoPc = !!issue.analysisRequestedAt && !claimedAt && !failed && !waitingForPc && issue.analysisNoCapablePc && !demo;
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
          <TitleField key={issue.id} value={issue.title} onSave={(title) => save({ title })} />
          <div className="issue-actions">
            {!demo && local && isTouchDevice() ? (
              // Telefon (albo przeglądarka bez agenta): polecenie leci do agenta na moim komputerze. Wyłączone z powodem, nie ukryte.
              <Tooltip text={outdated ? outdatedReason : me?.agentOnline ? null : t('Your PC is offline')}>
                <button className="btn sm start-btn" data-tour="start-work" disabled={outdated || !me?.agentOnline}
                  onClick={() => void startOnPc(number).catch((e: Error) => toast(e.message, 'err'))}>
                  <Icon.play size={12} /> {t('Open in Claude Code')}
                </button>
              </Tooltip>
            ) : (
              <button className="btn sm start-btn" data-tour="start-work" onClick={(e) => (demo ? setStartOpen(true) : local || ai?.client ? void startWork(number) : openAiHint(e.currentTarget, 'start', 3))} title={t('Opens Claude Code in {editor} with this issue, assigns you and moves it to In Progress', { editor: editorName })}>
                <Icon.play size={12} /> {t('Open in Claude Code')}
              </button>
            )}
            {issue.startOnPc && !demo && local && isTouchDevice() && (() => {
              const sp = issue.startOnPc, device = sp.device ?? 'PC';
              if (sp.state === 'waiting') return <span className="pill">{t('Waiting for PC')}</span>;
              if (sp.state === 'starting') return <span className="pill">{t('Starting on {device}…', { device })}</span>;
              if (sp.state === 'failed') return <span className="pill blocked" title={sp.error ?? undefined}>{t('Failed on {device}', { device })}</span>;
              return <>
                <span className="pill ok">{t('Running on {device}', { device })}</span>
                <a className="btn sm" href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">{t('Open in Claude')}</a>
              </>;
            })()}
            {issue.pauseReason && curStatus?.role === 'paused' && <span className="pill" title={issue.pauseReason}><span className="pill-text">{issue.pauseReason}</span></span>}
            {envNow && <span className="pill ok" title={t('All commits are on {env}', { env: envNow })}><Icon.rocket size={12} /> {envNow}</span>}
          </div>
          {startOpen && <DemoStartModal number={number} onClose={() => setStartOpen(false)} />}
          {/* Pytanie pokazuje jego komentarz (QuestionFooter); baner tylko dla starych pytań bez komentarza. */}
          {issue.infoQuestion && !issue.comments.some((c) => c.id === issue.infoCommentId) && (() => {
            const asked = meta.users.find((u) => u.id === issue.infoFromId);
            const by = meta.users.find((u) => u.id === issue.infoById);
            const mine = isAskedTo(issue, me?.id, meta.tags);
            return (
              <div className={`question-banner ${mine ? 'me' : ''}`}>
                <Icon.question size={16} />
                <div className="q-body">
                  <div className="q-who">{mine ? (asked ? t('Asked you') : t('Question for everyone')) : t('Waiting for {name}', { name: asked?.name ?? t('anyone') })}{by ? ` · ${t('asked by {name}', { name: by.name })}` : ''}</div>
                  <div className="q-text">{issue.infoQuestion}</div>
                </div>
                {!mine && <button className="btn sm" onClick={() => save({ infoFromId: null })} title={t('Close the question without an answer')}>{t('Close question')}</button>}
                {mine && <AnswerBox number={number} />}
              </div>
            );
          })()}
          <div className="desc-wrap">
            {/* Opis z etykietą i ramką, żeby było widać, że to pole (i że to nie odpowiedź na pytanie). */}
            <div className="desc-field">
              <div className="desc-label">{t('Description')}</div>
              <MarkdownField key={issue.id} flash value={issue.description} onSave={(description) => save({ description })} placeholder={t('Add description… (click to edit, paste screenshots)')} />
            </div>
          </div>

          {/* ---- sub-issues ---- */}
          <hr className="issue-sep" />
          <SubIssues issue={issue} meta={meta} done={subDone} />
          <hr className="issue-sep" />

          {/* ---- pola AI: zwijane paski z podglądem (wariant C) ---- */}
          <div className="section fold-group">
            <FoldBar id="analysis" tour="analysis" badge={<span className="badge ai">AI</span>} name={t('Problem analysis')}
              preview={issue.analysisRequestedAt ? t('Waiting for analysis…') : analysisPreview(issue) || t('No analysis yet')}
              meta={issue.analysisUpdatedAt && !issue.analysisRequestedAt ? `${timeAgo(issue.analysisUpdatedAt)}${!issue.analysisRequestedAt && issue.analysisResultDeep ? ` · ${t('Deep')}` : ''}` : ''}
              tools={<span className="fold-tools">
                {/* Kolejka zespołu jest domyślnie wyłączona; gdy włączona, widać to przy analizie, bo zmienia, czyj PC ją uruchomi. */}
                {issue.teamQueue && !demo && <span className="pill" title={t("Team queue is on: any teammate's PC that is online can run this analysis. Change it in project settings > AI agent.")}>{t('Team queue')}</span>}
                {/* Czeka, a mój PC ma stare skrypty: to zwykle prawdziwa przyczyna, więc mówimy o niej tutaj, nie tylko w Ustawieniach. */}
                {outdated && !issue.analysisClaimedAt && (
                  <span className="pill stalled" role="button" title={t('This PC has an old agent and may not pick this up. Click to open Settings › My AI.')}
                    onClick={(e) => { e.stopPropagation(); navigate('/settings#claude'); }}>{t('Update needed')}</span>
                )}
                {issue.analysisRequestedAt && <>
                  <span className={`pill ${failed || stalled || waitingForPc || noRepoPc ? 'stalled' : 'ai'}`} {...(issue.analysisWaitReason === 'no_repo_pc' && !demo ? { role: 'button', tabIndex: 0, onClick: (e: React.MouseEvent) => { e.stopPropagation(); openAgentRepos(); }, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.stopPropagation(); openAgentRepos(); } } } : {})}
                    title={failed ? t('The analysis failed on the PC: {error}. Analyze again or cancel.', { error: issue.analysisError || '?' })
                      : stalled ? t('No analysis after {min} minutes: the agent did not start or stopped. Analyze again or cancel.', { min: CLAIM_TTL_MIN })
                      : waitingForPc || noRepoPc ? waitReasonText(issue.analysisWaitReason) ?? (waitingForPc ? t('No PC with the agent is online for this request. It runs when one is on.') : t('No PC has this project\'s repo')) : undefined}>
                    <Icon.sparkle size={12} /> <span className="pill-text">{failed ? t('Failed') : stalled ? t('Stalled') : waitingForPc || noRepoPc ? t('Waiting for a PC with team queue on')
                      : claimedAt ? t('Running on {name}', { name: issue.analysisClaimedDeviceName ?? t('a PC') }) : t('Waiting')}{issue.analysisDeep ? ` · ${t('Deep')}` : ''} · {timeAgo(failed ? issue.analysisFailedAt! : claimedAt ?? issue.analysisRequestedAt)}</span></span>
                  <button className="btn sm" onClick={(e) => { e.stopPropagation(); void cancelAnalysis(); }}>{t('Cancel')}</button>
                </>}
                {(!issue.analysisRequestedAt || stalled || failed) && <>
                    <Tooltip text={noRepo ? noRepoTip : outdated ? outdatedReason : local ? t('Runs on your PC, read-only') : t('Marks the issue for AI analysis')}>
                      <button className="btn sm ai-btn" data-tour="analyze" disabled={outdated && !noRepo} aria-disabled={noRepo || undefined}
                        onClick={(e) => { e.stopPropagation(); if (noRepo) { goRepoSettings(); return; } void analyze(false, e.currentTarget); }}><Icon.sparkle size={13} /> {issue.analysis ? t('Re-analyze') : t('Analyze')}</button>
                    </Tooltip>
                    {/* Deep jest zawsze widoczny; bez agenta (albo w demo) wyszarzony z powodem. */}
                    <Tooltip text={demo ? t('Disabled in the demo') : noRepo ? noRepoTip : outdated ? outdatedReason : !local ? t('Deep needs the agent on your PC') : t('Deeper analysis with a stronger model: slower and more expensive')}>
                      <button className="btn sm ai-btn" disabled={demo || (!noRepo && (outdated || !local))} aria-disabled={noRepo || undefined} onClick={(e) => { e.stopPropagation(); if (noRepo) { goRepoSettings(); return; } void analyze(true, e.currentTarget); }}>{t('Deep')}</button>
                    </Tooltip>
                </>}
                  </span>}>
              <div className="panel ai">
                {issue.analysisData
                  ? <AnalysisView issue={issue} data={issue.analysisData} />
                  : demo && issue.analysisRequestedAt && !issue.analysis.trim()
                  ? <div className="analyzing"><Icon.sparkle size={14} /> {t('Analysis in progress…')}</div>
                  : <MarkdownField value={issue.analysis} onSave={(analysis) => save({ analysis })}
                  placeholder={issue.analysisRequestedAt ? t('Analysis will appear here') : t('No analysis yet')} size="md" />}
              </div>
            </FoldBar>
            <FoldBar id="human" badge={<span className="badge human">HUMAN</span>} name={t('Summary')}
              preview={firstLine(issue.changeHuman) || t('Short summary for people, one change per line')}
              meta={lineCount(issue.changeHuman)} required={!issue.changeHuman.trim()} stale={issue.changeNotesStale}>
              <div className="panel human">
                <MarkdownField value={issue.changeHuman} onSave={(changeHuman) => save({ changeHuman })}
                  placeholder={t('One change per line')} size="sm" />
              </div>
            </FoldBar>
            <FoldBar id="tech" badge={<span className="badge tech">TECH</span>} name={t('Change log')}
              preview={techSummary(issue.changeAi) || t('Commits, files, reasons, verification')}
              meta="" required={!issue.changeAi.trim()} stale={issue.changeNotesStale}>
              <div className="panel tech">
                <MarkdownField value={issue.changeAi} onSave={(changeAi) => save({ changeAi })}
                  placeholder={t('Commits, files, reasons, verification')} />
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
          <button className="prop" data-prop="assignee" onContextMenu={profileContextMenu(assignee)} onClick={(e) => openMenu(e.currentTarget, assigneeMenu(meta, target, save, me?.id))}>
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
              <span key={l.id} className="label-chip"><span className="dot" style={{ background: l.color }} />{l.name}
                <button className="label-x" aria-label={t('Remove label {name}', { name: l.name })} title={t('Remove label {name}', { name: l.name })}
                  onClick={() => save({ labelIds: issue.labelIds.filter((x) => x !== l.id) })}><Icon.close size={12} /></button>
              </span>
            ))}
            <button className="icon-btn" title={t('Change labels (L)')} aria-label={t('Change labels (L)')} onClick={(e) => openMenu(e.currentTarget, labelMenu(meta, target, save))}><Icon.plus size={14} /></button>
          </div>
        </div>
        <div className="props-group">
          <h4>{t('Parent')}</h4>
          <button className="prop muted" onClick={(e) => {
            const all = qc.getQueryData<IssueRow[]>(['issues']) ?? [];
            openMenu(e.currentTarget, {
              searchable: true, placeholder: t('Set parent issue…'),
              items: [
                { key: 'none', label: t('No parent'), checked: !issue.parent, onSelect: () => save({ parentNumber: null }) },
                ...all.filter((i) => i.number !== number).sort((a, b) => b.number - a.number).map((i) => ({
                  key: `i${i.number}`, label: `${ident(i.number)} ${i.title}`, icon: issueStatusIcon(meta.statuses, i.statusId), checked: issue.parent?.number === i.number,
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
                {/* Stare deployed_at bez wpisów środowisk (np. dane demo) dalej pokazują jedną rakietę produkcji. */}
                {c.envs.length === 0 && c.deployedAt && <span title={t('Deployed {when}', { when: fullDate(c.deployedAt) })} style={{ color: 'var(--success-text)', marginLeft: 'auto' }}><Icon.rocket size={13} /></span>}
                {c.envs.map((e, i) => <span key={e.name} title={t('{env} {when}', { env: e.name, when: fullDate(e.at) })} style={{ color: e.isProduction ? 'var(--success-text)' : 'var(--progress-text)', marginLeft: i === 0 ? 'auto' : undefined }}><Icon.rocket size={13} /></span>)}
              </a>
            ))}
          </div>
        )}
        <div className="props-group hint">
          {t('Created by {name}', { name: creator?.name ?? t('unknown') })} · <span title={fullDate(issue.createdAt)}>{timeAgo(issue.createdAt)}</span>
          <div className="copy-row">
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
    void qc.invalidateQueries({ queryKey: ['issues'] });
  };
  if (!issue.children.length && !adding) {
    return (
      <div className="section add-sub">
        <button className="btn sm" onClick={() => setAdding(true)}><Icon.sub size={13} /> {t('Add sub-issue')}</button>
      </div>
    );
  }
  return (
    <div className="section">
      <div className="section-head">
        {t('Sub-issues')} <span className="hint">{done}/{issue.children.length}</span>
        <span className="tools">
          <Tooltip text={t('Open the full new-issue form')}><button className="icon-btn" aria-label={t('Open the full new-issue form')} onClick={() => openNewIssue({ parentNumber: issue.number, assigneeId: issue.assigneeId })}><Icon.edit size={14} /></button></Tooltip>
          <button className="icon-btn" title={t('Add sub-issue')} aria-label={t('Add sub-issue')} onClick={() => setAdding(true)}><Icon.plus size={14} /></button>
        </span>
      </div>
      {issue.children.map((c) => {
        const st = meta.statuses.find((s) => s.id === c.statusId)!;
        const tg: PickTarget = { number: c.number, statusId: c.statusId, priority: c.priority, assigneeId: c.assigneeId, labelIds: [], sprintId: null, hasChangeNotes: c.hasChangeNotes, changeNotesStale: c.changeNotesStale };
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

function eventText(p: IssueDetail['activity'][number]['payload'], meta: Meta, commitUrl?: (sha: string) => string | undefined) {
  switch (p.kind) {
    case 'created': return <>{t('created the issue')}</>;
    case 'status': return <>{t('changed status from')} <b>{p.from ?? '—'}</b> {t('to')} <b>{p.to}</b></>;
    case 'assignee': return p.to ? <>{t('assigned to')} <b>{p.to}</b></> : <>{t('removed assignee')} <b>{p.from}</b></>;
    case 'priority': return <>{t('set priority to')} <b>{t(meta.priorities[p.to])}</b></>;
    case 'labels': return <>{p.added.length > 0 && <>{t('added')} <b>{p.added.join(', ')}</b> </>}{p.removed.length > 0 && <>{t('removed')} <b>{p.removed.join(', ')}</b></>}</>;
    case 'field': return <>{t('edited')} {{ title: t('the title'), description: t('the description'), analysis: t('the AI analysis'), change_human: t('the HUMAN change notes'), change_ai: t('the AI change log') }[p.field] ?? p.field}</>;
    case 'analysis_requested': return <>{t('requested')} <b>{p.deep ? t('a deep AI analysis') : t('an AI analysis')}</b></>;
    case 'analysis_claimed': return <>{t('started the analysis on')} <b>{p.device}</b></>;
    case 'started_on_pc': return <>{t('Started on {device}', { device: p.device })}</>;
    case 'start_on_pc_failed': return <span title={p.error || undefined}>{t('Start on {device} failed', { device: p.device })}</span>;
    case 'analysis_failed': return <>{t('analysis failed')}{p.error ? <>: <span className="ev-error">{p.error}</span></> : ''}</>;
    case 'decision': return p.answer
      ? <>{t('decided')} „{p.question}”: <b>{p.answer}</b></>
      : <>{t('cleared the decision')} „{p.question}”</>;
    case 'sprint': return p.to ? <>{t('moved to')} <b>{p.to}</b></> : <>{t('removed from sprint')}</>;
    case 'parent': return p.to ? <>{t('set parent to')} <a {...linkProps(`/issue/${ident(p.to)}`)}><b>{ident(p.to)}</b></a></> : <>{t('removed parent')}</>;
    case 'commit': return <>{p.author} {t('committed')} <a href={p.url} target="_blank" rel="noreferrer"><code>{p.sha.slice(0, 7)}</code> {p.message}</a></>;
    case 'question': return <>{t('asked')} <b>{p.to}</b>: {p.question}</>;
    case 'answered': return <>{t('answered the question')}{p.backTo ? <>, {t('back to')} <b>{p.backTo}</b></> : ''}</>;
    case 'paused': return <>{t('paused it')}{p.reason ? <>: {p.reason}</> : ''}{p.waitsOn ? <>, {t('waiting on')} <a {...linkProps(`/issue/${ident(p.waitsOn)}`)}><b>{ident(p.waitsOn)}</b></a></> : ''}</>;
    case 'resumed': return <>{t('resumed, unblocked by')} <a {...linkProps(`/issue/${ident(p.by)}`)}><b>{ident(p.by)}</b></a></>;
    case 'relation': {
      const verb = { waits_on: t('waits on'), blocks: t('blocks'), related: t('is related to'), duplicate_of: t('is a duplicate of'), duplicated_by: t('is duplicated by') }[p.relation];
      return <>{p.action === 'added' ? t('marked that this issue') : t('removed:')} {verb} <a {...linkProps(`/issue/${ident(p.other)}`)}><b>{ident(p.other)}</b></a></>;
    }
    case 'deploy': return <>{t('changes were')} {p.env ? <b style={{ color: p.prod ? 'var(--success-text)' : 'var(--progress-text)' }}>{t('deployed to {env}', { env: p.env })}</b> : <b style={{ color: 'var(--success-text)' }}>{t('deployed')}</b>} (<code>{p.sha.slice(0, 7)}</code>)</>;
    case 'worklog': return (
      <details className="worklog">
        <summary>{t('worked in Claude Code')}{p.repo ? <> {t('on')} <b>{p.repo}</b></> : ''}: {tn(p.files.length, '{n} file', '{n} files')}, {tn(p.commits.length, '{n} commit', '{n} commits')}</summary>
        {p.commits.length > 0 && <><h5>{t('Commits')}</h5><ul>{p.commits.map((c) => { const url = commitUrl?.(c.sha); return <li key={c.sha}>{url ? <a href={url} target="_blank" rel="noreferrer"><code>{c.sha.slice(0, 7)}</code> {c.message}</a> : <><code>{c.sha.slice(0, 7)}</code> {c.message}</>}</li>; })}</ul></>}
        {p.files.length > 0 && <><h5>{t('Files')}</h5><ul>{p.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul></>}
      </details>
    );
  }
}

/** Najdalsze środowisko, na którym są wszystkie commity zgłoszenia (Prod przed resztą, potem kolejność z ustawień). */
function deployedEnvOf(commits: IssueDetail['commits']): string | null {
  if (!commits.length) return null;
  const common = commits[0].envs.filter((e) => commits.every((c) => c.envs.some((x) => x.name === e.name)));
  return (common.find((e) => e.isProduction) ?? common[common.length - 1])?.name ?? null;
}

/** Drobne zmiany pól: przygaszone, żeby wyróżniały się komentarze, praca Claude, commity i deploye. */
const MINOR_EVENTS = new Set(['created', 'status', 'assignee', 'priority', 'labels', 'sprint', 'parent', 'relation', 'decision', 'answered', 'resumed']);

function eventIcon(p: IssueDetail['activity'][number]['payload']) {
  if (p.kind === 'commit') return <Icon.commit size={14} />;
  if (p.kind === 'deploy') return <span style={{ color: p.env && !p.prod ? 'var(--progress-text)' : 'var(--success-text)' }}><Icon.rocket size={14} /></span>;
  if (p.kind === 'analysis_failed') return <span style={{ color: 'var(--danger-text)' }}><Icon.sparkle size={14} /></span>;
  if (p.kind === 'analysis_requested' || p.kind === 'analysis_claimed' || p.kind === 'started_on_pc') return <span style={{ color: 'var(--ai-text)' }}><Icon.sparkle size={14} /></span>;
  if (p.kind === 'worklog') return <span style={{ color: 'var(--ai-text)' }}><Icon.sparkle size={14} /></span>;
  return null;
}

function Activity({ issue, meta, meId }: { issue: IssueDetail; meta: Meta; meId?: number }) {
  const [body, setBody] = useState('');
  const grow = useAutoGrow(body);
  const mention = useMentionAutocomplete(grow, body, setBody);
  const [showAll, setShowAll] = useState(false);
  // Kolejność wpisów: domyślnie najnowsze na górze; wybór zapamiętany w przeglądarce.
  const [newestFirst, setNewestFirst] = useState(() => { try { return localStorage.getItem('activityOrder') !== 'oldest'; } catch { return true; } });
  const toggleOrder = () => setNewestFirst((n) => { try { localStorage.setItem('activityOrder', n ? 'oldest' : 'newest'); } catch { /* prywatne okno */ } return !n; });
  const [editing, setEditing] = useState<number | null>(null);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['issue', issue.number] });

  // Commit z sesji Claude jest już we wpisie worklog (z linkiem): osobna linia z webhooka GitHuba tylko by go dublowała.
  const worklogShas = issue.activity.flatMap((e) => (e.payload.kind === 'worklog' ? e.payload.commits.map((c) => c.sha) : []));
  const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  const inWorklog = (sha: string) => worklogShas.some((w) => sameSha(w, sha));
  const emptyWorklog = (p: IssueDetail['activity'][number]['payload']) => p.kind === 'worklog' && !p.files.length && !p.commits.length;
  const commitUrl = (sha: string) => issue.commits.find((c) => sameSha(c.sha, sha))?.url;

  type Entry = { at: string; kind: 'event'; e: IssueDetail['activity'][number] } | { at: string; kind: 'comment'; c: IssueDetail['comments'][number] };
  const entries: Entry[] = [
    // Pytanie widać w komentarzu, więc wpis "asked X: …" w historii tylko by je dublował.
    ...issue.activity.filter((e) => (e.payload.kind !== 'field' || showAll) && e.payload.kind !== 'question' && !emptyWorklog(e.payload) && !(e.payload.kind === 'commit' && inWorklog(e.payload.sha))).map((e) => ({ at: e.createdAt, kind: 'event' as const, e })),
    ...issue.comments.filter((c) => !c.replyToId).map((c) => ({ at: c.createdAt, kind: 'comment' as const, c })),
  ].sort((a, b) => (newestFirst ? b.at.localeCompare(a.at) : a.at.localeCompare(b.at)));
  const hiddenEdits = issue.activity.filter((e) => e.payload.kind === 'field').length;

  const att = useAttachments();
  const send = async () => {
    if (!body.trim() && !att.urls.length) return;
    await api(`/api/issues/${ident(issue.number)}/comments`, { method: 'POST', body: { body: att.withImages(body) } });
    setBody('');
    att.clear();
    refresh();
  };

  const composer = (
    <div className="composer">
      <textarea
        ref={grow}
        placeholder={`${t('Leave a comment…')} (${keyHint('send')})`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => { e.stopPropagation(); mention.onKeyDown(e); if (e.defaultPrevented) return; enterToSubmit(e, () => void send(), setBody); }}
      />
      <MentionHint text={body} />
      {mention.popup}
      <Attachments urls={att.urls} onRemove={att.remove} />
      <div className="row">
        <button className="btn sm primary" disabled={!body.trim() && !att.urls.length} onClick={() => void send()}><Icon.arrowUp size={13} /> {t('Comment')}</button>
      </div>
    </div>
  );

  return (
    <div className="activity" data-tour="activity">
      <h3 style={{ display: 'flex', alignItems: 'center' }}>
        {t('Activity')}
        <span className="activity-tools">
          {hiddenEdits > 0 && <button className="hint" style={{ fontWeight: 400 }} onClick={() => setShowAll((s) => !s)}>{showAll ? tn(hiddenEdits, 'Hide {n} edit', 'Hide {n} edits') : tn(hiddenEdits, 'Show {n} edit', 'Show {n} edits')}</button>}
          <Tooltip text={newestFirst ? t('Newest first') : t('Oldest first')}>
            <button className="icon-btn" aria-label={newestFirst ? t('Newest first') : t('Oldest first')} onClick={toggleOrder}>{newestFirst ? <Icon.arrowUp size={14} /> : <Icon.arrowDown size={14} />}</button>
          </Tooltip>
        </span>
      </h3>
      {newestFirst && composer}
      {entries.map((en, i) => {
        if (en.kind === 'event') {
          const actor = meta.users.find((u) => u.id === en.e.actorId);
          const k = en.e.payload.kind;
          const anon = k === 'commit' || k === 'deploy';
          // Seria wpisów tej samej osoby: awatar i imię tylko przy pierwszym.
          const prev = entries[i - 1];
          const cont = !anon && en.e.actorId != null && prev?.kind === 'event' && prev.e.actorId === en.e.actorId && prev.e.viaAi === en.e.viaAi && !['commit', 'deploy'].includes(prev.e.payload.kind);
          const tone = k === 'field' ? 'minor edit' : MINOR_EVENTS.has(k) ? 'minor' : '';
          return (
            <div key={`e${en.e.id}`} className={`event ${tone} ${cont ? 'cont' : ''}`}>
              <span className="ev-icon">{cont ? null : eventIcon(en.e.payload) ?? <Avatar user={actor} size={16} />}</span>
              <span>{!anon && !cont && <b>{actor ? <PersonLink userId={actor.id}>{actor.name}</PersonLink> : t('System')} </b>}{en.e.viaAi && !cont && <><span className="badge ai">AI</span> </>}{eventText(en.e.payload, meta, commitUrl)} · <span title={fullDate(en.at)}>{timeAgo(en.at)}</span></span>
            </div>
          );
        }
        const c = en.c;
        const author = meta.users.find((u) => u.id === c.authorId);
        const own = c.authorId === meId;
        return (
          <div key={`c${c.id}`} className={`comment ${issue.comments.some((r) => r.replyToId === c.id) || issue.infoCommentId === c.id ? 'thread' : ''} ${issue.lastSeenAt && c.createdAt > issue.lastSeenAt && c.authorId !== meId ? 'new' : ''}`}>
            <div className="comment-head">
              <PersonLink userId={author?.id}><Avatar user={author} size={20} /><b>{author?.name ?? t('Unknown')}</b></PersonLink>
              {issue.lastSeenAt && c.createdAt > issue.lastSeenAt && c.authorId !== meId && <span className="badge new">{t('New')}</span>}
              <span className="when" title={fullDate(c.createdAt)}>{timeAgo(c.createdAt)}{c.updatedAt !== c.createdAt && new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime() > 1000 ? ` ${t('(edited)')}` : ''}</span>
              {own && (
                <span className="tools">
                  <button className="icon-btn" title={t('Edit')} aria-label={t('Edit')} onClick={() => setEditing(c.id)}><Icon.edit size={14} /></button>
                  <button className="icon-btn" title={t('Delete')} aria-label={t('Delete')} onClick={() => void askConfirm({ title: t('Delete this comment?') }).then((ok) => { if (ok) void api(`/api/comments/${c.id}`, { method: 'DELETE' }).then(refresh); })}><Icon.trash size={14} /></button>
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
                    <PersonLink userId={ra?.id}><Avatar user={ra} size={18} /><b>{ra?.name ?? t('Unknown')}</b></PersonLink>
                    <span className="when" title={fullDate(r.createdAt)}>{timeAgo(r.createdAt)}</span>
                  </div>
                  <Markdown text={r.body} />
                </div>
              );
            })}
            {issue.infoCommentId === c.id && issue.infoQuestion && <QuestionFooter issue={issue} meId={meId} />}
          </div>
        );
      })}
      {!newestFirst && composer}
    </div>
  );
}

function CommentEditor({ initial, onSave, onCancel }: { initial: string; onSave: (b: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const grow = useAutoGrow(v);
  const mention = useMentionAutocomplete(grow, v, setV);
  return (
    <div>
      <textarea ref={grow} className="md-edit md-sm" autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); mention.onKeyDown(e); if (e.defaultPrevented) return; if (e.key === 'Escape') onCancel(); enterToSubmit(e, () => onSave(v), setV); }} />
      <MentionHint text={v} />
      {mention.popup}
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
    ['duplicate_of', t('Duplicate of'), issue.relations.duplicateOf ?? []],
    ['duplicated_by', t('Duplicates'), issue.relations.duplicates ?? []],
  ];
  const any = groups.some(([, , l]) => l.length);
  return (
    <div className="props-group">
      <h4 style={{ display: 'flex', alignItems: 'center' }}>
        {t('Relations')}
        <button className="icon-btn rel-add" title={t('Add relation')} aria-label={t('Add relation')}
          onClick={(e) => openMenu(e.currentTarget, relationMenu(qc.getQueryData<IssueRow[]>(['issues']) ?? [], issue.number, refresh, meta.statuses))}>
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
                <button className="icon-btn" title={t('Remove relation')} aria-label={t('Remove relation')} onClick={() => remove(kind, r.number)}><Icon.close size={12} /></button>
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
function FoldBar({ id, tour, badge, name, preview, meta, required, stale, tools, children }: {
  id: string; tour?: string; badge: React.ReactNode; name: string; preview: string; meta: string; required?: boolean; stale?: boolean; tools?: React.ReactNode; children: React.ReactNode;
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
        {!required && stale && <span className="badge req" title={t('New commits since these notes were written')}>{t('Outdated')}</span>}
        {meta && <span className="hint fold-meta">{meta}</span>}
        {tools}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/** Otwarte pytanie żyje tylko w swoim komentarzu: pytany (osoba albo ktoś z #tagu) odpowiada tutaj, reszta może je zamknąć bez odpowiedzi. */
function QuestionFooter({ issue, meId }: { issue: IssueDetail; meId?: number }) {
  const qc = useQueryClient();
  const mine = isAskedTo(issue, meId, useMeta().data?.tags);
  const close = () => void api(`/api/issues/${ident(issue.number)}`, { method: 'PATCH', body: { infoFromId: null } })
    .then(() => { void qc.invalidateQueries({ queryKey: ['issue', issue.number] }); void qc.invalidateQueries({ queryKey: ['issues'] }); });
  return (
    <div className="reply waiting">
      <span className="badge req">{mine ? t('Asked you') : t('Waiting for answer')}</span>
      {mine ? <AnswerBox number={issue.number} />
        : <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={close} title={t('Close the question without an answer')}>{t('Close question')}</button>}
    </div>
  );
}

/** Odpowiedź na pytanie z Need Info: komentarz zamyka pytanie i przywraca status. */
function AnswerBox({ number }: { number: number }) {
  const [v, setV] = useState('');
  const qc = useQueryClient();
  const att = useAttachments();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionAutocomplete(taRef, v, setV);
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
      <textarea ref={taRef} placeholder={`${t('Your answer…')} (${keyHint('send')})`} value={v} onChange={(e) => setV(e.target.value)}
        onPaste={att.onPaste}
        onKeyDown={(e) => { e.stopPropagation(); mention.onKeyDown(e); if (e.defaultPrevented) return; enterToSubmit(e, () => void send(), setV); }} />
      <button className="btn sm primary" disabled={!v.trim() && !att.urls.length} onClick={() => void send()}>{t('Answer')}</button>
      <MentionHint text={v} />
      {mention.popup}
      <Attachments urls={att.urls} onRemove={att.remove} />
    </div>
  );
}

/** Demo: "Start work" pokazuje gotowy prompt i odtwarza pracę agenta zamiast otwierać VS Code. */
function DemoStartModal({ number, onClose }: { number: number; onClose: () => void }) {
  const prompt = useQuery({ queryKey: ['prompt', number, 'start'], queryFn: () => issuePrompt(number, 'start'), staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const modalRef = useModal();
  const run = async () => {
    setBusy(true);
    const ok = await simulateAgent(number, 'work');
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal guard demo-start" role="dialog" aria-modal="true" aria-label={t('Start work with Claude Code')} ref={modalRef} tabIndex={-1} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
        <div className="guard-head">
          <span className="guard-icon"><Icon.play size={16} /></span>
          <div>
            <div className="guard-title">{t('Start work with Claude Code')}</div>
          </div>
        </div>
        <pre className="demo-prompt">{prompt.data ?? (prompt.isError ? t('Could not load the prompt') : t('Loading…'))}</pre>
        <div className="foot">
          <button className="btn" disabled={!prompt.data} onClick={() => copyText(prompt.data ?? '', t('Copied'))}><Icon.copy size={13} /> {t('Copy')}</button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <Tooltip text={t('In production this opens Claude Code in {editor} with the prompt above.', { editor: useEditorName() })}>
            <button className="btn primary" disabled={busy} onClick={() => void run()}><Icon.play size={12} /> {t('Run the agent (replay)')}</button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
