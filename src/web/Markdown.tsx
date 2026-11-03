import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { queryClient, useIssues, useMe, useMeta, useProjects, useUpdateIssue, type IssuePatch, type Meta } from './api.ts';
import { Avatar, Icon, PriorityIcon, StatusIcon, startedFraction } from './icons.tsx';
import { openPersonCard } from './PersonCard.tsx';
import { openMenu, type MenuSpec } from './menu.tsx';
import { assigneeMenu, priorityMenu, relationToMenu, statusMenu } from './pickers.tsx';
import { linkProps, navigate } from './router.ts';
import { copyText } from './toast.ts';
import { t } from './i18n.ts';
import { getProjectKey } from './project.ts';
import { ImageBlock } from './ImageBlock.tsx';

// Kod, istniejące linki i gołe adresy zostają nietknięte (nieparzyste kawałki po split).
const SKIP = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+)/;
// Znacznik w tytule linku: odróżnia wzmiankę od ręcznie wpisanego linku do zgłoszenia.
const MENTION = 'issue-mention';
const USER_MENTION = 'user-mention';
const TAG_MENTION = 'tag-mention';
// @login i #tag: wzmianka tylko wtedy, gdy login/tag istnieje w projekcie (inaczej e-mail czy #1 zostają tekstem).
const USER_RE = /(?<![\w@/.])@([A-Za-z0-9][A-Za-z0-9._-]*)/g;
const TAG_RE = /(?<![\w&/#])#([A-Za-z0-9][A-Za-z0-9_-]*)/g;

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

function linkIssues(text: string, re: RegExp | null, meta?: Meta) {
  if (!re && !meta) return text;
  const users = new Map((meta?.users ?? []).map((u) => [u.login.toLowerCase(), u]));
  const tags = new Map((meta?.tags ?? []).map((x) => [x.name.toLowerCase(), x]));
  // Nazwa z końcówką interpunkcji ("@rafal." na końcu zdania): obcinamy ją i zostawiamy jako zwykły tekst.
  const find = <T,>(map: Map<string, T>, name: string): [T, string] | null => {
    for (let n = name; n; n = n.replace(/[.,_-]$/, '')) {
      const hit = map.get(n.toLowerCase());
      if (hit) return [hit, name.slice(n.length)];
      if (!/[.,_-]$/.test(n)) break;
    }
    return null;
  };
  return text.split(SKIP).map((part, i) => {
    if (i % 2) return part;
    let out = re ? part.replace(re, (all, key: string, num: string) => `[${all}](/issue/${key.toUpperCase()}-${num} "${MENTION}")`) : part;
    if (users.size) out = out.replace(USER_RE, (all, name: string) => { const h = find(users, name); return h ? `[@${name.slice(0, name.length - h[1].length)}](/people/${h[0].id} "${USER_MENTION}")${h[1]}` : all; });
    if (tags.size) out = out.replace(TAG_RE, (all, name: string) => { const h = find(tags, name); return h ? `[#${name.slice(0, name.length - h[1].length)}](/tags/${h[0].id} "${TAG_MENTION}")${h[1]}` : all; });
    return out;
  }).join('');
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
export function IssueMention({ id, preview }: { id: string; preview?: boolean }) {
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
  // Wzmianka na stronie innego zgłoszenia: relację z nim można dodać od razu z menu.
  const page = /^\/issue\/([A-Z]{2,6})-(\d+)$/.exec(location.pathname);
  const here = page && page[1] === key && Number(page[2]) !== row.number ? Number(page[2]) : null;
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['issue', here] }); void queryClient.invalidateQueries({ queryKey: ['issues'] }); };
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
      ...(here ? [{ key: 'relation', label: t('Add relation'), icon: <Icon.relation size={14} />, submenu: () => relationToMenu(here, row.number, refresh) }] : []),
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

/** Wzmianka osoby: neutralna jak wzmianka zgłoszenia; klik otwiera kartę osoby, prawy przycisk menu. */
function UserMention({ userId }: { userId: number }) {
  const u = useMeta().data?.users.find((x) => x.id === userId);
  if (!u) return null;
  const open = (el: HTMLElement) => openPersonCard(u.id, el);
  const menu = (): MenuSpec => ({
    searchable: false,
    items: [
      { key: 'profile', label: t('Profile'), icon: <Icon.user size={14} />, onSelect: () => openPersonCard(u.id, ctxAnchor) },
      { key: 'copy', label: t('Copy @login'), icon: <Icon.copy size={14} />, onSelect: () => copyText(`@${u.login}`, t('Copied')) },
    ],
  });
  let ctxAnchor: { x: number; y: number } = { x: 0, y: 0 };
  return (
    <span className="user-mention" role="button" tabIndex={0} title={`@${u.login}`}
      onClick={(e) => open(e.currentTarget)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(e.currentTarget); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); ctxAnchor = { x: e.clientX, y: e.clientY }; openMenu(ctxAnchor, menu()); }}>
      <span className="at">@</span><Avatar user={u} size={14} /><span className="t">{u.name}</span>
    </span>
  );
}

/** Wzmianka taga osób: kolor taga, klik pokazuje członków (każdy otwiera swoją kartę). */
function TagMention({ tagId }: { tagId: number }) {
  const meta = useMeta().data;
  const tag = meta?.tags?.find((x) => x.id === tagId);
  if (!tag || !meta) return null;
  const members = tag.memberIds.map((id) => meta.users.find((u) => u.id === id)).filter((u): u is NonNullable<typeof u> => !!u);
  const show = (el: HTMLElement) => {
    if (!members.length) return;
    openMenu(el, { searchable: false, items: members.map((u) => ({
      key: String(u.id), label: u.name, icon: <Avatar user={u} size={16} />, onSelect: () => openPersonCard(u.id, el),
    })) });
  };
  return (
    <span className="tag-mention" role="button" tabIndex={0} style={{ '--tag': `var(--tag-${tag.color})` } as React.CSSProperties}
      title={members.map((u) => u.name).join(', ')}
      onClick={(e) => show(e.currentTarget)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); show(e.currentTarget); } }}>
      <span className="hash">#</span>{tag.name}
    </span>
  );
}

export function Markdown({ text, empty, className = '' }: { text: string; empty?: string; className?: string }) {
  const re = useMentionPattern();
  const meta = useMeta().data;
  if (!text.trim()) return <div className={`md empty ${className}`}>{empty ?? ''}</div>;
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{
        // Linki do innych zadań (/issue/ACME-…) nawigują w aplikacji, zewnętrzne w nowej karcie.
        img: ({ node: _n, src, alt }) => <ImageBlock src={typeof src === 'string' ? src : undefined} alt={alt} />,
        a: ({ node: _n, href, children, title, ...p }) => {
          const m = title === MENTION && href && /^\/issue\/([A-Z]{2,6}-\d+)$/.exec(href);
          if (m) return <IssueMention id={m[1]} />;
          const um = title === USER_MENTION && href && /^\/people\/(\d+)$/.exec(href);
          if (um) return <UserMention userId={Number(um[1])} />;
          const tm = title === TAG_MENTION && href && /^\/tags\/(\d+)$/.exec(href);
          if (tm) return <TagMention tagId={Number(tm[1])} />;
          return href?.startsWith('/') ? <a {...p} title={title} {...linkProps(href)}>{children}</a> : <a {...p} title={title} href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}>
        {linkIssues(text, re, meta)}
      </ReactMarkdown>
    </div>
  );
}
