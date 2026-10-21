import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useIssues, useMeta } from './api.ts';
import { Icon, StatusIcon, startedFraction } from './icons.tsx';
import { navigate } from './router.ts';
import { openNewIssue } from './NewIssue.tsx';
import { setTheme } from './Settings.tsx';
import { isMenuOpen } from './menu.tsx';
import { ident } from './project.ts';
import { t } from './i18n.ts';

type Cmd = { key: string; group: string; label: string; icon?: ReactNode; kbd?: string[]; run: () => void };

/** Ctrl+K: szukanie zadań po numerze/tytule i szybkie akcje. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const issues = useIssues().data ?? [];
  const meta = useMeta().data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQ(''); setHl(0); return; }
      const el = e.target as HTMLElement;
      if (open || isMenuOpen() || el.closest?.('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'c') { e.preventDefault(); openNewIssue(); }
      if (e.key === '/') { e.preventDefault(); setOpen(true); setQ(''); setHl(0); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { key: 'new', group: t('Actions'), label: t('Create new issue'), icon: <Icon.plus size={14} />, kbd: ['C'], run: () => openNewIssue() },
      { key: 'board', group: t('Navigation'), label: t('Go to board'), icon: <Icon.board size={14} />, run: () => navigate('/') },
      { key: 'review', group: t('Navigation'), label: t('Go to sprint review'), icon: <Icon.sprint size={14} />, run: () => navigate('/review') },
      { key: 'calendar', group: t('Navigation'), label: t('Go to calendar'), icon: <Icon.calendar size={14} />, run: () => navigate('/calendar') },
      { key: 'settings', group: t('Navigation'), label: t('Go to settings'), icon: <Icon.settings size={14} />, run: () => navigate('/settings') },
      { key: 'dark', group: t('Theme'), label: t('Theme: Dark'), icon: <Icon.moon size={14} />, run: () => setTheme('dark') },
      { key: 'oled', group: t('Theme'), label: t('Theme: OLED black'), icon: <Icon.moon size={14} />, run: () => setTheme('oled') },
      { key: 'light', group: t('Theme'), label: t('Theme: Light'), icon: <Icon.moon size={14} />, run: () => setTheme('light') },
    ];
    if (!q.trim()) return base;
    const lq = q.toLowerCase().trim();
    const num = /^(?:[a-z]{2,6}-)?(\d+)$/i.exec(lq)?.[1];
    const found = issues
      .filter((i) => (num ? String(i.number).startsWith(num) : i.title.toLowerCase().includes(lq)))
      .sort((a, b) => (num ? a.number - b.number : b.number - a.number))
      .slice(0, 30)
      .map<Cmd>((i) => {
        const st = meta?.statuses.find((s) => s.id === i.statusId);
        return {
          key: `i${i.number}`, group: t('Issues'), label: `${ident(i.number)}  ${i.title}`,
          icon: st && meta ? <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} /> : undefined,
          run: () => navigate(`/issue/${ident(i.number)}`),
        };
      });
    return [...base.filter((c) => c.label.toLowerCase().includes(lq)), ...found];
  }, [q, issues, meta]);

  if (!open) return null;
  const close = () => setOpen(false);
  const run = (c: Cmd) => { close(); c.run(); };
  let lastGroup = '';

  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="cmdk" onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(cmds.length - 1, h + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); const c = cmds[hl]; if (c) run(c); }
      }}>
        <input autoFocus placeholder={t('Type a command or search issues…')} value={q} onChange={(e) => { setQ(e.target.value); setHl(0); }} />
        <div className="menu-list">
          {cmds.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.key}>
                {header}
                <button className={`menu-item ${i === hl ? 'hl' : ''}`} onMouseEnter={() => setHl(i)} onClick={() => run(c)}>
                  {c.icon}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                  {c.kbd && <span className="kbd-group" style={{ marginLeft: 'auto', display: 'flex', gap: 3 }}>{c.kbd.map((k) => <span key={k} className="kbd">{k}</span>)}</span>}
                </button>
              </div>
            );
          })}
          {!cmds.length && <div className="menu-item" style={{ color: 'var(--text-quaternary)' }}>{t('No results')}</div>}
        </div>
      </div>
    </div>
  );
}
