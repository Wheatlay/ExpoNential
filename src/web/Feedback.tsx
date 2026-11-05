import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, useFeedbackInfo, useMe } from './api.ts';
import { Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { useModal } from './modal.ts';
import { toast } from './toast.ts';
import { Attachments, useAttachments } from './ImagePreviews.tsx';
import { enterToSubmit, keyHint } from './keys.ts';
import { t } from './i18n.ts';

/**
 * "Report a bug or idea": okno z nagłówka (i z Ctrl+K). Zgłoszenie trafia jako zadanie do projektu wybranego
 * przez admina workspace; zgłaszający nie musi być jego członkiem i nie dostaje numeru zadania z powrotem.
 */

let isOpen = false;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openFeedback() { isOpen = true; emit(); }
function close() { isOpen = false; emit(); }

/** Powód, dla którego zgłaszanie jest teraz wyłączone (null = działa). */
export function useFeedbackOff() {
  const me = useMe().data;
  const info = useFeedbackInfo().data;
  if (me?.demo) return t('Disabled in the demo');
  if (info && !info.configured) return t('Not set up yet. A workspace admin chooses the project in Settings.');
  return null;
}

export function FeedbackButton() {
  const off = useFeedbackOff();
  return (
    <Tooltip text={off ?? t('Report a bug or idea')}>
      <button className="icon-btn feedback-btn" aria-label={t('Report a bug or idea')} disabled={!!off} onClick={openFeedback}><Icon.flag size={16} /></button>
    </Tooltip>
  );
}

export function FeedbackHost() {
  const open = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => isOpen);
  return open ? <FeedbackModal /> : null;
}

function FeedbackModal() {
  const modalRef = useModal();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const att = useAttachments();

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await api('/api/feedback', {
        method: 'POST',
        body: { kind, title: title.trim(), description: att.withImages(description), page: (location.pathname + location.search).slice(0, 500), client: navigator.userAgent.slice(0, 300) },
      });
      toast(t('Sent. Thanks!'));
      att.clear();
      close();
    } catch (e) {
      // Ustawienie mogło się właśnie zmienić: odśwież stan przycisku.
      void qc.invalidateQueries({ queryKey: ['feedback'] });
      toast(e instanceof Error ? e.message : t('Server error'), 'err');
    } finally { setBusy(false); }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('Report a bug or idea')} ref={modalRef} tabIndex={-1} onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
      }}>
        <div className="crumbs">
          <div className="seg" role="group" aria-label={t('Report a bug or idea')}>
            <button className={kind === 'bug' ? 'on' : ''} aria-pressed={kind === 'bug'} onClick={() => setKind('bug')}>{t('Bug')}</button>
            <button className={kind === 'idea' ? 'on' : ''} aria-pressed={kind === 'idea'} onClick={() => setKind('idea')}>{t('Idea')}</button>
          </div>
        </div>
        <input className="title" autoFocus placeholder={t('Title')} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.altKey && !e.shiftKey) { e.preventDefault(); void submit(); } }} />
        <textarea placeholder={kind === 'bug' ? t('What happens?\nWhat should happen?\nWhere (screen, link, steps)?') : t('What would you like to be able to do?')}
          maxLength={20_000} value={description} onChange={(e) => setDescription(e.target.value)} onPaste={att.onPaste}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); enterToSubmit(e, () => void submit(), setDescription); }} />
        <Attachments urls={att.urls} onRemove={att.remove} />
        <div className="foot">
          {kind === 'bug' ? <span className="hint">{t('Page, browser and app version are attached.')}</span> : <span className="hint">{keyHint('send')}</span>}
          <span className="spacer" />
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!title.trim() || busy} onClick={() => void submit()}>{t('Send')}</button>
        </div>
      </div>
    </div>
  );
}
