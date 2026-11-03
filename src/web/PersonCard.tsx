import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useIssues, useMe, useMeta } from './api.ts';
import { Avatar, Icon } from './icons.tsx';
import { openMenu } from './menu.tsx';
import { IssueMention } from './Markdown.tsx';
import { requestAssigneeFilter } from './Board.tsx';
import { usePresenceInfo } from './online.ts';
import { navigate, usePath } from './router.ts';
import { ident } from './project.ts';
import { timeAgo } from './time.ts';
import { copyText } from './toast.ts';
import { t } from './i18n.ts';

type Anchor = HTMLElement | { x: number; y: number };
type State = { userId: number; anchor: Anchor; id: number } | null;

let state: State = null;
let seq = 0;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openPersonCard(userId: number, anchor: Anchor) {
  state = { userId, anchor, id: ++seq };
  emit();
}

export function closePersonCard() {
  if (!state) return;
  state = null;
  emit();
}

/** Prawy przycisk na awatarze/osobie: menu Profile + Copy @login (stopPropagation, żeby nie otwierało menu karty). */
export function profileContextMenu(user: { id: number; login?: string } | null | undefined) {
  return (e: React.MouseEvent) => {
    if (!user) return;
    e.preventDefault(); e.stopPropagation();
    const at = { x: e.clientX, y: e.clientY };
    openMenu(at, { searchable: false, items: [
      { key: 'profile', label: t('Profile'), icon: <Icon.user size={14} />, onSelect: () => openPersonCard(user.id, at) },
      ...(user.login ? [{ key: 'copy', label: t('Copy @login'), icon: <Icon.copy size={14} />, onSelect: () => copyText(`@${user.login}`, t('Copied')) }] : []),
    ] });
  };
}

/** Klikalna osoba (awatar lub imię): otwiera kartę; układ bez zmian, tylko podkreślenie imienia po najechaniu. */
export function PersonLink({ userId, children, className = '' }: { userId: number | null | undefined; children: React.ReactNode; className?: string }) {
  const known = useMeta().data?.users.some((u) => u.id === userId);
  // Osoba spoza bieżącego projektu (np. konto w Workspace) nie ma karty: zostaje zwykły tekst.
  if (userId == null || !known) return <>{children}</>;
  return <button type="button" className={`person-link ${className}`} onClick={(e) => { e.stopPropagation(); openPersonCard(userId, e.currentTarget); }}>{children}</button>;
}

function useCardState() {
  return useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => state);
}

export function PersonCardHost() {
  const s = useCardState();
  if (!s) return null;
  return createPortal(<Card key={s.id} userId={s.userId} anchor={s.anchor} />, document.body);
}

function Card({ userId, anchor }: { userId: number; anchor: Anchor }) {
  const meta = useMeta().data;
  const issues = useIssues().data ?? [];
  const me = useMe().data;
  const presence = usePresenceInfo(userId);
  const ref = useRef<HTMLDivElement>(null);
  const path = usePath();
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const sheet = window.innerWidth <= 760;
  const user = meta?.users.find((u) => u.id === userId);

  // Zamknięcie: klik poza kartą (menu aplikacji to też .popover), Escape, zmiana strony.
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!ref.current?.contains(el) && !el.closest?.('.popover')) closePersonCard();
    };
    // Capture + stop: Escape zamyka tylko kartę, a nie też stronę issue pod nią (ta wraca wtedy na tablicę).
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); closePersonCard(); } };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, []);
  const firstPath = useRef(path);
  useEffect(() => { if (path !== firstPath.current) closePersonCard(); }, [path]);

  // Pod kotwicą; bez miejsca na dole przeskakuje nad nią. Zawsze w granicach okna.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || sheet) return;
    const a = anchor instanceof HTMLElement
      ? (() => { const r = anchor.getBoundingClientRect(); return { x: r.left, top: r.bottom + 6, bottom: r.top - 6 }; })()
      : { x: anchor.x, top: anchor.y + 4, bottom: anchor.y - 4 };
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.x, window.innerWidth - r.width - 8));
    const top = a.top + r.height > window.innerHeight - 8 ? Math.max(8, a.bottom - r.height) : a.top;
    setPos({ left, top });
  }, [anchor, sheet, user, issues.length]);

  if (!user || !meta) return null;
  const tags = (meta.tags ?? []).filter((x) => x.memberIds.includes(user.id));
  const mine = issues.filter((i) => i.assigneeId === user.id && !i.completedAt);
  const started = mine
    .filter((i) => meta.statuses.find((s) => s.id === i.statusId)?.type === 'started')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 2);
  const roleLabel = user.role === 'admin' ? t('Project admin') : t('Member');

  return (
    <div ref={ref} className={`popover person-card${sheet ? ' sheet' : ''}`} style={sheet ? undefined : pos} role="dialog" aria-label={user.name}>
      <div className="pc-head">
        <Avatar user={user} size={40} />
        <div className="pc-who">
          <div className="pc-name">{user.name}</div>
          <div className="hint">@{user.login}</div>
        </div>
      </div>
      {presence.state && (
        <div className={`pc-presence ${presence.state}`}>
          <span className="dot" />
          {presence.state === 'online' ? t('online') : presence.state === 'recent' ? t('active recently') : t('last seen {time}', { time: timeAgo(presence.lastSeen!) })}
        </div>
      )}
      <div className="pc-pills">
        <span className={`pill${user.role === 'admin' ? ' role-admin' : ''}`}>{roleLabel}</span>
        {user.isAdmin && <span className="pill role-admin">{t('Workspace admin')}</span>}
        {tags.map((x) => (
          <span key={x.id} className="pill tag-pill" style={{ '--tag': `var(--tag-${x.color})` } as React.CSSProperties}><span className="dot" />#{x.name}</span>
        ))}
      </div>
      <div className="pc-sec">
        <div className="pc-label">{t('Working on')}</div>
        {started.length
          ? started.map((i) => <div key={i.id}><IssueMention id={ident(i.number)} /></div>)
          : <div className="hint">{t('Nothing in progress')}</div>}
      </div>
      <div className="pc-actions">
        <button className="btn sm primary" onClick={() => { closePersonCard(); navigate('/'); requestAssigneeFilter(user.id); }}>
          {t('Issues of this person ({n})', { n: mine.length })}
        </button>
        <button className="btn sm" onClick={() => { copyText(`@${user.login}`, t('Copied')); closePersonCard(); }}>{t('Copy @login')}</button>
      </div>
    </div>
  );
}
