import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { askConfirm } from './Confirm.tsx';
import { useQuery } from '@tanstack/react-query';
import { openAsk } from './AskModal.tsx';
import { isNeedInfo } from '../server/rules.ts';
import { startWork } from './startWork.ts';
import { guardDone } from './DoneGuard.tsx';
import { sendPresence, usePresence, type Presence } from './presence.ts';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, useDndContext, useDraggable, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent, type Modifier,
} from '@dnd-kit/core';
import { api, isAskedTo, queryClient, useIssues, useMe, useMeta, useSprints, useUpdateIssue, type IssueRow, type Meta, type Status } from './api.ts';
import { Avatar, avatarColor, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, isMenuOpen, Tooltip, type MenuSpec } from './menu.tsx';
import { assigneeMenu, doneWarning, issueContextMenu, labelMenu, priorityMenu, sprintMenu, statusMenu, type PickTarget } from './pickers.tsx';
import { navigate } from './router.ts';
import { openNewIssue } from './NewIssue.tsx';
import { toast } from './toast.ts';
import { sortBetween } from './sort.ts';
import { InlineCode } from './InlineCode.tsx';
import { ident } from './project.ts';
import { t, tn } from './i18n.ts';
import { PhoneBoard, SplitBoard } from './MobileBoard.tsx';

type Display = {
  rows: RowsBy;
  ordering: 'priority' | 'manual' | 'updated' | 'created' | 'oldest' | 'title' | 'assignee';
  completed: 'day' | 'week' | 'month' | 'all';
  showSubIssues: boolean;
  showEmptyRows: boolean;
  showHidden: boolean;
  props: CardProps;
  livePresence: boolean;
};
type RowsBy = 'assignee' | 'priority' | 'label' | 'sprint' | 'creator' | 'none';
export type CardProps = { id: boolean; assignee: boolean; priority: boolean; labels: boolean; subIssues: boolean; ai: boolean; notes: boolean; blocked: boolean };
const ALL_PROPS: CardProps = { id: true, assignee: true, priority: true, labels: true, subIssues: true, ai: true, notes: true, blocked: true };
const CardPropsContext = createContext<CardProps>(ALL_PROPS);
type CardActionKind = 'priority' | 'labels' | 'assignee';
type CardAction = (i: IssueRow, what: CardActionKind, el: HTMLElement) => void;
const CardActionsContext = createContext<CardAction | null>(null);

let scopeRequested = false;
/** Sidebar prosi o zakres "Asked to me" (board może być jeszcze niezamontowany). */
export function requestQuestionsScope() { scopeRequested = true; window.dispatchEvent(new Event('board-questions')); }
function consumeScopeRequest() { const r = scopeRequested; scopeRequested = false; return r; }
type Filters = { scope: 'all' | 'sprint' | 'questions' | 'unread'; labelIds: number[]; assigneeIds: (number | null)[]; priorities: number[] };

const DEFAULT_DISPLAY: Display = { rows: 'assignee', ordering: 'priority', completed: 'week', showSubIssues: false, showEmptyRows: false, showHidden: false, props: ALL_PROPS, livePresence: true };

const DEFAULT_FILTERS: Filters = { scope: 'all', labelIds: [], assigneeIds: [], priorities: [] };
type View = { display: Display; filters: Filters };
type ViewResponse = { projectDefault: Partial<View> | null; mine: Partial<View> | null; canSetDefault: boolean };
/** Zapisany widok uzupełniony wartościami z kodu (nowe opcje Display dochodzą z czasem). */
const withDefaults = (v: Partial<View> | null | undefined): View => ({
  display: { ...DEFAULT_DISPLAY, ...v?.display, props: { ...ALL_PROPS, ...v?.display?.props } },
  filters: { ...DEFAULT_FILTERS, ...v?.filters, ...((v?.filters?.scope as string) === 'mine' ? { scope: 'all' as const } : {}) },
});
const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Widok boardu jak w Linearze: domyślny projektu (ustawia admin) i mój, który go nadpisuje. Mój zapisuje się
 * na koncie (każde urządzenie) chwilę po zmianie; "Reset" wraca do domyślnego projektu.
 */
function useBoardView() {
  const q = useQuery({ queryKey: ['view'], queryFn: () => api<ViewResponse>('/api/view'), staleTime: Infinity });
  const [local, setLocal] = useState<View | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectDefault = withDefaults(q.data?.projectDefault);
  const current = local ?? withDefaults(q.data?.mine ?? q.data?.projectDefault);
  const save = (next: View) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void api('/api/view', { method: 'PUT', body: { view: next } }), 600);
  };
  const update = (next: View) => { setLocal(next); save(next); };
  // Jednorazowo: widok sprzed zmiany (trzymany w przeglądarce) przechodzi na konto.
  useEffect(() => {
    if (!q.data || q.data.mine) return;
    try {
      const d = localStorage.getItem('board.display');
      const f = localStorage.getItem('board.filters');
      localStorage.removeItem('board.display');
      localStorage.removeItem('board.filters');
      if (d || f) update(withDefaults({ display: d ? JSON.parse(d) : undefined, filters: f ? JSON.parse(f) : undefined }));
    } catch { /* prywatne okno */ }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    display: current.display,
    filters: current.filters,
    setDisplay: (fn: Display | ((d: Display) => Display)) => update({ ...current, display: typeof fn === 'function' ? fn(current.display) : fn }),
    setFilters: (fn: Filters | ((f: Filters) => Filters)) => update({ ...current, filters: typeof fn === 'function' ? fn(current.filters) : fn }),
    loaded: !!q.data,
    differs: !!q.data && !sameView(current, projectDefault),
    canSetDefault: !!q.data?.canSetDefault,
    reset: () => {
      if (timer.current) clearTimeout(timer.current);
      setLocal(null);
      void api('/api/view', { method: 'DELETE' }).then(() => queryClient.setQueryData<ViewResponse>(['view'], (d) => d && { ...d, mine: null }));
    },
    saveAsDefault: () => api('/api/view/default', { method: 'PUT', body: { view: current } })
      .then(() => { queryClient.setQueryData<ViewResponse>(['view'], (d) => d && { ...d, projectDefault: current }); toast(t('Saved as the project default view')); }),
  };
}

function useStored<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? { ...initial, ...JSON.parse(raw) } : initial; } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* prywatne okno */ } }, [key, v]);
  return [v, setV] as const;
}

const COMPLETED_MS = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5, all: Infinity };
const COMPLETED_LABEL: Record<Display['completed'], string> = { day: t('Past day'), week: t('Past week'), month: t('Past month'), all: t('All') };
const isClosedType = (s: Status) => s.type === 'completed' || s.type === 'canceled' || s.type === 'duplicate';
const NONE = 'none';

