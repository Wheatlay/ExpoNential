import { api, type IssuePatch, type IssueRow, type Meta, type RelationKind, type Sprint, type Status } from './api.ts';
import { copyText, toast } from './toast.ts';
import { openAsk } from './AskModal.tsx';
import { guardDone } from './DoneGuard.tsx';
import { isNeedInfo } from '../server/rules.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { type MenuItem, type MenuSpec } from './menu.tsx';
import { ident } from './project.ts';
import { locale, t } from './i18n.ts';

/** Minimum, które pickery muszą wiedzieć o zadaniu. */
export type PickTarget = {
  number: number; statusId: number; priority: number; assigneeId: number | null; labelIds: number[];
  sprintId: number | null; hasChangeNotes: boolean;
  /** Czy zadanie było kiedyś w Testing (brak = nie wiadomo, nie ostrzegamy). */
  wasTested?: boolean;
};
type Update = (patch: IssuePatch) => void;

export const DONE_WARNING = t('No HUMAN / AI change notes yet');

/** Done bez opisów zmian jest dozwolone, tylko ostrzegamy (miękka reguła). */
export function doneWarning(status: Status, hasChangeNotes: boolean) {
  return status.type === 'completed' && !hasChangeNotes ? DONE_WARNING : undefined;
}

export function statusMenu(meta: Meta, tg: PickTarget, update: Update): MenuSpec {
  return {
    searchable: true,
    placeholder: t('Change status…'),
    items: meta.statuses.map((s, i) => ({
      key: `s${s.id}`,
      label: s.name,
      icon: <StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} />,
      checked: s.id === tg.statusId,
      kbd: [String(i + 1)],
      // Need Info na istniejącym zadaniu otwiera okno pytania (kogo i o co).
      onSelect: () => {
        if (tg.number > 0 && isNeedInfo(s) && s.id !== tg.statusId) return openAsk({ number: tg.number, statusId: s.id });
        if (guardDone(meta, s, tg)) return;
        update({ statusId: s.id });
      },
    })),
  };
}

export function priorityMenu(meta: Meta, tg: PickTarget, update: Update): MenuSpec {
  const order = [0, 1, 2, 3, 4];
  return {
    searchable: false,
    items: order.map((p) => ({
      key: `p${p}`,
      label: t(meta.priorities[p]),
      icon: <PriorityIcon priority={p} />,
      checked: p === tg.priority,
      kbd: [String(p)],
      onSelect: () => update({ priority: p }),
    })),
  };
}

export function assigneeMenu(meta: Meta, tg: PickTarget, update: Update, meId?: number): MenuSpec {
  const users = meta.users.filter((u) => u.active);
  const me = users.find((u) => u.id === meId);
  const ordered = me ? [me, ...users.filter((u) => u.id !== meId)] : users;
  return {
    searchable: true,
    placeholder: t('Assign to…'),
    items: [
      { key: 'none', label: t('No assignee'), icon: <Avatar user={null} size={16} />, checked: tg.assigneeId == null, onSelect: () => update({ assigneeId: null }) },
      ...ordered.map((u) => ({
        key: `u${u.id}`,
        label: u.id === meId ? `${u.name} ${t('(you)')}` : u.name,
        icon: <Avatar user={u} size={16} />,
        checked: u.id === tg.assigneeId,
        onSelect: () => update({ assigneeId: u.id }),
      })),
    ],
  };
}

/** Multi-select: menu zostaje otwarte i odświeża ptaszki. */
export function labelMenu(meta: Meta, tg: PickTarget, update: Update): MenuSpec {
  const build = (current: number[]): MenuSpec => ({
    searchable: true,
    placeholder: t('Change or add labels…'),
    items: meta.labels.map((l) => ({
      key: `l${l.id}`,
      label: l.name,
      icon: <span className="dot" style={{ background: l.color }} />,
      checked: current.includes(l.id),
      keepOpen: true,
      onSelect: () => {
        const next = current.includes(l.id) ? current.filter((x) => x !== l.id) : [...current, l.id];
        update({ labelIds: next });
        return build(next);
      },
    })),
  });
  return build(tg.labelIds);
}

export function sprintLabel(s: Sprint) {
  const f = (d: string) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return `${s.name} · ${f(s.startsAt)} – ${f(s.endsAt)}`;
}

export function sprintMenu(sprints: Sprint[], tg: PickTarget, update: Update): MenuSpec {
  const open = sprints.filter((s) => s.status === 'active' || s.status === 'planned');
  return {
    searchable: false,
    items: [
      { key: 'none', label: t('No sprint'), icon: <Icon.sprint size={14} />, checked: tg.sprintId == null, onSelect: () => update({ sprintId: null }) },
      ...open.map((s) => ({
        key: `sp${s.id}`,
        label: `${sprintLabel(s)}${s.status === 'active' ? ` ${t('(current)')}` : ''}`,
        icon: <Icon.sprint size={14} />,
        checked: s.id === tg.sprintId,
        onSelect: () => update({ sprintId: s.id }),
      })),
    ],
  };
}

