import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useIssues, useMeta } from './api.ts';
import { StatusIcon, startedFraction } from './icons.tsx';
import { linkProps } from './router.ts';
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
  const st = row && meta?.statuses.find((s) => s.id === row.statusId);
  if (!row || !st || !meta) return <a {...linkProps(`/issue/${id}`)}>{id}</a>;
  return (
    <a className="issue-mention" {...linkProps(`/issue/${id}`)} title={`${st.name} · ${row.title}`}>
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