export function Board() {
  const meta = useMeta().data;
  const issues = useIssues().data;
  const me = useMe().data;
  const sprints = useSprints().data?.sprints ?? [];
  const update = useUpdateIssue();
  const view = useBoardView();
  const { display, filters, setDisplay, setFilters } = view;
  const [collapsed, setCollapsed] = useStored<Record<string, boolean>>('board.collapsed', {});
  // Szerokości kolumn: kolumny z kartami dzielą szerokość ekranu, puste są wąskie. Ręczna szerokość (przeciągnięcie
  // krawędzi) zapisuje się osobno dla stanu "pusta" ("12:empty") i "z kartami" ("12"), więc zwężenie pustej kolumny
  // nie zostawia jej wąskiej, gdy pojawią się karty. Zwinięta kolumna to pionowy pasek.
  const [colWidths, setColWidths] = useStored<Record<string, number>>('board.colWidths.v2', {});
  const [colCollapsed, setColCollapsed] = useStored<Record<string, boolean>>('board.colCollapsed', {});
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(0);
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoardWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const widthKey = (s: Status, count: number) => (count === 0 ? `${s.id}:empty` : String(s.id));
  const manualWidth = (s: Status, count: number) => colWidths[widthKey(s, count)];
  /** Szerokości wszystkich kolumn naraz: automatyczne dostają po równo z miejsca, którego nie zajęły pozostałe. */
  const layoutWidths = (cols: Status[], count: (s: Status) => number) => {
    const fixed = new Map<number, number>();
    for (const s of cols) {
      const n = count(s);
      if (colCollapsed[s.id]) fixed.set(s.id, 44);
      else if (manualWidth(s, n) != null) fixed.set(s.id, Math.max(n === 0 ? 96 : 180, manualWidth(s, n)!));
      else if (n === 0) fixed.set(s.id, 112);
    }
    const autos = cols.filter((s) => !fixed.has(s.id));
    const free = boardWidth - 16 - 8 * (cols.length - 1) - [...fixed.values()].reduce((a, b) => a + b, 0);
    const share = autos.length ? Math.round(Math.min(560, Math.max(260, free / autos.length))) : 0;
    return new Map(cols.map((s) => [s.id, fixed.get(s.id) ?? share]));
  };
  const resetWidth = (s: Status, count: number) => setColWidths((w) => { const { [widthKey(s, count)]: _, ...rest } = w; return rest; });
  const startResize = (s: Status, count: number, startWidth: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const key = widthKey(s, count);
    const move = (ev: PointerEvent) => setColWidths((w) => ({ ...w, [key]: Math.max(count === 0 ? 96 : 180, Math.min(720, Math.round(startWidth + ev.clientX - x0))) }));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [dragging, setDragging] = useState<IssueRow | null>(null);
  const hovered = useRef<IssueRow | null>(null);
  const activeSprint = sprints.find((s) => s.status === 'active');
  const narrow = useNarrow();
  const presence = usePresence();
  const askedMe = (issues ?? []).filter((i) => isAskedTo(i, me?.id)).length;
  const unreadCount = (issues ?? []).filter((i) => i.unreadComments > 0).length;
  // Przechył kopii karty zależny od prędkości ruchu (jak podniesiona kartka).
  const [tilt, setTilt] = useState(0);
  const lastMove = useRef({ x: 0, t: 0 });
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Link z sidebara "Asked to me" przełącza zakres boardu.
  useEffect(() => {
    const on = () => setFilters((f) => ({ ...f, scope: 'questions' }));
    if (consumeScopeRequest()) on();
    window.addEventListener('board-questions', on);
    return () => window.removeEventListener('board-questions', on);
  }, [setFilters]);
  // Prawy klik w trakcie przeciągania anuluje je. Przechwytujemy prawy przycisk, zanim
  // dotrze do sensora (inaczej jego "pointerup" upuszcza kartę), i kończymy przeciąganie
  // upuszczeniem oznaczonym jako anulowane, więc karta wraca na miejsce bez zmian.
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!dragging) return;
    cancelledRef.current = false;
    const block = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    // Prawy przycisk przy wciśniętym lewym nie daje pointerdown (tylko pointermove), mousedown przychodzi zawsze.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      block(e);
      cancelledRef.current = true;
      const node = document.querySelector('.card.dragging')?.parentElement;
      node?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: e.clientX, clientY: e.clientY }));
    };
    const onUp = (e: MouseEvent) => { if (e.button === 2) block(e); };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('contextmenu', block, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      // Menu kontekstowe po puszczeniu prawego przycisku też ignorujemy.
      setTimeout(() => window.removeEventListener('contextmenu', block, true), 300);
    };
  }, [dragging]);
  const [displayOpen, setDisplayOpen] = useState<{ x: number; y: number } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const columns = useMemo(() => (meta?.statuses ?? []).filter((s) => display.showHidden || !s.hiddenOnBoard), [meta, display.showHidden]);
  const statusById = useMemo(() => new Map((meta?.statuses ?? []).map((s) => [s.id, s])), [meta]);

  const visible = useMemo(() => {
    if (!issues || !meta) return [];
    const now = Date.now();
    return issues.filter((i) => {
      const st = statusById.get(i.statusId);
      if (!st) return false;
      if (!display.showSubIssues && i.parentId) return false;
      if ((st.type === 'completed' || st.type === 'canceled' || st.type === 'duplicate') && i.completedAt
        && now - new Date(i.completedAt).getTime() > COMPLETED_MS[display.completed]) return false;
      if (filters.scope === 'sprint' && i.sprintId !== activeSprint?.id) return false;
      if (filters.scope === 'questions' && !isAskedTo(i, me?.id)) return false;
      if (filters.scope === 'unread' && !i.unreadComments) return false;
      if (filters.labelIds.length && !filters.labelIds.some((l) => i.labelIds.includes(l))) return false;
      if (filters.assigneeIds.length && !filters.assigneeIds.includes(i.assigneeId)) return false;
      if (filters.priorities.length && !filters.priorities.includes(i.priority)) return false;
      return true;
    });
  }, [issues, meta, display, filters, statusById, activeSprint, me]);

  const sorter = useMemo(() => {
    const prio = (p: number) => (p === 0 ? 5 : p);
    switch (display.ordering) {
      case 'priority': return (a: IssueRow, b: IssueRow) => prio(a.priority) - prio(b.priority) || a.sortOrder - b.sortOrder || b.number - a.number;
      case 'updated': return (a: IssueRow, b: IssueRow) => b.updatedAt.localeCompare(a.updatedAt);
      case 'created': return (a: IssueRow, b: IssueRow) => b.number - a.number;
      case 'oldest': return (a: IssueRow, b: IssueRow) => a.number - b.number;
      case 'title': return (a: IssueRow, b: IssueRow) => a.title.localeCompare(b.title, 'pl');
      case 'assignee': {
        const name = (id: number | null) => meta?.users.find((u) => u.id === id)?.name ?? '\uffff';
        return (a: IssueRow, b: IssueRow) => name(a.assigneeId).localeCompare(name(b.assigneeId), 'pl') || prio(a.priority) - prio(b.priority);
      }
      default: return (a: IssueRow, b: IssueRow) => a.sortOrder - b.sortOrder || b.number - a.number;
    }
  }, [display.ordering, meta]);

  // Wiersze: każda grupa ma klucz, nagłówek i to, co zmienia upuszczenie/dodanie w tym wierszu.
  const rows = useMemo<BoardRow[]>(() => {
    if (!meta) return [];
    const by = display.rows;
    if (by === 'none') return [{ key: 'all', label: '', icon: null, issues: visible }];
    const groups = new Map<string, IssueRow[]>();
    for (const i of visible) for (const k of rowKeysOf(i, by)) groups.set(k, [...(groups.get(k) ?? []), i]);
    const defs: Omit<BoardRow, 'issues'>[] = [];
    if (by === 'assignee' || by === 'creator') {
      const used = (u: Meta['users'][number]) => u.active || groups.has(String(u.id));
      const ordered = meta.users.filter(used).sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : a.name.localeCompare(b.name)));
      for (const u of ordered) defs.push({ key: String(u.id), label: u.name, icon: <Avatar user={u} size={18} /> });
      defs.push({ key: NONE, label: by === 'assignee' ? t('No assignee') : t('Unknown creator'), icon: <Avatar user={null} size={18} /> });
    } else if (by === 'priority') {
      for (const p of [1, 2, 3, 4, 0]) defs.push({ key: String(p), label: t(meta.priorities[p]), icon: <PriorityIcon priority={p} /> });
    } else if (by === 'label') {
      for (const l of meta.labels) defs.push({ key: String(l.id), label: l.name, icon: <span className="dot" style={{ background: l.color }} /> });
      defs.push({ key: NONE, label: t('No label'), icon: <Icon.label size={14} /> });
    } else if (by === 'sprint') {
      const order = { active: 0, planned: 1, ended: 2, reviewed: 3 };
      for (const sp of [...sprints].sort((a, b) => order[a.status] - order[b.status] || b.startsAt.localeCompare(a.startsAt))) {
        if (sp.status === 'reviewed' && !groups.has(String(sp.id))) continue;
        defs.push({ key: String(sp.id), label: `${sp.name}${sp.status === 'active' ? ` ${t('(current)')}` : ''}`, icon: <Icon.sprint size={14} /> });
      }
      defs.push({ key: NONE, label: t('No sprint'), icon: <Icon.sprint size={14} /> });
    }
    // Twój wiersz jest zawsze pierwszy i widoczny, nawet pusty.
    return defs.map((d) => ({ ...d, issues: groups.get(d.key) ?? [] }))
      .filter((r) => display.showEmptyRows || r.issues.length || ((by === 'assignee' || by === 'creator') && r.key === String(me?.id)));
  }, [visible, meta, display.rows, display.showEmptyRows, me, sprints]);

  /** Co zmienia przeniesienie karty z wiersza `from` do `to` (albo dodanie w wierszu `to`). */
  const rowPatch = (to: string, from: string | null, issue: IssueRow | null): Parameters<typeof update.mutate>[0]['patch'] => {
    const by = display.rows;
    const id = to === NONE ? null : Number(to);
    if (by === 'assignee') return issue?.assigneeId === id ? {} : { assigneeId: id };
    if (by === 'priority') return issue?.priority === id ? {} : { priority: id ?? 0 };
    if (by === 'sprint') return issue?.sprintId === id ? {} : { sprintId: id };
    if (by === 'label') {
      if (!issue) return id == null ? {} : { labelIds: [id] };
      if (from === to) return {};
      const kept = issue.labelIds.filter((l) => String(l) !== from);
      return { labelIds: id == null ? kept : [...new Set([...kept, id])] };
    }
    return {};
  };

  const target = (i: IssueRow): PickTarget => ({ ...i });
  const updateOne = (i: IssueRow) => (patch: Parameters<typeof update.mutate>[0]['patch']) => update.mutate({ number: i.number, patch });

  // Skróty jak w Linearze na karcie pod kursorem.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isMenuOpen() || !meta) return;
      const el = e.target as HTMLElement;
      if (el.closest?.('input, textarea, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const i = hovered.current;
      const card = i && document.querySelector(`[data-card="${i.number}"]`);
      const anchor = card instanceof HTMLElement ? card : null;
      if (!i || !anchor) return;
      const tg = target(i);
      const menus: Record<string, () => MenuSpec> = {
        s: () => statusMenu(meta, tg, updateOne(i)),
        p: () => priorityMenu(meta, tg, updateOne(i)),
        a: () => assigneeMenu(meta, tg, updateOne(i), me?.id),
        l: () => labelMenu(meta, tg, updateOne(i)),
        c: () => sprintMenu(sprints, tg, updateOne(i)),
      };
      const m = menus[e.key.toLowerCase()];
      if (m) { e.preventDefault(); openMenu(anchor, m()); }
      else if (e.key === 'i' && me) { e.preventDefault(); updateOne(i)({ assigneeId: i.assigneeId === me.id ? null : me.id }); }
      else if (e.key === 'Enter') { e.preventDefault(); navigate(`/issue/${ident(i.number)}`); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!meta || !issues) return <div className="board" />;

  const onDragStart = (e: DragStartEvent) => setDragging(issues.find((i) => i.number === (e.active.data.current as { number?: number } | undefined)?.number) ?? null);

  const onDragEnd = (e: DragEndEvent) => {
    const issue = dragging;
    if (issue && display.livePresence !== false) sendPresence({ number: issue.number, end: true });
    setDragging(null);
    if (cancelledRef.current) { cancelledRef.current = false; return; }
    if (!issue || !e.over) return;
    const over = e.over.data.current as { statusId: number; rowKey: string; beforeNumber?: number } | undefined;
    if (!over) return;
    const st = statusById.get(over.statusId)!;
    const patch: Parameters<typeof update.mutate>[0]['patch'] = {};
    if (st.id !== issue.statusId) patch.statusId = st.id;
    Object.assign(patch, rowPatch(over.rowKey, (e.active.data.current as { rowKey?: string } | undefined)?.rowKey ?? null, issue));
    // Ręczna kolejność: upuszczenie na kartę wstawia przed nią.
    if (display.ordering === 'manual' && over.beforeNumber !== issue.number) {
      const cell = visible.filter((i) => i.statusId === st.id && (display.rows === 'none' || rowKeysOf(i, display.rows).includes(over.rowKey)) && i.number !== issue.number).sort(sorter);
      const idx = over.beforeNumber != null ? cell.findIndex((i) => i.number === over.beforeNumber) : cell.length;
      const before = idx > 0 ? cell[idx - 1].sortOrder : null;
      const after = idx >= 0 && idx < cell.length ? cell[idx].sortOrder : null;
      patch.sortOrder = sortBetween(before, after);
    }
    if (patch.statusId && guardDone(meta, st, issue, (({ statusId: _s, ...rest }) => rest)(patch))) return;
    if (patch.statusId && isNeedInfo(st)) {
      const { statusId: _s, ...extra } = patch;
      return openAsk({ number: issue.number, statusId: st.id, extra });
    }
    if (Object.keys(patch).length) update.mutate({ number: issue.number, patch });
  };

  /** Klik w plakietkę na karcie robi to, co w Linearze: otwiera właściwy wybór, nie kartę. */
  const cardAction: CardAction = (i, what, el) => {
    const tg = target(i);
    if (what === 'priority') openMenu(el, priorityMenu(meta, tg, updateOne(i)));
    else if (what === 'labels') openMenu(el, labelMenu(meta, tg, updateOne(i)));
    else if (what === 'assignee') openMenu(el, assigneeMenu(meta, tg, updateOne(i), me?.id));
  };

  const countFor = (s: Status) => visible.filter((i) => i.statusId === s.id).length;
  const widths = layoutWidths(columns, countFor);
  const widthOf = (s: Status) => widths.get(s.id)!;
  const columnMenu = (s: Status): MenuSpec => ({
    searchable: false,
    items: [
      { key: 'collapse', label: colCollapsed[s.id] ? t('Expand column') : t('Collapse column'), onSelect: () => { setColCollapsed((c) => ({ ...c, [s.id]: !c[s.id] })); } },
      { key: 'reset', label: t('Reset width'), disabledReason: manualWidth(s, countFor(s)) == null ? t('Width is automatic') : undefined, onSelect: () => { resetWidth(s, countFor(s)); } },
    ],
  });

  const filterMenu = (): MenuSpec => ({
    searchable: false,
    items: [
      {
        key: 'assignee', label: t('Assignee'), icon: <Icon.user size={14} />, submenu: () => ({
          searchable: true,
          items: [{ id: null as number | null, name: t('No assignee') }, ...meta.users.filter((u) => u.active)].map((u) => ({
            key: `a${u.id}`, label: u.name, checked: filters.assigneeIds.includes(u.id), icon: <Avatar user={u.id == null ? null : meta.users.find((x) => x.id === u.id)} size={16} />,
            onSelect: () => setFilters((f) => ({ ...f, assigneeIds: f.assigneeIds.includes(u.id) ? f.assigneeIds.filter((x) => x !== u.id) : [...f.assigneeIds, u.id] })),
          })),
        }),
      },
      {
        key: 'labels', label: t('Labels'), icon: <Icon.label size={14} />, submenu: () => ({
          searchable: true,
          items: meta.labels.map((l) => ({
            key: `l${l.id}`, label: l.name, checked: filters.labelIds.includes(l.id), icon: <span className="dot" style={{ background: l.color }} />,
            onSelect: () => setFilters((f) => ({ ...f, labelIds: f.labelIds.includes(l.id) ? f.labelIds.filter((x) => x !== l.id) : [...f.labelIds, l.id] })),
          })),
        }),
      },
      {
        key: 'priority', label: t('Priority'), icon: <PriorityIcon priority={2} colored={false} />, submenu: () => ({
          searchable: false,
          items: [1, 2, 3, 4, 0].map((p) => ({
            key: `p${p}`, label: t(meta.priorities[p]), checked: filters.priorities.includes(p), icon: <PriorityIcon priority={p} />,
            onSelect: () => setFilters((f) => ({ ...f, priorities: f.priorities.includes(p) ? f.priorities.filter((x) => x !== p) : [...f.priorities, p] })),
          })),
        }),
      },
    ],
  });

  const activeFilters: { key: string; label: string; color?: string; clear: () => void }[] = [
    ...filters.assigneeIds.map((id) => ({ key: `a${id}`, label: id == null ? t('No assignee') : meta.users.find((u) => u.id === id)?.name ?? '?', clear: () => setFilters((f) => ({ ...f, assigneeIds: f.assigneeIds.filter((x) => x !== id) })) })),
    ...filters.labelIds.map((id) => ({ key: `l${id}`, label: meta.labels.find((l) => l.id === id)?.name ?? '?', color: meta.labels.find((l) => l.id === id)?.color, clear: () => setFilters((f) => ({ ...f, labelIds: f.labelIds.filter((x) => x !== id) })) })),
    ...filters.priorities.map((p) => ({ key: `p${p}`, label: t(meta.priorities[p]), clear: () => setFilters((f) => ({ ...f, priorities: f.priorities.filter((x) => x !== p) })) })),
  ];

  return (
    <>
      <div className="toolbar">
        <button className={`chip ${filters.scope === 'all' ? 'on' : ''}`} onClick={() => setFilters((f) => ({ ...f, scope: 'all' }))}>{t('All issues')}</button>
        <button className={`chip ${filters.scope === 'sprint' ? 'on' : ''}`} onClick={() => setFilters((f) => ({ ...f, scope: 'sprint' }))}>
          <Icon.sprint size={13} /> {t('Current sprint')}
        </button>
        {(unreadCount > 0 || filters.scope === 'unread') && (
          <span className={`chip unread ${filters.scope === 'unread' ? 'on' : ''}`} style={{ paddingRight: unreadCount > 0 ? 3 : undefined }}>
            <button className="chip-main" onClick={() => setFilters((f) => ({ ...f, scope: 'unread' }))}>
              <Icon.comment size={13} /> {t('Unread')} <b>{unreadCount}</b>
            </button>
            {unreadCount > 0 && (
              <button className="chip-action" title={t('Mark all as read')} aria-label={t('Mark all as read')}
                onClick={() => void api('/api/issues/mark-read', { method: 'POST', body: {} }).then(() => { void queryClient.invalidateQueries({ queryKey: ['issues'] }); toast(t('All marked as read')); })}>
                <Icon.check size={12} />
              </button>
            )}
          </span>
        )}
        {filters.scope === 'sprint' && <SprintProgress issues={issues ?? []} meta={meta} sprintId={activeSprint?.id} />}
        {(askedMe > 0 || filters.scope === 'questions') && (
          <button className={`chip ask ${filters.scope === 'questions' ? 'on' : ''}`} onClick={() => setFilters((f) => ({ ...f, scope: 'questions' }))}>
            <Icon.question size={13} /> {t('Asked to me')} <b>{askedMe}</b>
          </button>
        )}
        {activeFilters.map((f) => (
          <span key={f.key} className="chip on">
            {f.color && <span className="dot" style={{ background: f.color }} />}
            {f.label}
            <button className="x" onClick={f.clear} aria-label={t('Remove filter')}><Icon.close size={12} /></button>
          </span>
        ))}
        <span className="spacer" />
        {view.loaded && (
          <button className={`chip view-chip ${view.differs ? 'mine' : ''}`}
            title={view.differs ? t('Your own filters and display options (saved to your account)') : t('The view your project admin set for everyone')}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ x: r.right, y: r.bottom + 4, alignRight: true }, {
              searchable: false,
              items: [
                { key: 'reset', label: t('Reset to project default'), disabledReason: view.differs ? undefined : t('You are already on the project default'), onSelect: () => { view.reset(); } },
                { key: 'save', label: t('Save as project default'), disabledReason: !view.canSetDefault ? t('Only project admins can set the default view') : !view.differs ? t('This already is the project default') : undefined, onSelect: () => { void view.saveAsDefault(); } },
              ],
            }); }}>
            {view.differs ? t('My view') : t('Default view')} <Icon.chevron size={10} />
          </button>
        )}
        <button className="icon-btn round" title={t('Filter')} onClick={(e) => openMenu({ x: e.currentTarget.getBoundingClientRect().right, y: e.currentTarget.getBoundingClientRect().bottom + 4, alignRight: true }, filterMenu())}><Icon.filter size={15} /></button>
        <button className="icon-btn round view-btn" data-display-btn title={t('Display options')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setDisplayOpen(displayOpen ? null : { x: r.right, y: r.bottom + 6 }); }}>
          <Icon.display size={15} />
        </button>
        {displayOpen && <DisplayPanel at={displayOpen} display={display} setDisplay={setDisplay} onClose={() => setDisplayOpen(null)} />}
      </div>
      {narrow ? (
        // Telefon: złożony = zakładki statusów, rozłożony (Fold) = lista + otwarte zgłoszenie.
        narrow === 'split'
          ? <SplitBoard columns={columns} visible={visible} sorter={sorter} meta={meta} />
          : <PhoneBoard columns={columns} visible={visible} sorter={sorter} meta={meta} />
      ) : (
      <CardPropsContext.Provider value={{ ...ALL_PROPS, ...display.props }}>
      <CardActionsContext.Provider value={cardAction}>
      <DndContext sensors={sensors} onDragStart={(e) => { lastMove.current = { x: 0, t: performance.now() }; setTilt(0); onDragStart(e); }} onDragEnd={onDragEnd} onDragCancel={() => { if (dragging && display.livePresence !== false) sendPresence({ number: dragging.number, end: true }); setDragging(null); }}
        onDragMove={(e) => {
          if (display.livePresence !== false && dragging) {
            const start = e.activatorEvent as PointerEvent;
            const px = start.clientX + e.delta.x;
            const py = start.clientY + e.delta.y;
            const cell = document.elementsFromPoint(px, py).map((el) => el.closest?.('[data-cell]')).find(Boolean) as HTMLElement | undefined;
            if (cell) {
              const r = cell.getBoundingClientRect();
              const [statusId, rowKey] = cell.dataset.cell!.split('|');
              sendPresence({ number: dragging.number, statusId: Number(statusId), rowKey,
                fx: Math.max(0, Math.min(1, (px - r.left) / r.width)), fy: Math.max(0, Math.min(1, (py - r.top) / r.height)) });
            } else {
              // Poza kolumnami (pasek boczny, nagłówek): u innych podgląd znika, zamiast wisieć w ostatniej komórce.
              sendPresence({ number: dragging.number });
            }
          }
          const now = performance.now();
          const v = (e.delta.x - lastMove.current.x) / Math.max(8, now - lastMove.current.t);
          lastMove.current = { x: e.delta.x, t: now };
          setTilt((t) => t * 0.5 + Math.max(-14, Math.min(14, v * 12)) * 0.5);
          if (settle.current) clearTimeout(settle.current);
          settle.current = setTimeout(() => setTilt(0), 90);
        }}>
        <div className="board" ref={boardRef}>
          <div className="board-inner">
            <div className="col-heads">
              {columns.map((s) => {
                const n = countFor(s);
                const w = widthOf(s);
                if (colCollapsed[s.id]) {
                  return (
                    <button key={s.id} className="col-head collapsed" style={{ width: w }} title={t('Expand {name}', { name: s.name })}
                      onClick={() => setColCollapsed((c) => ({ ...c, [s.id]: false }))}>
                      <StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} />
                      <span className="n">{n}</span>
                    </button>
                  );
                }
                const manual = manualWidth(s, n) != null;
                return (
                  <div key={s.id} className={`col-head ${w < 180 ? 'narrow' : ''}`} style={{ width: w }} title={w < 180 ? s.name : undefined}
                    onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY }, columnMenu(s)); }}>
                    <StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} />
                    <span className="name">{s.name}</span>
                    <span className="n">{n}</span>
                    {/* Zakończone kolumny pokazują tylko część zadań: zakres widać i zmienia się tutaj (ten sam co w Display). */}
                    {isClosedType(s) && w >= 180 && (
                      <button className="col-range" title={t('Which completed issues are shown')}
                        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ x: r.left, y: r.bottom + 4 }, {
                          searchable: false,
                          items: (Object.keys(COMPLETED_LABEL) as Display['completed'][]).map((k) => ({
                            key: k, label: COMPLETED_LABEL[k], checked: display.completed === k, onSelect: () => { setDisplay((d) => ({ ...d, completed: k })); },
                          })),
                        }); }}>
                        {COMPLETED_LABEL[display.completed]} <Icon.chevron size={10} />
                      </button>
                    )}
                    {manual && <span className="col-manual" title={t('Width set by hand: column menu > Reset width, or double-click the edge')} />}
                    <span className="tools">
                      <button className="icon-btn" title={t('Column options')} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu({ x: r.right, y: r.bottom + 4, alignRight: true }, columnMenu(s)); }}><Icon.dots size={14} /></button>
                      <button className="icon-btn" title={t('New issue in {name}', { name: s.name })} onClick={() => openNewIssue({ statusId: s.id })}><Icon.plus size={14} /></button>
                    </span>
                    <span className="col-resize" title={t('Drag to resize, double-click to reset')} onPointerDown={startResize(s, n, w)}
                      onDoubleClick={() => resetWidth(s, n)} />
                  </div>
                );
              })}
            </div>
            {rows.map((row) => {
              const isCollapsed = collapsed[row.key];
              return (
                <div key={row.key} className="row-group">
                  {display.rows !== 'none' && (
                    <div className={`row-head ${isCollapsed ? 'collapsed' : ''}`} onClick={() => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))}
                      style={{ cursor: 'pointer', ...((display.rows === 'assignee' || display.rows === 'creator') && row.key !== NONE ? { boxShadow: `inset 3px 0 0 ${avatarColor(Number(row.key))}` } : {}) }}>
                      <span className="caret"><Icon.caret /></span>
                      {row.icon}
                      <span>{row.label}</span>
                      <span className="n">{row.issues.length}</span>
                    </div>
                  )}
                  {!isCollapsed && (
                    <div className="row-cols">
                      {columns.map((s) => (
                        <Cell
                          key={s.id}
                          status={s}
                          width={widthOf(s)}
                          collapsed={!!colCollapsed[s.id]}
                          remote={display.livePresence !== false ? presence : []}
                          rowKey={row.key}
                          issues={row.issues.filter((i) => i.statusId === s.id).sort(sorter)}
                          dragging={dragging}
                          meta={meta}
                          onHover={(i) => { hovered.current = i; }}
                          onAdd={() => { const p = rowPatch(row.key, null, null); openNewIssue({ statusId: s.id, assigneeId: p.assigneeId, priority: p.priority, sprintId: p.sprintId, labelIds: p.labelIds }); }}
                          onContext={(i, x, y) => openMenu({ x, y }, issueContextMenu({
                            meta, sprints, t: target(i), update: updateOne(i), meId: me?.id,
                            onOpen: () => navigate(`/issue/${ident(i.number)}`),
                            onDelete: () => {
                              void askConfirm({ title: t('Delete {id}?', { id: ident(i.number) }), body: i.title }).then((ok) => { if (ok) void api(`/api/issues/${ident(i.number)}`, { method: 'DELETE' }).then(() => toast(t('Deleted {id}', { id: ident(i.number) }))); });
                            },
                            onAnalyze: () => void api(`/api/issues/${ident(i.number)}/analyze`, { method: 'POST' }).then(() => toast(t('AI analysis requested'))),
                            onSubIssue: () => openNewIssue({ parentNumber: i.number, assigneeId: i.assigneeId }),
                            onStart: () => void startWork(i.number),
                            onMarkRead: i.unreadComments > 0 ? () => void api('/api/issues/mark-read', { method: 'POST', body: { numbers: [i.number] } }).then(() => void queryClient.invalidateQueries({ queryKey: ['issues'] })) : undefined,
                            allIssues: issues,
                          }))}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {!rows.length && <div className="hint" style={{ padding: 40, textAlign: 'center' }}>{t('No issues match the current filters.')}</div>}
          </div>
        </div>
        {display.livePresence !== false && <RemoteDrags presence={presence} issues={issues} meta={meta} />}
        <DragOverlay modifiers={[restrictToBoard]} dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)' }}>{dragging && <div className="overlay-tilt" style={{ transform: `rotate(${2 + tilt}deg) scale(1.04)` }}><CardView issue={dragging} meta={meta} overlay /></div>}</DragOverlay>
      </DndContext>
      </CardActionsContext.Provider>
      </CardPropsContext.Provider>
      )}
    </>
  );
}

function Cell({ status, rowKey, issues, dragging, meta, onHover, onContext, onAdd, width, collapsed, remote }: {
  width: number; collapsed: boolean; remote: Presence[];
  status: Status; rowKey: string; issues: IssueRow[]; dragging: IssueRow | null; meta: Meta; onAdd: () => void;
  onHover: (i: IssueRow | null) => void; onContext: (i: IssueRow, x: number, y: number) => void;
}) {
  const { setNodeRef, isOver: overCell } = useDroppable({ id: `cell-${status.id}-${rowKey}`, data: { statusId: status.id, rowKey } });
  // Nad kartą w tej komórce też podświetlamy całą komórkę.
  const { over } = useDndContext();
  const overData = over?.data.current as { statusId?: number; rowKey?: string } | undefined;
  const isOver = overCell || (overData?.statusId === status.id && overData?.rowKey === rowKey);
  const warn = dragging && dragging.statusId !== status.id ? doneWarning(status, dragging.hasChangeNotes) : undefined;
  // Zwinięta kolumna nadal przyjmuje upuszczone karty (np. szybkie przeniesienie do Done).
  if (collapsed) {
    return <div ref={setNodeRef} data-cell={`${status.id}|${rowKey}`} style={{ width }} className={`col collapsed ${isOver ? (warn ? 'warn' : 'over') : ''}`} title={isOver && warn ? warn : `${status.name}: ${issues.length}`}>
      <span className="col-vname">{status.name}</span>
    </div>;
  }
  return (
    <div ref={setNodeRef} data-cell={`${status.id}|${rowKey}`} style={{ width }} className={`col ${width < 180 ? 'narrow' : ''} ${isOver ? (warn ? 'warn' : 'over') : ''}`} title={isOver && warn ? warn : undefined}>
      {issues.map((i) => (
        <DraggableCard key={i.id} issue={i} meta={meta} statusId={status.id} rowKey={rowKey} onHover={onHover} onContext={onContext}
          movedBy={remote.find((p) => p.number === i.number)?.name} />
      ))}
      {/* Przy przeciąganiu ukryty, ale zostaje w układzie: inaczej wszystkie wiersze skoczyłyby w górę. */}
      <button className="cell-add" aria-label={t('New issue in {name}', { name: status.name })} title={t('New issue in {name}', { name: status.name })} onClick={() => onAdd()}
        style={dragging ? { visibility: 'hidden' } : undefined}>
        <Icon.plus size={14} />
      </button>
    </div>
  );
}

function DraggableCard({ issue, meta, statusId, rowKey, onHover, onContext, movedBy }: {
  issue: IssueRow; meta: Meta; statusId: number; rowKey: string; movedBy?: string;
  onHover: (i: IssueRow | null) => void; onContext: (i: IssueRow, x: number, y: number) => void;
}) {
  // Id z kluczem wiersza: przy grupowaniu po etykietach ta sama karta bywa w kilku wierszach.
  const drag = useDraggable({ id: `card-${issue.number}-${rowKey}`, data: { rowKey, number: issue.number } });
  // Karta jest też celem upuszczenia, żeby w trybie ręcznym wstawiać przed nią.
  const drop = useDroppable({ id: `before-${issue.number}-${rowKey}`, data: { statusId, rowKey, beforeNumber: issue.number } });
  return (
    <div
      ref={(el) => { drag.setNodeRef(el); drop.setNodeRef(el); }}
      {...drag.listeners}
      {...drag.attributes}
      role="button"
      data-card={issue.number}
      onMouseEnter={() => onHover(issue)}
      onMouseLeave={() => onHover(null)}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) window.open(`/issue/${ident(issue.number)}`, '_blank');
        else navigate(`/issue/${ident(issue.number)}`);
      }}
      onContextMenu={(e) => { e.preventDefault(); onContext(issue, e.clientX, e.clientY); }}
    >
      {movedBy && <span className="remote-tag on-card">{t('{name} is moving', { name: movedBy })}</span>}
      <CardView issue={issue} meta={meta} dragging={drag.isDragging || !!movedBy} />
    </div>
  );
}