/** Menu kontekstowe karty: okrojona wersja menu Lineara. */
export function issueContextMenu(opts: {
  meta: Meta; sprints: Sprint[]; t: PickTarget; update: Update; meId?: number;
  onOpen: () => void; onDelete: () => void; onAnalyze: () => void; onSubIssue: () => void; onStart?: () => void; onMarkRead?: () => void; allIssues?: IssueRow[];
}): MenuSpec {
  const { meta, sprints, t: tg, update, meId } = opts;
  const url = `${location.origin}/issue/${ident(tg.number)}`;
  const items: MenuItem[] = [
    { key: 'status', label: t('Status'), icon: <StatusIcon status={meta.statuses.find((s) => s.id === tg.statusId) ?? { type: 'unstarted', color: '#888' }} />, kbd: ['S'], submenu: () => statusMenu(meta, tg, update) },
    { key: 'priority', label: t('Priority'), icon: <PriorityIcon priority={tg.priority} colored={false} />, kbd: ['P'], submenu: () => priorityMenu(meta, tg, update) },
    { key: 'assignee', label: t('Assignee'), icon: <Icon.user size={14} />, kbd: ['A'], submenu: () => assigneeMenu(meta, tg, update, meId) },
    { key: 'labels', label: t('Labels'), icon: <Icon.label size={14} />, kbd: ['L'], submenu: () => labelMenu(meta, tg, update) },
    { key: 'sprint', label: t('Sprint'), icon: <Icon.sprint size={14} />, kbd: ['C'], submenu: () => sprintMenu(sprints, tg, update) },
    { key: 'sep1', separator: true },
    ...(opts.onMarkRead ? [{ key: 'read', label: t('Mark as read'), icon: <Icon.check size={14} />, onSelect: opts.onMarkRead }] : []),
    ...(opts.onStart ? [{ key: 'start', label: t('Start work in Claude'), icon: <Icon.play size={14} />, onSelect: opts.onStart }] : []),
    { key: 'analyze', label: t('Request AI analysis'), icon: <Icon.sparkle size={14} />, onSelect: opts.onAnalyze },
    { key: 'sub', label: t('Add sub-issue'), icon: <Icon.sub size={14} />, onSelect: opts.onSubIssue },
    ...(opts.allIssues ? [{ key: 'relation', label: t('Add relation'), icon: <Icon.relation size={14} />, kbd: ['R'], submenu: () => relationMenu(opts.allIssues!, tg.number, undefined, meta.statuses) }] : []),
    { key: 'sep2', separator: true },
    { key: 'open', label: t('Open'), icon: <Icon.chevronRight size={14} />, kbd: ['↵'], onSelect: opts.onOpen },
    { key: 'copyid', label: t('Copy ID'), icon: <Icon.copy size={14} />, onSelect: () => copyText(`${ident(tg.number)}`, t('ID copied')) },
    { key: 'copyurl', label: t('Copy link'), icon: <Icon.link size={14} />, onSelect: () => copyText(url, t('Link copied')) },
    { key: 'sep3', separator: true },
    { key: 'delete', label: t('Delete'), icon: <Icon.trash size={14} />, danger: true, onSelect: opts.onDelete },
  ];
  return { searchable: false, items };
}

export const RELATION_LABELS: Record<RelationKind, string> = { waits_on: t('Waiting on…'), blocks: t('Blocks…'), related: t('Related to…') };
/** Zdanie po identyfikatorze: "ACME-3 waits on ACME-5". */
const RELATION_VERB: Record<RelationKind, string> = { waits_on: t('waits on'), blocks: t('blocks'), related: t('is related to') };

/** Ikona statusu zgłoszenia w listach wyboru zgłoszeń (rodzic, relacja), jak przy wzmiance. */
export function issueStatusIcon(statuses: Status[] | undefined, statusId: number) {
  const s = statuses?.find((x) => x.id === statusId);
  return s ? <StatusIcon status={s} fraction={startedFraction(statuses!, s)} /> : undefined;
}

/** Relacja w dwóch krokach: rodzaj zdaniem, potem zadanie z wyszukiwarki. */
export function relationMenu(all: IssueRow[], number: number, onDone?: () => void, statuses?: Status[]): MenuSpec {
  const pick = (kind: RelationKind): MenuSpec => ({
    searchable: true,
    placeholder: `${ident(number)} ${RELATION_VERB[kind]}…`,
    items: all.filter((i) => i.number !== number).sort((a, b) => b.number - a.number).map((i) => ({
      key: `r${i.number}`,
      label: `${ident(i.number)} ${i.title}`,
      icon: issueStatusIcon(statuses, i.statusId),
      onSelect: () => {
        void api(`/api/issues/${ident(number)}/relations`, { method: 'POST', body: { kind, other: i.number } })
          .then(() => { toast(`${ident(number)} ${RELATION_VERB[kind]} ${ident(i.number)}`); onDone?.(); })
          .catch((e: Error) => toast(e.message, 'err'));
      },
    })),
  });
  return {
    searchable: false,
    items: (['waits_on', 'blocks', 'related'] as RelationKind[]).map((k) => ({
      key: k, label: RELATION_LABELS[k],
      icon: k === 'related' ? <Icon.relation size={14} /> : <Icon.blocked size={14} />,
      submenu: () => pick(k),
    })),
  };
}

/** Relacja otwartego zgłoszenia z gotowym drugim (wzmianka w tekście): od razu zdania, bez wyszukiwarki. */
export function relationToMenu(number: number, other: number, onDone?: () => void): MenuSpec {
  return {
    searchable: false,
    items: (['waits_on', 'blocks', 'related'] as RelationKind[]).map((k) => ({
      key: k, label: `${ident(number)} ${RELATION_VERB[k]} ${ident(other)}`,
      icon: k === 'related' ? <Icon.relation size={14} /> : <Icon.blocked size={14} />,
      onSelect: () => {
        void api(`/api/issues/${ident(number)}/relations`, { method: 'POST', body: { kind: k, other } })
          .then(() => { toast(`${ident(number)} ${RELATION_VERB[k]} ${ident(other)}`); onDone?.(); })
          .catch((e: Error) => toast(e.message, 'err'));
      },
    })),
  };
}
