import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useIssues, useMe, useMeta, useUpdateIssue, type IssuePatch } from './api.ts';
import { Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, type MenuSpec } from './menu.tsx';
import { assigneeMenu, priorityMenu, statusMenu } from './pickers.tsx';
import { linkProps, navigate } from './router.ts';
import { copyText } from './toast.ts';
import { t } from './i18n.ts';
import { getProjectKey } from './project.ts';
import { ImageBlock } from './ImageBlock.tsx';

const ISSUE_ID = /\b[A-Z]{2,6}-\d+\b/g;

// Goły identyfikator (ACME-12) staje się linkiem do zgłoszenia; kod i istniejące linki zostają nietknięte.
function linkIssues(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\))/).map((part, i) =>
    i % 2 ? part : part.replace(ISSUE_ID, (id) => `[${id}](/issue/${id})`)).join('');
}

/** Wzmianka o zgłoszeniu jak w Linearze: ikona statusu, id i tytuł. Inny projekt albo brak w liście = zwykły link. */
function IssueMention({ id }: { id: string }) {
  const issues = useIssues().data;
  const meta = useMeta().data;
  const [key, num] = [id.slice(0, id.lastIndexOf('-')), Number(id.slice(id.lastIndexOf('-') + 1))];
  const row = key === getProjectKey() ? issues?.find((x) => x.number === num) : undefined;
  const update = useUpdateIssue();
  const me = useMe().data;
  const st = row && meta?.statuses.find((s) => s.id === row.statusId);
  if (!row || !st || !meta) return <a {...linkProps(`/issue/${id}`)}>{id}</a>;
  const path = `/issue/${id}`;
  const upd = (patch: IssuePatch) => update.mutate({ number: row.number, patch });
  // Prawy przycisk: menu aplikacji jak przy podzadaniu. Środkowy i Ctrl+klik obsługuje przeglądarka (prawdziwy href).
  const menu = (): MenuSpec => ({
    searchable: false,
    items: [
      { key: 'open', label: t('Open'), icon: <Icon.chevronRight size={14} />, onSelect: () => navigate(path) },
      { key: 'tab', label: t('Open in new tab'), icon: <Icon.link size={14} />, onSelect: () => void window.open(path, '_blank') },
      { key: 'sep', separator: true },
      { key: 'status', label: t('Status'), icon: <StatusIcon status={st} />, submenu: () => statusMenu(meta, row, upd) },
      { key: 'priority', label: t('Priority'), icon: <PriorityIcon priority={row.priority} colored={false} />, submenu: () => priorityMenu(meta, row, upd) },
      { key: 'assignee', label: t('Assignee'), icon: <Icon.user size={14} />, submenu: () => assigneeMenu(meta, row, upd, me?.id) },
      { key: 'sep2', separator: true },
      { key: 'copyid', label: t('Copy ID'), icon: <Icon.copy size={14} />, onSelect: () => copyText(id, t('ID copied')) },
      { key: 'copyurl', label: t('Copy link'), icon: <Icon.link size={14} />, onSelect: () => copyText(`${location.origin}${path}`, t('Link copied')) },
    ],
  });
  return (
    <a className="issue-mention" {...linkProps(path)} title={`${st.name} · ${row.title}`}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu({ x: e.clientX, y: e.clientY }, menu()); }}>
      <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} size={12} />
      <span className="id">{id}</span>
      <span className="t">{row.title}</span>
    </a>
  );
}

export function Markdown({ text, empty, className = '' }: { text: string; empty?: string; className?: string }) {
  if (!text.trim()) return <div className={`md empty ${className}`}>{empty ?? ''}</div>;
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{
        // Linki do innych zadań (/issue/ACME-…) nawigują w aplikacji, zewnętrzne w nowej karcie.
        img: ({ node: _n, src, alt }) => <ImageBlock src={typeof src === 'string' ? src : undefined} alt={alt} />,
        a: ({ node: _n, href, children, ...p }) => {
          const m = href && /^\/issue\/([A-Z]{2,6}-\d+)$/.exec(href);
          if (m && children === m[1]) return <IssueMention id={m[1]} />;
          return href?.startsWith('/') ? <a {...p} {...linkProps(href)}>{children}</a> : <a {...p} href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}>
        {linkIssues(text)}
      </ReactMarkdown>
    </div>
  );
}
