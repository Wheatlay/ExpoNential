import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';

export type MenuItem =
  | {
      key: string;
      label: string;
      icon?: ReactNode;
      kbd?: string[];
      checked?: boolean;
      danger?: boolean;
      /** Powód niedostępności: pozycja jest wyszarzona z tooltipem, nie chowana. */
      disabledReason?: string;
      /** Podmenu rozwijane obok po najechaniu (jak w Linearze). */
      submenu?: () => MenuSpec;
      /** Zostaw menu otwarte po wyborze (multi-select etykiet). */
      keepOpen?: boolean;
      /** Może zwrócić nową wersję menu (np. odświeżone ptaszki przy multi-select). */
      onSelect?: () => MenuSpec | void;
    }
  | { key: string; separator: true };

export type MenuSpec = { items: MenuItem[]; searchable?: boolean; placeholder?: string };

/** flipX: lewa krawędź pozycji nadrzędnej; podmenu bez miejsca po prawej otwiera się przy niej. */
type Anchor = { x: number; y: number; alignRight?: boolean; flipX?: number };
type State = { anchor: Anchor; spec: MenuSpec; id: number } | null;

let state: State = null;
let seq = 0;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openMenu(anchor: Anchor | HTMLElement, spec: MenuSpec) {
  const a = anchor instanceof HTMLElement
    ? (() => { const r = anchor.getBoundingClientRect(); return { x: r.left, y: r.bottom + 4 }; })()
    : anchor;
  state = { anchor: a, spec, id: ++seq };
  emit();
}

export function closeMenu() {
  state = null;
  emit();
}

export const isMenuOpen = () => state !== null;

function useMenuState() {
  return useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => state);
}

export function MenuHost() {
  const s = useMenuState();
  if (!s) return null;
  return <Menu key={s.id} anchor={s.anchor} spec={s.spec} onCloseAll={closeMenu} root />;
}

type Selectable = Exclude<MenuItem, { separator: true }>;

/**
 * Jedno menu. Podmenu idzie przez portal do body: animacja rodzica (transform)
 * przesunęłaby inaczej jego pozycję fixed.
 */