export function CardView({ issue, meta, dragging, overlay }: { issue: IssueRow; meta: Meta; dragging?: boolean; overlay?: boolean }) {
  const assignee = meta.users.find((u) => u.id === issue.assigneeId);
  const labels = issue.labelIds.map((id) => meta.labels.find((l) => l.id === id)).filter((l) => !!l);
  const st = meta.statuses.find((s) => s.id === issue.statusId);
  const show = useContext(CardPropsContext);
  // Zamknięte bez notatek HUMAN/AI: brak widać tam, gdzie notatki były wymagane, czyli na Done.
  const notesMissing = show.notes && st?.type === 'completed' && !issue.hasChangeNotes;
  const act = useContext(CardActionsContext);
  const me = useMe().data;
  const askedUser = issue.infoFromId ? meta.users.find((u) => u.id === issue.infoFromId) : null;
  const askedMe = isAskedTo(issue, me?.id);
  const open = st && ['backlog', 'unstarted', 'started'].includes(st.type);
  const idleDays = Math.floor((Date.now() - new Date(issue.updatedAt).getTime()) / 864e5);
  const stale = open && idleDays >= 7;
  // Plakietka nie zaczyna przeciągania i nie otwiera karty.
  const pillProps = (what: CardActionKind) => act ? {
    role: 'button' as const,
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent<HTMLElement>) => { e.stopPropagation(); act(issue, what, e.currentTarget); },
  } : {};
  return (
    <div className={`card ${dragging ? 'dragging' : ''} ${overlay ? 'overlay' : ''} ${issue.priority === 1 || issue.priority === 2 ? 'prio-' + issue.priority : ''} ${stale ? 'stale' : ''} ${askedMe ? 'ask-me' : ''}`}
      title={stale ? tn(idleDays, 'No changes for {n} day', 'No changes for {n} days') : undefined}>
      <div className="card-top">
        {show.id && <span className="card-id">{ident(issue.number)}</span>}
        {show.assignee && <span className="avatar-slot" {...pillProps('assignee')}><Avatar user={assignee} size={18} /></span>}
      </div>
      <div className="card-title"><InlineCode text={issue.title} /></div>
      <div className="card-meta">
        {show.blocked && issue.waitingOn.length > 0 && (
          <span className="pill blocked" title={t('Waiting on {ids}', { ids: issue.waitingOn.map((n) => ident(n)).join(', ') })}>
            <Icon.blocked size={12} /> {t('Waiting on {ids}', { ids: issue.waitingOn.map((n) => ident(n)).join(', ') })}
          </span>
        )}
        {issue.unreadComments > 0 && (
          <span className="pill unread" title={tn(issue.unreadComments, '{n} new comment since you last opened it', '{n} new comments since you last opened it')}>
            <Icon.comment size={12} /> {t('{n} new', { n: issue.unreadComments })}
          </span>
        )}
        {issue.infoQuestion && (
          <span className={`pill question ${askedMe ? 'me' : ''}`} title={issue.infoQuestion}>
            <Icon.question size={12} /> {askedMe ? (askedUser ? t('Asked you') : t('Asked everyone')) : t('Asking {name}', { name: askedUser?.name ?? t('anyone') })}
          </span>
        )}
        {show.priority && <span className="pill icon-only" title={t(meta.priorities[issue.priority])} {...pillProps('priority')}><PriorityIcon priority={issue.priority} /></span>}
        {show.subIssues && issue.subTotal > 0 && (
          <span className="pill" title={t('Sub-issues')}>
            <SubProgress done={issue.subDone} total={issue.subTotal} /> {issue.subDone}/{issue.subTotal}
          </span>
        )}
        {show.labels && labels.map((l) => (
          <span key={l.id} className="pill" {...pillProps('labels')}><span className="dot" style={{ background: l.color }} />{l.name}</span>
        ))}
        {show.ai && issue.analysisRequestedAt && (issue.analysisClaimedAt
          ? <span className="pill ai" title={t('A PC is running the AI analysis')}><Icon.sparkle size={12} /> {t('Analysis running')}</span>
          : <span className="pill ai" title={t('Waiting for AI analysis')}><Icon.sparkle size={12} /> {t('Analysis pending')}</span>)}
        {show.ai && !issue.analysisRequestedAt && issue.hasAnalysis && <span className="pill ai done" title={t('AI analysis available')}><Icon.sparkle size={12} /></span>}
        {notesMissing && <span className="pill notes-missing" title={t('Done without HUMAN / AI change notes')}>{t('Notes missing')}</span>}
      </div>
    </div>
  );
}

