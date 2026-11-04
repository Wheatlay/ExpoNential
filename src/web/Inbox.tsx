import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, pollAlertKey, useInbox, useMeta, useNotifySettings, type InboxItem } from './api.ts';
import { Avatar, Icon } from './icons.tsx';
import { addDismissed, useMeetingAlerts } from './Notifications.tsx';
import { fmtTime, openMeeting } from './Meetings.tsx';
import { navigate } from './router.ts';
import { fmtDate, timeAgo } from './time.ts';
import { ErrorState } from './states.tsx';
import { t } from './i18n.ts';

const DAY = 86_400_000;
/** Świeże: czas względny; starsze niż ~2 dni: dd.mm.rrrr (data zawsze w tym formacie). */
function when(iso: string) {
  const d = new Date(iso);
  return Date.now() - d.getTime() < 2 * DAY ? timeAgo(iso) : fmtDate(iso);
}

/** Dzwonek w nagłówku: skrzynka "Do ciebie" (wzmianki, tagi, pytania) plus to, co czeka z kalendarza (ankiety, spotkania). */
export function InboxBell() {
  const qc = useQueryClient();
  const inboxQ = useInbox();
  const inbox = inboxQ.data ?? [];
  const meta = useMeta().data;
  const settings = useNotifySettings().data;
  const { now, soon, polls } = useMeetingAlerts();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 8, top: 0 });
  const sheet = window.innerWidth <= 760;

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const el = e.target as Node;
      if (!panel.current?.contains(el) && !btn.current?.contains(el)) setOpen(false);
    };
    // Capture + stop: Escape zamyka tylko dzwonek, a nie też stronę issue pod nim.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [open]);

  // Pod dzwonkiem, wyrównany do jego prawej krawędzi, w granicach okna.
  useLayoutEffect(() => {
    if (!open || sheet || !btn.current || !panel.current) return;
    const b = btn.current.getBoundingClientRect();
    const w = panel.current.getBoundingClientRect().width;
    setPos({ left: Math.max(8, Math.min(b.right - w, window.innerWidth - w - 8)), top: b.bottom + 6 });
  }, [open, sheet]);

  const unread = inbox.filter((i) => !i.readAt).length;
  const count = unread + soon.length + polls.length;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['inbox'] });
  const markRead = (ids?: number[]) => api('/api/inbox/read', { method: 'POST', body: ids ? { ids } : {} }).then(refresh);
  const remove = (id: number) => api(`/api/inbox/${id}`, { method: 'DELETE' }).then(refresh);
  const goto = (i: InboxItem) => {
    setOpen(false);
    if (!i.readAt) void markRead([i.id]);
    navigate(`/issue/${i.projectKey}-${i.issueNumber}`);
  };

  const title = (i: InboxItem) => {
    const name = i.actorName ?? t('Someone');
    if (i.kind === 'question') return i.tagName ? t('{name} asks #{tag}', { name, tag: i.tagName }) : t('{name} asks you', { name });
    if (i.kind === 'tag') {
      const tag = meta?.tags?.find((x) => x.name === i.tagName);
      return <>{t('{name} mentioned', { name })} <span className="inbox-tag" style={tag ? { '--tag': `var(--tag-${tag.color})` } as React.CSSProperties : undefined}>#{i.tagName}</span></>;
    }
    return t('{name} mentioned you', { name });
  };
  const hasAnything = inbox.length > 0 || soon.length > 0 || polls.length > 0;

  return (
    <>
      <button ref={btn} className="icon-btn inbox-bell" title={t('For you')} aria-label={t('For you')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon.bell size={20} />
        {count > 0 && settings?.inApp !== false && <span className="inbox-badge">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && createPortal(
        <div ref={panel} className={`popover inbox-panel${sheet ? ' sheet' : ''}`} style={sheet ? undefined : pos} role="dialog" aria-label={t('For you')}>
          <div className="inbox-head">
            <b>{t('For you')}</b>
            <button className="btn sm" disabled={unread === 0} onClick={() => void markRead()}>{t('Mark all as read')}</button>
          </div>
          <div className="inbox-list">
            {polls.map((m) => (
              <div key={`p${m.id}`} className="inbox-item unread">
                <button className="inbox-main" onClick={() => { setOpen(false); openMeeting(m.id); }}>
                  <span className="inbox-icon warn"><Icon.calendar size={14} /></span>
                  <span className="inbox-text"><span className="inbox-title">{t('Poll waits for your vote')}</span><span className="hint inbox-sub" title={m.title}>{m.title}</span></span>
                </button>
                <button className="icon-btn inbox-x" aria-label={t('Dismiss')} title={t('Dismiss')} onClick={() => addDismissed(pollAlertKey(m))}><Icon.close size={12} /></button>
              </div>
            ))}
            {soon.map((m) => (
              <div key={`m${m.id}`} className="inbox-item unread">
                <button className="inbox-main" onClick={() => { setOpen(false); openMeeting(m.id); }}>
                  <span className="inbox-icon"><Icon.calendar size={14} /></span>
                  <span className="inbox-text"><span className="inbox-title" title={m.title}>
                    {new Date(m.startsAt!) <= now ? t('{title} is on now', { title: m.title }) : t('{title} starts at {time}', { title: m.title, time: fmtTime(m.startsAt!) })}
                  </span></span>
                </button>
                <button className="icon-btn inbox-x" aria-label={t('Dismiss')} title={t('Dismiss')} onClick={() => addDismissed(`m${m.id}:${m.startsAt}`)}><Icon.close size={12} /></button>
              </div>
            ))}
            {inbox.map((i) => {
              const actor = meta?.users.find((u) => u.id === i.actorId) ?? (i.actorName ? { id: i.actorId ?? 0, name: i.actorName, avatarUrl: null } : null);
              return (
                <div key={i.id} className={`inbox-item${i.readAt ? '' : ' unread'}`}>
                  <button className="inbox-main" onClick={() => goto(i)}>
                    {i.kind === 'question' ? <span className="inbox-icon warn"><Icon.question size={14} /></span> : <Avatar user={actor} size={24} />}
                    <span className="inbox-text">
                      <span className="inbox-title">{title(i)}</span>
                      <span className="hint inbox-sub">{i.projectKey}-{i.issueNumber} · “{i.excerpt}”</span>
                    </span>
                    <span className="hint inbox-when">{when(i.createdAt)}</span>
                    {!i.readAt && <span className="inbox-dot" aria-label={t('Unread')} />}
                  </button>
                  <button className="icon-btn inbox-x" aria-label={t('Dismiss')} title={t('Dismiss')} onClick={() => void remove(i.id)}><Icon.close size={12} /></button>
                </div>
              );
            })}
            {!hasAnything && inboxQ.isError && <ErrorState error={inboxQ.error} onRetry={() => void inboxQ.refetch()} />}
            {!hasAnything && !inboxQ.isError && <div className="inbox-empty hint">{t('Nothing for you right now. Mentions and questions will show up here.')}</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
