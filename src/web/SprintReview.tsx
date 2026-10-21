import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useIssues, useMeta, useSprints, useUpdateIssue, type IssueRow, type Meta, type Sprint } from './api.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { linkProps } from './router.ts';
import { openMenu, Tooltip } from './menu.tsx';
import { sprintLabel } from './pickers.tsx';
import { toast } from './toast.ts';
import { InlineCode } from './InlineCode.tsx';
import { ident } from './project.ts';
import { t, tn } from './i18n.ts';

/**
 * Spotkanie co X dni: co zrobiliśmy (z opisem HUMAN), co przerzucamy, co planujemy.
 * Domyślnie pokazuje sprint czekający na przegląd, a jak go nie ma, bieżący.
 */
export function SprintReview() {
  const meta = useMeta().data;
  const issues = useIssues().data;
  const data = useSprints().data;
  const qc = useQueryClient();
  const update = useUpdateIssue();
  const sprints = data?.sprints ?? [];
  const defaultSprint = sprints.find((s) => s.status === 'ended') ?? sprints.find((s) => s.status === 'active');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const sprint = sprints.find((s) => s.id === selectedId) ?? defaultSprint;
  const next = sprint ? sprints.filter((s) => s.startsAt > sprint.startsAt && (s.status === 'planned' || s.status === 'active'))[0] : undefined;
  const [notes, setNotes] = useState('');
  useEffect(() => setNotes(sprint?.reviewNotes ?? ''), [sprint?.id, sprint?.reviewNotes]);

  const typeOf = useMemo(() => new Map((meta?.statuses ?? []).map((s) => [s.id, s.type])), [meta]);
  if (!meta || !issues || !sprint) return <div className="review" />;

  const inSprint = issues.filter((i) => i.sprintId === sprint.id && !i.parentId);
  // "Co zrobiliśmy": wszystko ukończone w czasie sprintu, także bez przypisania do niego.
  const inWindow = (d: string | null) => !!d && d >= sprint.startsAt && d < sprint.endsAt;
  const done = issues.filter((i) => !i.parentId && typeOf.get(i.statusId) === 'completed' && (i.sprintId === sprint.id || inWindow(i.completedAt)))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  const open = inSprint.filter((i) => ['backlog', 'unstarted', 'started'].includes(typeOf.get(i.statusId)!));
  const planned = next ? issues.filter((i) => i.sprintId === next.id && !i.parentId) : [];
  const stale = issues.filter((i) => !i.parentId && ['backlog', 'unstarted', 'started'].includes(typeOf.get(i.statusId)!) && Date.now() - new Date(i.updatedAt).getTime() > 14 * 864e5)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const candidates = issues.filter((i) => i.sprintId == null && !i.parentId && ['backlog', 'unstarted', 'started'].includes(typeOf.get(i.statusId)!));

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['issues'] }); void qc.invalidateQueries({ queryKey: ['sprints'] }); };
  const carry = async (numbers?: number[]) => {
    const r = await api<{ moved: number; to: string }>(`/api/sprints/${sprint.id}/carry-over`, { method: 'POST', body: { numbers } });
    toast(tn(r.moved, 'Moved {n} issue to {to}', 'Moved {n} issues to {to}', { to: r.to }));
    refresh();
  };
  const saveNotes = async () => {
    if (notes === sprint.reviewNotes) return;
    await api(`/api/sprints/${sprint.id}`, { method: 'PATCH', body: { reviewNotes: notes } });
    refresh();
  };
  const closeReview = async () => {
    await saveNotes();
    await api(`/api/sprints/${sprint.id}/close-review`, { method: 'POST' });
    toast(t('{name} reviewed', { name: sprint.name }));
    setSelectedId(null);
    refresh();
  };

  /**
   * Podsumowanie "sprytne": liczby, potem zmiany pogrupowane po etykiecie z pól HUMAN
   * (pierwsza linia każdej zmiany), zadania bez HUMAN tylko tytułem. Mieści się w limicie Discorda.
   */
  const copySummary = async () => {
    const f = (d: string) => new Date(d).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short' });
    const details = await Promise.all(done.map((i) => api<{ changeHuman: string }>(`/api/issues/${ident(i.number)}`)));
    const groups = new Map<string, string[]>();
    const noNotes: string[] = [];
    done.forEach((i, idx) => {
      const lines = details[idx].changeHuman.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { noNotes.push(`${ident(i.number)} ${i.title}`); return; }
      const label = meta.labels.find((l) => l.id === i.labelIds[0])?.name ?? 'Inne';
      groups.set(label, [...(groups.get(label) ?? []), ...lines.map((l, n) => (n === 0 ? `${l} (${ident(i.number)})` : l))]);
    });
    const people = new Map<string, number>();
    for (const i of done) { const n = meta.users.find((u) => u.id === i.assigneeId)?.name; if (n) people.set(n, (people.get(n) ?? 0) + 1); }
    const out = [
      `**${sprint.name}** (${f(sprint.startsAt)} – ${f(sprint.endsAt)})`,
      `✅ ${done.length} zrobione · ↪️ ${open.length} do przeniesienia · 🗓️ ${planned.length} zaplanowane`,
      people.size ? `👥 ${[...people].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(', ')}` : null,
      ...[...groups].sort((a, b) => b[1].length - a[1].length).flatMap(([label, lines]) => ['', `**${label}**`, ...lines.map((l) => `• ${l}`)]),
      noNotes.length ? `\n_Bez opisu HUMAN:_ ${noNotes.join('; ')}` : null,
      notes.trim() ? `\n**Notatki ze spotkania**\n${notes.trim()}` : null,
    ].filter((l) => l !== null).join('\n');
    const text = out.length > 1950 ? out.slice(0, 1940) + '\n…' : out;
    await navigator.clipboard.writeText(text);
    toast(out.length > 1950 ? t('Summary copied (cut to Discord limit)') : t('Summary copied, paste it on Discord'));
  };

  const closeBlock = sprint.status !== 'ended'
    ? sprint.status === 'active' ? t('The sprint is still running. You can close the review after it ends.') : t('This sprint was already reviewed')
    : open.length ? tn(open.length, 'Carry over or finish the {n} open issue first', 'Carry over or finish the {n} open issues first') : null;

  return (
    <div className="review" data-tour="review">
      <div className="review-head">
        <button className="chip on" onClick={(e) => openMenu(e.currentTarget, {
          searchable: false,
          items: [...sprints].reverse().filter((s) => s.status !== 'planned').map((s) => ({
            key: String(s.id), label: `${sprintLabel(s)} · ${t(s.status)}`, checked: s.id === sprint.id, onSelect: () => setSelectedId(s.id),
          })),
        })}>
          <Icon.sprint size={13} /> {sprintLabel(sprint)} <Icon.chevron size={12} />
        </button>
        <SprintStatus sprint={sprint} />
        <span className="spacer" />
        <button className="btn" onClick={() => void copySummary()}><Icon.copy size={13} /> {t('Summary for Discord')}</button>
        <Tooltip text={closeBlock}>
          <button className="btn primary" disabled={!!closeBlock} onClick={() => void closeReview()}><Icon.check size={14} /> {t('Close review')}</button>
        </Tooltip>
      </div>

      <div className="review-grid">
        <div className="review-col">
          <h3><StatusIcon status={{ type: 'completed', color: 'var(--accent)' }} /> {t('Done')} <span className="n">{done.length}</span></h3>
          {done.map((i) => <ReviewCard key={i.id} issue={i} meta={meta} showHuman />)}
          {!done.length && <div className="hint" style={{ padding: 8 }}>{t('Nothing finished in this sprint yet.')}</div>}
        </div>

        <div className="review-col">
          <h3>
            <StatusIcon status={{ type: 'started', color: 'var(--progress)' }} /> {t('Not finished')} <span className="n">{open.length}</span>
            {open.length > 0 && (
              <Tooltip text={next ? null : t('There is no next sprint yet')}>
                <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={!next} onClick={() => void carry()}>{t('Carry over all')}</button>
              </Tooltip>
            )}
          </h3>
          {open.map((i) => (
            <ReviewCard key={i.id} issue={i} meta={meta} action={next && (
              <button className="btn sm" onClick={() => void carry([i.number])}>{t('Carry over')} →</button>
            )} />
          ))}
          {!open.length && <div className="hint" style={{ padding: 8 }}>{t('No open issues left.')}</div>}
        </div>

        <div className="review-col">
          <h3>
            <Icon.sprint size={14} /> {t('Planned for {name}', { name: next?.name ?? t('next sprint') })} <span className="n">{planned.length}</span>
            {next && (
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={(e) => openMenu(e.currentTarget, {
                searchable: true, placeholder: t('Add issues to the next sprint…'),
                items: candidates.sort((a, b) => b.number - a.number).map((i) => ({
                  key: String(i.number), label: `${ident(i.number)} ${i.title}`, keepOpen: true,
                  icon: <PriorityIcon priority={i.priority} />,
                  onSelect: () => update.mutate({ number: i.number, patch: { sprintId: next.id } }),
                })),
              })}><Icon.plus size={13} /> {t('Add')}</button>
            )}
          </h3>
          {planned.map((i) => (
            <ReviewCard key={i.id} issue={i} meta={meta} action={
              <button className="icon-btn" title={t('Remove from sprint')} onClick={() => update.mutate({ number: i.number, patch: { sprintId: null } })}><Icon.close size={13} /></button>
            } />
          ))}
          {!planned.length && <div className="hint" style={{ padding: 8 }}>{t('Add issues from Todo or Backlog.')}</div>}
        </div>
      </div>

      {stale.length > 0 && (
        <div className="section">
          <div className="section-head">{t('Untouched for 14+ days')} <span className="hint">{stale.length} · {t('close, move or delete?')}</span></div>
          <div className="stale-list">
            {stale.map((i) => (
              <a key={i.id} className="sub-row" {...linkProps(`/issue/${ident(i.number)}`)}>
                <StatusIcon status={meta.statuses.find((s) => s.id === i.statusId)!} fraction={startedFraction(meta.statuses, meta.statuses.find((s) => s.id === i.statusId)!)} />
                <span className="id">{ident(i.number)}</span>
                <span className="t"><InlineCode text={i.title} /></span>
                <span className="hint">{tn(Math.floor((Date.now() - new Date(i.updatedAt).getTime()) / 864e5), '{n} day', '{n} days')}</span>
                <Avatar user={meta.users.find((u) => u.id === i.assigneeId)} size={18} />
              </a>
            ))}
          </div>
        </div>
      )}

      <div className="section review-notes">
        <div className="section-head">{t('Meeting notes')}</div>
        <textarea className="md-edit" placeholder={t('Decisions, blockers, who does what…')} value={notes}
          onChange={(e) => setNotes(e.target.value)} onBlur={() => void saveNotes()} onKeyDown={(e) => e.stopPropagation()} />
      </div>
    </div>
  );
}