export function SubProgress({ done, total, size = 12 }: { done: number; total: number; size?: number }) {
  const r = 5;
  const c = 2 * Math.PI * r;
  const f = total ? done / total : 0;
  return (
    <svg className="i" width={size} height={size} viewBox="0 0 14 14">
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--text-quaternary)" strokeWidth="1.6" />
      <circle cx="7" cy="7" r={r} fill="none" stroke={f === 1 ? 'var(--accent)' : 'var(--text-secondary)'} strokeWidth="1.6" strokeDasharray={`${c * f} ${c}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

// Rozłożony składak (np. Fold 6, ok. 700 px) dostaje listę z podglądem; wąskie okno przeglądarki na komputerze zostaje przy zakładkach.
const SPLIT_Q = '(min-width: 600px) and (max-width: 1100px) and (pointer: coarse)';
const PHONE_Q = '(max-width: 760px)';
function useNarrow(): 'phone' | 'split' | null {
  const get = (): 'phone' | 'split' | null => (window.matchMedia(SPLIT_Q).matches ? 'split' : window.matchMedia(PHONE_Q).matches ? 'phone' : null);
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    const ms = [window.matchMedia(SPLIT_Q), window.matchMedia(PHONE_Q)];
    const on = () => setNarrow(get());
    ms.forEach((m) => m.addEventListener('change', on));
    return () => ms.forEach((m) => m.removeEventListener('change', on));
  }, []);
  return narrow;
}

const PROP_LABELS: [keyof CardProps, string][] = [
  ['id', 'ID'], ['assignee', t('Assignee')], ['priority', t('Priority')], ['labels', t('Labels')],
  ['subIssues', t('Sub-issues')], ['blocked', t('Waiting on')], ['ai', t('AI analysis')], ['notes', t('Notes missing')],
];

/** Panel "Display" na wzór Lineara: wybory, przełączniki i właściwości karty. */
function DisplayPanel({ at, display, setDisplay, onClose }: {
  at: { x: number; y: number }; display: Display; setDisplay: (fn: (d: Display) => Display) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(el) && !el.closest?.('[data-display-btn]')) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [onClose]);
  const set = <K extends keyof Display>(k: K, v: Display[K]) => setDisplay((d) => ({ ...d, [k]: v }));
  const props = { ...ALL_PROPS, ...display.props };
  const toggle = (k: 'showSubIssues' | 'showEmptyRows' | 'showHidden' | 'livePresence', label: string) => (
    <button className="row" onClick={() => set(k, !display[k])}>
      <span>{label}</span><span className={`switch ${display[k] ? 'on' : ''}`} role="switch" aria-checked={display[k]} />
    </button>
  );
  return (
    <div ref={ref} className="display-panel" style={{ left: Math.max(8, at.x - 330), top: at.y }}>
      <div className="sec">
        <label className="row">{t('Rows')}
          <select value={display.rows} onChange={(e) => set('rows', e.target.value as Display['rows'])}>
            <option value="assignee">{t('Assignee')}</option><option value="priority">{t('Priority')}</option><option value="label">{t('Label')}</option>
            <option value="sprint">{t('Sprint')}</option><option value="creator">{t('Creator')}</option><option value="none">{t('No grouping')}</option>
          </select>
        </label>
        <label className="row">{t('Ordering')}
          <select value={display.ordering} onChange={(e) => set('ordering', e.target.value as Display['ordering'])}>
            <option value="priority">{t('Priority')}</option><option value="manual">{t('Manual')}</option>
            <option value="updated">{t('Last updated')}</option><option value="created">{t('Newest')}</option>
            <option value="oldest">{t('Oldest')}</option><option value="title">{t('Title')}</option><option value="assignee">{t('Assignee')}</option>
          </select>
        </label>
      </div>
      <div className="sec">
        <label className="row">{t('Completed issues')}
          <select value={display.completed} onChange={(e) => set('completed', e.target.value as Display['completed'])}>
            <option value="day">{t('Past day')}</option><option value="week">{t('Past week')}</option>
            <option value="month">{t('Past month')}</option><option value="all">{t('All')}</option>
          </select>
        </label>
        {toggle('showSubIssues', t('Show sub-issues'))}
      </div>
      <div className="sec">
        <span className="title">{t('Board options')}</span>
        {toggle('showHidden', t('Show Backlog / Canceled columns'))}
        {toggle('showEmptyRows', t('Show empty rows'))}
        {toggle('livePresence', t('Show others dragging cards'))}
        <span>{t('Display properties')}</span>
        <div className="prop-chips">
          {PROP_LABELS.map(([k, label]) => (
            <button key={k} className={`prop-chip ${props[k] ? 'on' : ''}`} onClick={() => set('props', { ...props, [k]: !props[k] })}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

type BoardRow = { key: string; label: string; icon: React.ReactNode; issues: IssueRow[] };

/** Klucze wierszy, w których pokazuje się karta (etykiet może być kilka). */
function rowKeysOf(i: IssueRow, by: RowsBy): string[] {
  switch (by) {
    case 'assignee': return [i.assigneeId == null ? NONE : String(i.assigneeId)];
    case 'creator': return [i.creatorId == null ? NONE : String(i.creatorId)];
    case 'priority': return [String(i.priority)];
    case 'sprint': return [i.sprintId == null ? NONE : String(i.sprintId)];
    case 'label': return i.labelIds.length ? i.labelIds.map(String) : [NONE];
    default: return ['all'];
  }
}

/** Pasek postępu bieżącego sprintu: zrobione / w toku / do zrobienia. */
function SprintProgress({ issues, meta, sprintId }: { issues: IssueRow[]; meta: Meta; sprintId?: number }) {
  if (!sprintId) return null;
  const typeOf = (i: IssueRow) => meta.statuses.find((s) => s.id === i.statusId)?.type;
  const list = issues.filter((i) => i.sprintId === sprintId && !i.parentId && !['canceled', 'duplicate'].includes(typeOf(i) ?? ''));
  const done = list.filter((i) => typeOf(i) === 'completed').length;
  const doing = list.filter((i) => typeOf(i) === 'started').length;
  const todo = list.length - done - doing;
  const pct = (n: number) => (list.length ? (n / list.length) * 100 : 0);
  return (
    <span className="sprint-progress" title={t('{done} done · {doing} in progress · {todo} to do', { done, doing, todo })}>
      <span className="bar"><i style={{ width: pct(done) + '%', background: 'var(--accent)' }} /><i style={{ width: pct(doing) + '%', background: 'var(--progress)' }} /></span>
      <span className="hint">{done}/{list.length}</span>
    </span>
  );
}

/**
 * Karty przeciągane przez inne osoby, w tym samym miejscu boardu co u nich:
 * pozycja to komórka plus ułamek jej szerokości/wysokości, więc działa przy innych szerokościach kolumn.
 */
/** Przeciągana karta zostaje w obrębie boardu (nie wjeżdża na pasek boczny ani nagłówek). */
const restrictToBoard: Modifier = ({ transform, draggingNodeRect }) => {
  const b = document.querySelector('.board')?.getBoundingClientRect();
  if (!b || !draggingNodeRect) return transform;
  const x = Math.min(Math.max(transform.x, b.left - draggingNodeRect.left), b.right - draggingNodeRect.right);
  const y = Math.min(Math.max(transform.y, b.top - draggingNodeRect.top), b.bottom - draggingNodeRect.top - 40);
  return { ...transform, x, y };
};

function RemoteDrags({ presence, issues, meta }: { presence: Presence[]; issues: IssueRow[]; meta: Meta }) {
  const [, force] = useState(0);
  // Przewinięcie boardu przesuwa komórki: przeliczamy pozycje.
  useEffect(() => {
    const board = document.querySelector('.board');
    const on = () => force((x) => x + 1);
    board?.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { board?.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, []);
  return (
    <>
      {presence.map((p) => {
        const issue = issues.find((i) => i.number === p.number);
        if (!issue || p.statusId == null) return null;
        // Każdy może mieć inne wiersze (grupowanie, zwinięte) i szerokości: gdy nie ma tej samej komórki,
        // pokazujemy podgląd w tej samej kolumnie, w jej pierwszej widocznej komórce.
        const exact = document.querySelector<HTMLElement>(`[data-cell="${p.statusId}|${p.rowKey}"]`);
        const cell = exact ?? document.querySelector<HTMLElement>(`[data-cell^="${p.statusId}|"]`);
        if (!cell) return null;
        const r = cell.getBoundingClientRect();
        const board = document.querySelector('.board')?.getBoundingClientRect();
        const x = r.left + (exact ? p.fx ?? 0.5 : 0.5) * r.width;
        let y = exact ? r.top + (p.fy ?? 0.1) * r.height : Math.max(r.top, (board?.top ?? 0) + 60) + 12;
        if (board) y = Math.min(Math.max(y, board.top + 40), board.bottom - 40);
        const width = Math.max(220, Math.min(300, r.width - 12));
        return (
          <div key={p.userId} className="remote-drag" style={{ transform: `translate(${x - 40}px, ${y - 18}px) rotate(2deg)` }}>
            <span className="remote-cursor"><Icon.cursor size={14} /> {p.name}</span>
            <div style={{ width }}><CardView issue={issue} meta={meta} overlay /></div>
          </div>
        );
      })}
    </>
  );
}
