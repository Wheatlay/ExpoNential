import { useState, useSyncExternalStore } from 'react';
import { useMe, useMeta, useUpdateIssue, type IssuePatch } from './api.ts';
import { Avatar, Icon } from './icons.tsx';
import { enterToSubmit } from './keys.ts';
import { ident } from './project.ts';
import { CurrentProjectBadge } from './ProjectSwitcher.tsx';
import { t } from './i18n.ts';

/**
 * Wejście w Need Info: zamiast samego statusu pytamy, kogo i o co.
 * Pytanie trafia na kartę (plakietka) i jako komentarz; pytana osoba widzi je w sidebarze.
 */
type Ask = { number: number; statusId: number; extra?: IssuePatch };
let current: Ask | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openAsk(a: Ask) { current = a; emit(); }
function close() { current = null; emit(); }

export function AskHost() {
  const a = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => current);
  return a ? <AskModal ask={a} /> : null;
}

function AskModal({ ask }: { ask: Ask }) {
  const meta = useMeta().data;
  const me = useMe().data;
  const update = useUpdateIssue();
  const [who, setWho] = useState<number | 'anyone' | null>(null);
  const [q, setQ] = useState('');
  if (!meta) return null;
  const people = meta.users.filter((u) => u.active && u.id !== me?.id);
  const send = () => {
    if (!who || !q.trim()) return;
    update.mutate({ number: ask.number, patch: { ...ask.extra, statusId: ask.statusId, infoFromId: who === 'anyone' ? null : who, infoQuestion: q } });
    close();
  };
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal ask" onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
      }}>
        <div className="crumbs"><CurrentProjectBadge /> {ident(ask.number)} <Icon.chevronRight size={12} /> {t('Need info')}</div>
        <div className="ask-title">{t('Who should answer?')}</div>
        <div className="ask-people">
          <button className={`ask-person ${who === 'anyone' ? 'on' : ''}`} onClick={() => setWho('anyone')}>
            <span className="avatar" style={{ width: 22, height: 22, background: 'var(--bg-active)', color: 'var(--text-secondary)' }}><Icon.user size={13} /></span> {t('Anyone')}
          </button>
          {people.map((u) => (
            <button key={u.id} className={`ask-person ${who === u.id ? 'on' : ''}`} onClick={() => setWho(u.id)}>
              <Avatar user={u} size={22} /> {u.name}
            </button>
          ))}
        </div>
        <textarea autoFocus placeholder={t('What do you need to know? (Enter to ask, Alt+Enter new line)')} value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); enterToSubmit(e, send, setQ); }} />
        <div className="foot">
          <span className="hint">{t('The question is added as a comment and highlighted for that person.')}</span>
          <span className="spacer" />
          <button className="btn" onClick={close}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!who || !q.trim()} onClick={send}>{t('Ask')} <span className="kbd" style={{ background: 'transparent', color: '#fff', borderColor: 'rgb(255 255 255 / 0.3)' }}>↵</span></button>
        </div>
      </div>
    </div>
  );
}