function SprintStatus({ sprint }: { sprint: Sprint }) {
  const days = Math.ceil((new Date(sprint.endsAt).getTime() - Date.now()) / 864e5);
  const map = {
    active: { text: tn(days, 'Active · {n} day left', 'Active · {n} days left'), color: 'var(--progress-text)' },
    ended: { text: t('Ended · waiting for review'), color: 'var(--warning-text)' },
    reviewed: { text: t('Reviewed'), color: 'var(--success-text)' },
    planned: { text: t('Planned'), color: 'var(--text-tertiary)' },
  }[sprint.status];
  return <span className="pill" style={{ color: map.color, borderColor: 'currentColor' }}>{map.text}</span>;
}

function ReviewCard({ issue, meta, showHuman, action }: { issue: IssueRow; meta: Meta; showHuman?: boolean; action?: React.ReactNode }) {
  const st = meta.statuses.find((s) => s.id === issue.statusId)!;
  const [human, setHuman] = useState<string | null>(null);
  // HUMAN nie jest w lekkiej liście, więc dociągamy go tylko dla zrobionych.
  useEffect(() => {
    if (!showHuman) return;
    void api<{ changeHuman: string }>(`/api/issues/${ident(issue.number)}`).then((d) => setHuman(d.changeHuman));
  }, [showHuman, issue.number, issue.updatedAt]);
  return (
    <div className="review-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} />
        <span className="card-id">{ident(issue.number)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {action}
          <Avatar user={meta.users.find((u) => u.id === issue.assigneeId)} size={18} />
        </span>
      </div>
      <a {...linkProps(`/issue/${ident(issue.number)}`)} className="card-title" style={{ display: 'block' }}><InlineCode text={issue.title} /></a>
      {showHuman && human != null && (human.trim() ? <div className="human">{human}</div> : <div className="hint" style={{ marginTop: 6 }}>{t('No HUMAN summary')}</div>)}
    </div>
  );
}
