import type { Status, User } from './api.ts';
import { useOnlineStatus } from './online.ts';
import { t } from './i18n.ts';

type P = { size?: number; className?: string };

/**
 * Ikona statusu jak w Linearze: przerywany okrąg (backlog), pusty (todo), wycinek koła
 * (started, wypełnienie wg kolejności), pełny z ptaszkiem (done), z krzyżykiem (canceled).
 */
export function StatusIcon({ status, fraction = 0.5, size = 14 }: { status: Pick<Status, 'type' | 'color'>; fraction?: number; size?: number }) {
  const c = status.color;
  const s = size;
  if (status.type === 'backlog') {
    return (
      <svg className="i" width={s} height={s} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="1.4 1.71" />
      </svg>
    );
  }
  if (status.type === 'unstarted') {
    return (
      <svg className="i" width={s} height={s} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" />
      </svg>
    );
  }
  if (status.type === 'started') {
    const r = 3;
    const circ = 2 * Math.PI * r;
    return (
      <svg className="i" width={s} height={s} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="6" fill="none" stroke={c} strokeWidth="1.5" />
        <circle cx="7" cy="7" r={r} fill="none" stroke={c} strokeWidth="6" strokeDasharray={`${circ * fraction} ${circ}`} transform="rotate(-90 7 7)" />
      </svg>
    );
  }
  if (status.type === 'completed') {
    return (
      <svg className="i" width={s} height={s} viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="7" fill={c} />
        <path d="M4.2 7.2l1.9 1.9 3.8-3.9" stroke="var(--bg-primary)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg className="i" width={s} height={s} viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="7" fill={c} />
      <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke="var(--bg-primary)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Ułamek wypełnienia dla statusów "started" wg ich kolejności (jak żółty/niebieski/zielony w Linearze). */
export function startedFraction(statuses: Status[], s: Status) {
  const started = statuses.filter((x) => x.type === 'started');
  const i = started.findIndex((x) => x.id === s.id);
  if (i < 0) return 0.5;
  return (i + 1) / (started.length + 1);
}

export const PRIORITY_COLORS = ['var(--text-tertiary)', 'var(--warning)', 'var(--danger)', 'var(--progress)', 'var(--accent)'];

export function PriorityIcon({ priority, size = 14, colored = true }: { priority: number; size?: number; colored?: boolean }) {
  if (priority === 0) {
    return (
      <svg className="i" width={size} height={size} viewBox="0 0 16 16" fill="var(--text-tertiary)">
        <rect x="1.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9" /><rect x="6.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9" /><rect x="11.5" y="7.25" width="3" height="1.5" rx=".5" opacity=".9" />
      </svg>
    );
  }
  if (priority === 1) {
    return (
      <svg className="i" width={size} height={size} viewBox="0 0 16 16">
        <rect x="1" y="1" width="14" height="14" rx="3" fill={colored ? 'var(--warning)' : 'var(--text-tertiary)'} />
        <path d="M8 4v5M8 11.2v.3" stroke="var(--bg-primary)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  // high=3 kreski, medium=2, low=1, nieaktywne przygaszone
  const bars = 5 - priority;
  const color = colored ? PRIORITY_COLORS[priority] : 'var(--text-secondary)';
  return (
    <svg className="i" width={size} height={size} viewBox="0 0 16 16">
      {[0, 1, 2].map((b) => (
        <rect key={b} x={1.5 + b * 5} y={10 - b * 4 + 0} width="3" height={4 + b * 4} rx="1" fill={b < bars ? color : 'var(--text-quaternary)'} opacity={b < bars ? 1 : 0.5} />
      ))}
    </svg>
  );
}

const AVATAR_COLORS = ['#e5484d', '#0d9488', '#7c3aed', '#d97706', '#2563eb', '#db2777', '#059669', '#9333ea'];
export const avatarColor = (id: number) => AVATAR_COLORS[id % AVATAR_COLORS.length];

export function Avatar({ user, size = 18 }: { user: Pick<User, 'name' | 'avatarUrl' | 'id'> | null | undefined; size?: number }) {
  if (!user) {
    return (
      <span className="avatar empty" style={{ width: size, height: size }}>
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 16 16" fill="var(--text-quaternary)"><circle cx="8" cy="5.5" r="3" /><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5z" /></svg>
      </span>
    );
  }
  return <UserAvatar user={user} size={size} />;
}

/** Avatar z kropką obecności: zielona = ma otwarty tracker, żółta = był w ostatnich 15 minutach. */
function UserAvatar({ user, size }: { user: Pick<User, 'name' | 'avatarUrl' | 'id'>; size: number }) {
  const status = useOnlineStatus(user.id);
  const initials = user.name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
  const label = status === 'online' ? ` · ${t('online')}` : status === 'recent' ? ` · ${t('active recently')}` : '';
  return (
    <span className="avatar-wrap" style={{ width: size, height: size }}>
      <span className="avatar" title={user.name + label} style={{ width: size, height: size, fontSize: size * 0.42, background: AVATAR_COLORS[user.id % AVATAR_COLORS.length] }}>
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : initials}
      </span>
      {status && size >= 16 && <span className={`presence-dot ${status}`} />}
    </span>
  );
}

const path = (d: string, p: P, fill = false) => (
  <svg className={`i ${p.className ?? ''}`} width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const Icon = {
  plus: (p: P = {}) => path('M8 3v10M3 8h10', p),
  dots: (p: P = {}) => (
    <svg className="i" width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" /></svg>
  ),
  search: (p: P = {}) => path('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5', p),
  edit: (p: P = {}) => path('M11.5 2.5l2 2L6 12H4v-2zM2 14h12', p),
  board: (p: P = {}) => path('M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z', p),
  calendar: (p: P = {}) => path('M3 4.5h10v9H3zM3 7.5h10M5.5 2.5v3M10.5 2.5v3', p),
  bell: (p: P = {}) => path('M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0', p),
  sprint: (p: P = {}) => path('M8 2.5a5.5 5.5 0 1 0 5.5 5.5M8 5v3l2 1.5M11 2.5h3v3', p),
  settings: (p: P = {}) => path('M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM13 8l1.3-1-1.2-2.1-1.6.4-1.1-.7L10 3H7.6l-.4 1.6-1.1.7-1.6-.4L3.3 7 4.6 8l-1.3 1 1.2 2.1 1.6-.4 1.1.7L7.6 13H10l.4-1.6 1.1-.7 1.6.4 1.2-2.1z', p),
  user: (p: P = {}) => path('M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.5-2.8 2.5-4.5 5-4.5s4.5 1.7 5 4.5', p),
  label: (p: P = {}) => path('M2.5 4.5v-2h5l6 6-5 5-6-6v-3zM5 5h.01', p),
  filter: (p: P = {}) => path('M2.5 4h11M4.5 8h7M6.5 12h3', p),
  display: (p: P = {}) => path('M3 4.5h6M11 4.5h2M3 11.5h2M7 11.5h6M10 3v3M6 10v3', p),
  chevron: (p: P = {}) => path('M4.5 6l3.5 3.5L11.5 6', p),
  chevronRight: (p: P = {}) => path('M6 4.5L9.5 8 6 11.5', p),
  caret: (p: P = {}) => (
    <svg className={`i ${p.className ?? ''}`} width={p.size ?? 10} height={p.size ?? 10} viewBox="0 0 10 10" fill="currentColor"><path d="M2 3.5h6L5 7z" /></svg>
  ),
  close: (p: P = {}) => path('M4 4l8 8M12 4l-8 8', p),
  check: (p: P = {}) => path('M3.5 8.5l3 3 6-7', p),
  trash: (p: P = {}) => path('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9', p),
  link: (p: P = {}) => path('M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8', p),
  copy: (p: P = {}) => path('M5.5 5.5V3h7.5v7.5h-2.5M3 5.5h7.5V13H3z', p),
  sparkle: (p: P = {}) => path('M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z', p),
  commit: (p: P = {}) => path('M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 8h4M10.5 8h4', p),
  rocket: (p: P = {}) => path('M9.5 2.5c2 0 4 .5 4 .5s.5 2 .5 4L9 12l-3-3zM6 9l-2.5.5L2 12l3-.5M7 10l-.5 2.5L4 14l.5-3M10.5 5.5h.01', p),
  menu: (p: P = {}) => path('M2.5 4h11M2.5 8h11M2.5 12h11', p),
  parent: (p: P = {}) => path('M4 2.5v6a2 2 0 0 0 2 2h6.5M10 8l2.5 2.5L10 13', p),
  moon: (p: P = {}) => path('M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z', p),
  logout: (p: P = {}) => path('M6 13.5H3.5v-11H6M10.5 11l3-3-3-3M13.5 8H6', p),
  arrowUp: (p: P = {}) => path('M8 13V3M4 7l4-4 4 4', p),
  sub: (p: P = {}) => path('M3 3v4.5a2 2 0 0 0 2 2h8M10 7l3 2.5L10 12', p),
  blocked: (p: P = {}) => path('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4', p),
  comment: (p: P = {}) => path('M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z', p),
  expand: (p: P = {}) => path('M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9', p),
  download: (p: P = {}) => path('M8 2.5v8M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11', p),
  cursor: (p: P = {}) => (
    <svg className="i" width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 16 16" fill="currentColor"><path d="M3 2l10 5.2-4.4 1.2L6.6 13z" /></svg>
  ),
  play: (p: P = {}) => path('M5 3.5v9l7.5-4.5z', p),
  question: (p: P = {}) => path('M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM6.3 6.2A1.8 1.8 0 0 1 9.8 6.6c0 1.2-1.8 1.5-1.8 2.6M8 11.2h.01', p),
  relation: (p: P = {}) => path('M6 4H3.5v8H6M10 4h2.5v8H10M5.5 8h5', p),
};

/** Znak Exponential (H1): sylwetka to pole pod krzywą wykładniczą, bez kafla (design system, assets/Logos). */
export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Exponential">
      <path d="M2 30V27.5C13 27.5 22 22 27 3.5C27.5 2 30 2 30 4V30Z" fill="var(--accent)" />
      <path d="M2 27.5C13 27.5 22 22 27 3.5" stroke="var(--accent-hover)" strokeWidth="2" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** Znak GitHuba (wypełniony, kolor z currentColor): linki do repozytorium i logowanie. */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.5c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.3 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.8-3.6 4 .3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 0z" /></svg>
  );
}
