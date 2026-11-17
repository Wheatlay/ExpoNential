import { useState, useSyncExternalStore } from 'react';
import { useModal } from './modal.ts';
import { useIssues, useMeta, useUpdateIssue, type IssuePatch } from './api.ts';
import { Icon } from './icons.tsx';
import { enterToSubmit } from './keys.ts';
import { ident } from './project.ts';
import { CurrentProjectBadge } from './ProjectSwitcher.tsx';
import { openMenu } from './menu.tsx';
import { issueStatusIcon } from './pickers.tsx';
import { t } from './i18n.ts';

/**
 * Wejście w Paused: zamiast samego statusu pytamy o powód albo zgłoszenie, na które zadanie czeka (wystarczy jedno).
 * Powód trafia na kartę (plakietka) i jako komentarz; bloker staje się relacją "czeka na".
 */
type Pause = { number: number; statusId: number; extra?: IssuePatch };
let current: Pause | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openPause(p: Pause) { current = p; emit(); }
function close() { current = null; emit(); }

export function PauseHost() {
  const p = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => current);
  return p ? <PauseModal pause={p} /> : null;
}

function PauseModal({ pause }: { pause: Pause }) {
  const meta = useMeta().data;
  const all = useIssues().data ?? [];
  const update = useUpdateIssue();
  const [reason, setReason] = useState('');
  const [waitsOn, setWaitsOn] = useState<number | null>(null);
  const modalRef = useModal();
  if (!meta) return null;
  const statusName = meta.statuses.find((s) => s.id === pause.statusId)?.name ?? t('Paused');
  const canSend = !!reason.trim() || waitsOn != null;
  const send = () => {
    if (!canSend) return;
    update.mutate({ number: pause.number, patch: { ...pause.extra, statusId: pause.statusId, pauseReason: reason.trim(), pauseWaitsOn: waitsOn ?? undefined } });
    close();
  };
  const pickIssue = (el: HTMLElement) => openMenu(el, {
    searchable: true,
    placeholder: t('{id} waits on…', { id: ident(pause.number) }),
    items: all.filter((i) => i.number !== pause.number).sort((a, b) => b.number - a.number).map((i) => ({
      key: `p${i.number}`,
      label: `${ident(i.number)} ${i.title}`,
      icon: issueStatusIcon(meta.statuses, i.statusId),
      onSelect: () => setWaitsOn(i.number),
    })),
  });
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal ask" role="dialog" aria-modal="true" aria-label={statusName} ref={modalRef} tabIndex={-1} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
      }}>
        <div className="crumbs"><CurrentProjectBadge /> {ident(pause.number)} <Icon.chevronRight size={12} /> {statusName}</div>
        <textarea autoFocus placeholder={t('Why is it paused?')} value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); enterToSubmit(e, send, setReason); }} />
        <div className="foot">
          {waitsOn != null
            ? (
              <span className="pill rel blocked" title={t('Waiting on {ids}', { ids: ident(waitsOn) })}>
                <Icon.blocked size={12} /> {t('Waiting on {ids}', { ids: ident(waitsOn) })}
                <button className="rel-x" aria-label={t('Remove relation')} title={t('Remove relation')} onClick={() => setWaitsOn(null)}><Icon.close size={11} /></button>
              </span>
            )
            : <button className="btn" onClick={(e) => pickIssue(e.currentTarget)}><Icon.blocked size={14} /> {t('Waiting on…')}</button>}
          <span className="spacer" />
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!canSend} onClick={send}>{t('Pause')} <span className="kbd">↵</span></button>
        </div>
      </div>
    </div>
  );
}
