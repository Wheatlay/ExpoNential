import { useEffect, useRef, useState } from 'react';
import { useMe, useUpdateIssue, type IssueRow, type Meta, type Status } from './api.ts';
import { Avatar, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, type MenuItem } from './menu.tsx';
import { statusMenu } from './pickers.tsx';
import { navigate } from './router.ts';
import { IssuePage } from './IssuePage.tsx';
import { InlineCode } from './InlineCode.tsx';
import { ident } from './project.ts';
import { startOnPc } from './startWork.ts';
import { toast } from './toast.ts';
import { t } from './i18n.ts';

type Props = { columns: Status[]; visible: IssueRow[]; sorter: (a: IssueRow, b: IssueRow) => number; meta: Meta };

const isClosed = (s: Status) => s.type === 'completed' || s.type === 'canceled' || s.type === 'duplicate';

/** Przytrzymanie wiersza (na Androidzie to contextmenu) otwiera arkusz od dołu: statusy i "Assign to me". */
function useMoveSheet(meta: Meta) {
  const update = useUpdateIssue();
  const me = useMe().data;
  return (i: IssueRow, onOpen: () => void) => {
    const patch = (p: Parameters<typeof update.mutate>[0]['patch']) => update.mutate({ number: i.number, patch: p });
    const items: MenuItem[] = [
      ...statusMenu(meta, { ...i }, patch).items.map((it) => ({ ...it, kbd: undefined })),
      { key: 'sep', separator: true },
      { key: 'me', label: t('Assign to me'), checked: !!me && i.assigneeId === me.id, onSelect: () => { if (me) patch({ assigneeId: me.id }); } },
      // Start na moim komputerze: wyszarzone z powodem, gdy agent jest offline (nie chowamy pozycji).
      ...(me && !me.demo && me.localAgentAt ? [{
        key: 'start', label: t('Start on my PC'), disabledReason: me.agentOnline ? undefined : t('Your PC is offline'),
        onSelect: () => { void startOnPc(i.number).catch((e: Error) => toast(e.message, 'err')); },
      } satisfies MenuItem] : []),
      { key: 'open', label: t('Open'), onSelect: onOpen },
    ];
    openMenu({ x: 0, y: 0, sheet: true }, { searchable: false, items });
  };
}

function Row({ issue, meta, active, onOpen, onHold }: { issue: IssueRow; meta: Meta; active?: boolean; onOpen: () => void; onHold: () => void }) {
  const assignee = meta.users.find((u) => u.id === issue.assigneeId);
  return (
    <button className={`m-row ${active ? 'on' : ''}`} onClick={onOpen} onContextMenu={(e) => { e.preventDefault(); onHold(); }}>
      <PriorityIcon priority={issue.priority} />
      <span className="m-row-id">{ident(issue.number)}</span>
      <span className="m-row-title"><InlineCode text={issue.title} /></span>
      <Avatar user={assignee} size={20} />
    </button>
  );
}

/** Telefon złożony: zakładki statusów, jeden status naraz, przesunięcie palcem zmienia zakładkę. */
export function PhoneBoard({ columns, visible, sorter, meta }: Props) {
  const firstStarted = columns.find((s) => s.type === 'started' && visible.some((i) => i.statusId === s.id)) ?? columns[0];
  const [tab, setTab] = useState<number | undefined>(firstStarted?.id);
  const cur = columns.find((s) => s.id === tab) ?? columns[0];
  const tabsRef = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const hold = useMoveSheet(meta);
  useEffect(() => { tabsRef.current?.querySelector('.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [cur?.id]);
  if (!cur) return null;
  const list = visible.filter((i) => i.statusId === cur.id).sort(sorter);
  const step = (d: number) => { const n = columns[columns.indexOf(cur) + d]; if (n) setTab(n.id); };
  return (
    <div className="phone-board"
      onTouchStart={(e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
      onTouchEnd={(e) => {
        const s = touch.current; touch.current = null;
        if (!s) return;
        const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
        if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
      }}>
      <div className="phone-tabs" ref={tabsRef}>
        <div className="seg">
          {columns.map((s) => (
            <button key={s.id} className={s.id === cur.id ? 'on' : ''} onClick={() => setTab(s.id)}>
              <StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} /> {s.name} <span className="n">{visible.filter((i) => i.statusId === s.id).length}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="m-list">
        {list.map((i) => <Row key={i.id} issue={i} meta={meta} onOpen={() => navigate(`/issue/${ident(i.number)}`)} onHold={() => hold(i, () => navigate(`/issue/${ident(i.number)}`))} />)}
        {!list.length && <div className="hint m-empty">{t('No issues in {name}', { name: cur.name })}</div>}
      </div>
    </div>
  );
}

/** Telefon rozłożony: lista po lewej, otwarte zgłoszenie po prawej. Zamknięte statusy zwinięte. */
export function SplitBoard({ columns, visible, sorter, meta }: Props) {
  const [sel, setSel] = useState<number | null>(null);
  const [openClosed, setOpenClosed] = useState<Record<number, boolean>>({});
  const hold = useMoveSheet(meta);
  return (
    <div className="split-board">
      <div className="split-list">
        {columns.map((s) => {
          const list = visible.filter((i) => i.statusId === s.id).sort(sorter);
          if (!list.length) return null;
          const shut = isClosed(s) && !openClosed[s.id];
          return (
            <section key={s.id}>
              <button className="m-head" onClick={() => isClosed(s) && setOpenClosed((o) => ({ ...o, [s.id]: !o[s.id] }))}>
                <StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} /> {s.name} <span className="n">{list.length}</span>
              </button>
              {!shut && list.map((i) => <Row key={i.id} issue={i} meta={meta} active={sel === i.number} onOpen={() => setSel(i.number)} onHold={() => hold(i, () => setSel(i.number))} />)}
            </section>
          );
        })}
      </div>
      <div className="split-detail">
        {sel != null ? <IssuePage key={sel} number={sel} /> : <div className="hint m-empty">{t('Select an issue to see it here')}</div>}
      </div>
    </div>
  );
}
