import { useState, useSyncExternalStore } from 'react';
import { useCreateIssue, useMe, useMeta, useSprints, type IssuePatch } from './api.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu } from './menu.tsx';
import { assigneeMenu, labelMenu, priorityMenu, sprintMenu, statusMenu, type PickTarget } from './pickers.tsx';
import { navigate } from './router.ts';
import { toast } from './toast.ts';
import { Attachments, useAttachments } from './ImagePreviews.tsx';
import { MentionHint } from './Markdown.tsx';
import { enterToSubmit } from './keys.ts';
import { api } from './api.ts';
import { getProjectKey, ident } from './project.ts';
import { CurrentProjectBadge } from './ProjectSwitcher.tsx';
import { t } from './i18n.ts';

type Init = { statusId?: number; assigneeId?: number | null; parentNumber?: number; sprintId?: number | null; priority?: number; labelIds?: number[] };
let current: Init | null = null;
let subs: (() => void)[] = [];

export function openNewIssue(init: Init = {}) {
  current = init;
  subs.forEach((s) => s());
}
function close() {
  current = null;
  subs.forEach((s) => s());
}

export function NewIssueHost() {
  const init = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => current);
  if (!init) return null;
  return <NewIssueModal init={init} />;
}

function NewIssueModal({ init }: { init: Init }) {
  const meta = useMeta().data;
  const me = useMe().data;
  const sprints = useSprints().data?.sprints ?? [];
  const create = useCreateIssue();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [another, setAnother] = useState(false);
  const [analyze, setAnalyze] = useState(false);
  const att = useAttachments();
  const defaultStatus = meta?.statuses.find((s) => s.type === 'unstarted');
  const [form, setForm] = useState<PickTarget>({
    number: 0,
    statusId: init.statusId ?? defaultStatus?.id ?? 0,
    priority: init.priority ?? 0,
    assigneeId: init.assigneeId === undefined ? null : init.assigneeId,
    labelIds: init.labelIds ?? [],
    sprintId: init.sprintId ?? null,
    hasChangeNotes: false,
  });
  if (!meta) return null;
  const set = (patch: IssuePatch) => setForm((f) => ({ ...f, ...patch }));
  const status = meta.statuses.find((s) => s.id === form.statusId) ?? defaultStatus!;
  const assignee = meta.users.find((u) => u.id === form.assigneeId);

  const submit = async () => {
    if (!title.trim()) return;
    const row = await create.mutateAsync({
      title, description: att.withImages(description), statusId: form.statusId, priority: form.priority, assigneeId: form.assigneeId,
      labelIds: form.labelIds, sprintId: form.sprintId, parentNumber: init.parentNumber,
    });
    if (analyze) await api(`/api/issues/${ident(row.number)}/analyze`, { method: 'POST' });
    toast(analyze ? t('Created {id}, AI analysis requested', { id: ident(row.number) }) : t('Created {id}', { id: ident(row.number) }));
    att.clear();
    if (another) { setTitle(''); setDescription(''); return; }
    close();
    if (!init.parentNumber) navigate(`/issue/${ident(row.number)}`);
  };

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
      }}>
        <div className="crumbs">
          <CurrentProjectBadge /> {getProjectKey()} <Icon.chevronRight size={12} /> {init.parentNumber ? t('Sub-issue of {id}', { id: ident(init.parentNumber) }) : t('New issue')}
        </div>
        <input className="title" autoFocus placeholder={t('Issue title')} value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
        <textarea placeholder={t('What happens?\nWhat should happen?\nWhere (screen, link, steps)?\n\nEnter creates · Alt+Enter new line · paste screenshots')} value={description} onChange={(e) => setDescription(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); enterToSubmit(e, () => void submit(), setDescription); }} />
        <MentionHint text={description} />
        <Attachments urls={att.urls} onRemove={att.remove} />
        <div className="props">
          <button className="chip" onClick={(e) => openMenu(e.currentTarget, statusMenu(meta, form, set))}>
            <StatusIcon status={status} fraction={startedFraction(meta.statuses, status)} /> {status.name}
          </button>
          <button className="chip" onClick={(e) => openMenu(e.currentTarget, priorityMenu(meta, form, set))}>
            <PriorityIcon priority={form.priority} /> {form.priority ? t(meta.priorities[form.priority]) : t('Priority')}
          </button>
          <button className="chip" onClick={(e) => openMenu(e.currentTarget, assigneeMenu(meta, form, set, me?.id))}>
            <Avatar user={assignee} size={14} /> {assignee?.name ?? t('Assignee')}
          </button>
          <button className="chip" onClick={(e) => openMenu(e.currentTarget, labelMenu(meta, form, set))}>
            {form.labelIds.length
              ? form.labelIds.map((id) => meta.labels.find((l) => l.id === id)).map((l) => l && <span key={l.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><span className="dot" style={{ background: l.color }} />{l.name}</span>)
              : <><Icon.label size={13} /> {t('Labels')}</>}
          </button>
          <button className="chip" onClick={(e) => openMenu(e.currentTarget, sprintMenu(sprints, form, set))}>
            <Icon.sprint size={13} /> {sprints.find((s) => s.id === form.sprintId)?.name ?? t('Sprint')}
          </button>
        </div>
        <div className="foot">
          <span className="spacer" />
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={analyze} onChange={(e) => setAnalyze(e.target.checked)} /> {t('Request AI analysis')}
          </label>
          <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }} title={t('Keeps this window open after creating, so you can add several issues in a row')}>
            <input type="checkbox" checked={another} onChange={(e) => setAnother(e.target.checked)} /> {t('Create another')}
          </label>
          <button className="btn primary" disabled={!title.trim() || create.isPending} onClick={() => void submit()}>
            {t('Create issue')} <span className="kbd" style={{ background: 'transparent', color: '#fff', borderColor: 'rgb(255 255 255 / 0.3)' }}>↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