function Menu({ anchor, spec: initialSpec, onCloseAll, onCloseSelf, root }: {
  anchor: Anchor; spec: MenuSpec; onCloseAll: () => void; onCloseSelf?: () => void; root?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [spec, setSpec] = useState(initialSpec);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const [pos, setPos] = useState({ left: anchor.x, top: anchor.y });
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const [sub, setSub] = useState<{ key: string; spec: MenuSpec; anchor: Anchor; focus: boolean } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchable = spec.searchable ?? spec.items.length > 6;

  const items = useMemo(() => {
    if (!q) return spec.items;
    const lq = q.toLowerCase();
    return spec.items.filter((i) => !('separator' in i) && i.label.toLowerCase().includes(lq));
  }, [q, spec.items]);
  const selectable = items.filter((i): i is Selectable => !('separator' in i));

  // Menu nie może wyjść poza ekran; podmenu bez miejsca po prawej otwiera się po lewej.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.alignRight ? anchor.x - r.width : anchor.x;
    let top = anchor.y;
    if (left + r.width > window.innerWidth - 8) left = anchor.flipX != null ? anchor.flipX - r.width - 4 : window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left: Math.max(8, left), top });
  }, [anchor, items.length, root]);

  useEffect(() => {
    if (!root) return;
    // Podmenu są w portalu, więc klik w dowolne .popover nie zamyka menu.
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.popover')) onCloseAll(); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onCloseAll, root]);

  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  const openSub = (item: Selectable, el: HTMLElement, focus: boolean) => {
    if (!item.submenu || item.disabledReason) return;
    const r = el.getBoundingClientRect();
    setSub({ key: item.key, spec: item.submenu(), anchor: { x: r.right + 4, y: r.top - 5, flipX: r.left }, focus });
  };

  const choose = (item: Selectable, el?: HTMLElement | null) => {
    if (item.disabledReason) return;
    if (item.submenu) { if (el) openSub(item, el, true); return; }
    const next = item.onSelect?.();
    if (next) setSpec(next);
    if (!item.keepOpen) onCloseAll();
  };

  const itemEl = (key: string) => ref.current?.querySelector<HTMLElement>(`:scope > .menu-list > [data-key="${CSS.escape(key)}"]`) ?? null;

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest?.('.popover') !== ref.current) return; // klawisze z podmenu obsługuje podmenu
    e.stopPropagation();
    const cur = selectable[hl];
    if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(selectable.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (cur) choose(cur, itemEl(cur.key)); }
    else if (e.key === 'Escape') { e.preventDefault(); if (onCloseSelf) onCloseSelf(); else onCloseAll(); }
    else if (e.key === 'ArrowLeft' && onCloseSelf && !q) { e.preventDefault(); onCloseSelf(); }
    else if (e.key === 'ArrowRight' && cur?.submenu) { e.preventDefault(); openSub(cur, itemEl(cur.key)!, true); }
    else if (!searchable && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      // Bez wyszukiwarki: litera ze skrótu działa jak w Linearze (S, P, A, L…).
      const it = selectable.find((i) => i.kbd?.length === 1 && i.kbd[0].toLowerCase() === e.key.toLowerCase());
      if (it) { e.preventDefault(); setHl(selectable.indexOf(it)); choose(it, itemEl(it.key)); }
    }
  };

  useEffect(() => { if (!searchable) ref.current?.focus(); }, [searchable]);

  return (
    <div ref={ref} className="popover" style={pos} tabIndex={-1} onKeyDown={onKey} onContextMenu={(e) => e.preventDefault()}>
      {searchable && (
        <input className="search" autoFocus placeholder={spec.placeholder ?? t('Filter…')} value={q}
          onChange={(e) => { setQ(e.target.value); setHl(0); }} />
      )}
      <div className="menu-list" role="menu">
        {items.map((item) => {
          if ('separator' in item) return <div key={item.key} className="menu-sep" />;
          const idx = selectable.indexOf(item);
          return (
            <button
              key={item.key}
              data-key={item.key}
              role="menuitem"
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? sub?.key === item.key : undefined}
              className={`menu-item ${idx === hl || sub?.key === item.key ? 'hl' : ''} ${item.danger ? 'danger' : ''}`}
              aria-disabled={item.disabledReason ? 'true' : undefined}
              onMouseEnter={(e) => {
                setHl(idx);
                const el = e.currentTarget;
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                // Krótka zwłoka, żeby przejazd po skosie do podmenu go nie zamykał.
                hoverTimer.current = setTimeout(() => {
                  if (item.submenu) { if (sub?.key !== item.key) openSub(item, el, false); }
                  else setSub(null);
                }, item.submenu ? 60 : 120);
                if (item.disabledReason) {
                  // Po prawej, a gdy brak miejsca, po lewej stronie menu: nigdy na samej pozycji.
                  const r = el.getBoundingClientRect();
                  const x = r.right + 8 + 280 < window.innerWidth ? r.right + 8 : r.left - 8 - 280;
                  setTip({ text: item.disabledReason, x: Math.max(8, x), y: r.top + 4 });
                }
              }}
              onMouseLeave={() => setTip(null)}
              onClick={(e) => choose(item, e.currentTarget)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.checked && <span className="check"><Icon.check size={14} /></span>}
              {/* Jak w Linearze: skrót szarym tekstem, a przy podmenu dodatkowo strzałka. */}
              {item.kbd && !item.checked && <span className="shortcut">{item.kbd.join(' ')}</span>}
              {item.submenu && <span className="sub"><Icon.caret size={8} className="caret-right" /></span>}
            </button>
          );
        })}
        {!selectable.length && <div className="menu-item" style={{ color: 'var(--text-quaternary)' }}>{t('No results')}</div>}
      </div>
      {tip && <div className="tooltip" style={{ left: tip.x, top: tip.y, width: 280 }}>{tip.text}</div>}
      {sub && createPortal(
        <SubFocus focus={sub.focus}>
          <Menu
            key={sub.key}
            anchor={sub.anchor}
            spec={sub.spec}
            onCloseAll={onCloseAll}
            onCloseSelf={() => { setSub(null); ref.current?.focus(); }}
          />
        </SubFocus>,
        document.body,
      )}
    </div>
  );
}

/** Podmenu otwarte klawiaturą przejmuje fokus; otwarte najechaniem nie zabiera go wyszukiwarce. */
function SubFocus({ focus, children }: { focus: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!focus) return;
    const el = ref.current?.querySelector<HTMLElement>('.popover input.search') ?? ref.current?.querySelector<HTMLElement>('.popover');
    el?.focus();
  }, [focus]);
  return <span ref={ref} style={{ display: 'contents' }}>{children}</span>;
}

/** Prosty tooltip po najechaniu, np. dla wyszarzonych przycisków. */
export function Tooltip({ text, children }: { text: string | null | undefined; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (!text) return <>{children}</>;
  return (
    <span
      style={{ display: 'inline-flex' }}
      onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPos({ x: r.left, y: r.bottom + 6 }); }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && <span className="tooltip" style={{ left: Math.min(pos.x, window.innerWidth - 290), top: pos.y }}>{text}</span>}
    </span>
  );
}
