import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useIssues, useMe, useMeta, useProjects, useUpdateIssue, type IssuePatch } from './api.ts';
import { Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openMenu, type MenuSpec } from './menu.tsx';
import { assigneeMenu, priorityMenu, statusMenu } from './pickers.tsx';
import { linkProps, navigate } from './router.ts';
import { copyText } from './toast.ts';
import { t } from './i18n.ts';
import { getProjectKey } from './project.ts';
import { ImageBlock } from './ImageBlock.tsx';

// Kod, istniejące linki i gołe adresy zostają nietknięte (nieparzyste kawałki po split).
const SKIP = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+)/;
// Znacznik w tytule linku: odróżnia wzmiankę od ręcznie wpisanego linku do zgłoszenia.
const MENTION = 'issue-mention';

/**
 * Wzorzec wzmianki: tylko klucze istniejących projektów (inaczej UTF-8 czy ISO-9001 stałyby się linkami),
 * dowolna wielkość liter, myślnik, spacja albo nic przed numerem: CHUB-172, chub 172, chub172.
 */
function useMentionPattern() {
  const keys = new Set((useProjects().data ?? []).map((p) => p.key));
  if (getProjectKey()) keys.add(getProjectKey());
  if (!keys.size) return null;
  return new RegExp(`(?<![\\w/-])(${[...keys].join('|')})[- ]?(\\d+)\\b`, 'gi');
}

function linkIssues(text: string, re: RegExp | null) {
  if (!re) return text;
  return text.split(SKIP).map((part, i) =>
    i % 2 ? part : part.replace(re, (all, key: string, num: string) => `[${all}](/issue/${key.toUpperCase()}-${num} "${MENTION}")`)).join('');
}

/** Identyfikatory rozpoznane w tekście, bez powtórzeń, w kolejności wystąpienia. */
function findMentions(text: string, re: RegExp | null) {
  if (!re) return [];
  const ids = text.split(SKIP).filter((_, i) => i % 2 === 0)
    .flatMap((part) => [...part.matchAll(re)].map((m) => `${m[1].toUpperCase()}-${m[2]}`));
  return [...new Set(ids)];
}

/** Pod polem edycji: które zgłoszenia tekst rozpozna, zanim ktoś zapisze. Chipy tylko do podglądu (klik nie zabiera z edycji). */
export function MentionHint({ text }: { text: string }) {
  const ids = findMentions(text, useMentionPattern());
  if (!ids.length) return null;
  return (
    <div className="mention-hint">
      <span className="hint">{t('Links to')}</span>
      {ids.map((id) => <IssueMention key={id} id={id} preview />)}
    </div>
  );
}

/** Wzmianka o zgłoszeniu jak w Linearze: ikona statusu, id i tytuł. Inny projekt albo brak w liście = zwykły link. */
function IssueMention({ id, preview }: { id: string; preview?: boolean }) {
  const issues = useIssues().data;
  const meta = useMeta().data;
  const [key, num] = [id.slice(0, id.lastIndexOf('-')), Number(id.slice(id.lastIndexOf('-') + 1))];
  const row = key === getProjectKey() ? issues?.find((x) => x.number === num) : undefined;
  const update = useUpdateIssue();
  const me = useMe().data;
  const st = row && meta?.statuses.find((s) => s.id === row.statusId);
  if (!row || !st || !meta) return preview ? <span className="issue-mention"><span className="id">{id}</span></span> : <a {...linkProps(`/issue/${id}`)}>{id}</a>;
  if (preview) {
    return (
      <span className="issue-mention" title={`${st.name} · ${row.title}`}>
        <StatusIcon status={st} fraction={startedFraction(meta.statuses, st)} size={12} />
        <span className="id">{id}</span>
        <span className="t">{row.title}</span>
      </span>
    );
  }
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
  const re = useMentionPattern();
  if (!text.trim()) return <div className={`md empty ${className}`}>{empty ?? ''}</div>;
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{
        // Linki do innych zadań (/issue/ACME-…) nawigują w aplikacji, zewnętrzne w nowej karcie.
        img: ({ node: _n, src, alt }) => <ImageBlock src={typeof src === 'string' ? src : undefined} alt={alt} />,
        a: ({ node: _n, href, children, title, ...p }) => {
          const m = title === MENTION && href && /^\/issue\/([A-Z]{2,6}-\d+)$/.exec(href);
          if (m) return <IssueMention id={m[1]} />;
          return href?.startsWith('/') ? <a {...p} title={title} {...linkProps(href)}>{children}</a> : <a {...p} title={title} href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}>
        {linkIssues(text, re)}
      </ReactMarkdown>
    </div>
  );
}
