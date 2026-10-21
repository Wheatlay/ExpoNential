import { useConfig } from './api.ts';
import { BrandMark, GithubMark, Icon } from './icons.tsx';
import { Flow } from './Landing.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';

const STACK = ['TypeScript', 'Fastify', 'Postgres', 'React 19', 'MCP', 'Server-Sent Events', 'Docker'];

/**
 * Strona "How it works": krótko, tylko to, co trzeba wiedzieć. Szczegóły techniczne są w README repo.
 * loggedIn z App, nie useMe(): drugi obserwator zapytania 'me' z błędem 401 ponawia je przy montowaniu,
 * App wraca wtedy do stanu ładowania i odmontowuje tę stronę, co dawało pętlę zapytań i pustą stronę.
 */
export function About({ loggedIn }: { loggedIn: boolean }) {
  const repoUrl = useConfig().data?.repoUrl;
  return (
    <div className="about">
      <article className="about-inner">
        <a className="btn sm" {...linkProps('/')}><Icon.chevron size={12} /> {loggedIn ? t('Back to board') : t('Back')}</a>
        <header className="about-head">
          <BrandMark size={28} />
          <h1>{t('How Exponential works')}</h1>
        </header>

        <section id="why">
          <p>{t('One loop, no copy-paste between tools: the agent works where the issue lives, and you step in only to decide.')}</p>
          <Flow />
        </section>

        <section id="architecture">
          <h2>{t('Under the hood')}</h2>
          <div className="about-diagram-wrap"><svg className="about-diagram" viewBox="0 0 640 230" role="img" aria-label={t('Architecture diagram')}>
            <defs>
              <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="currentColor" /></marker>
            </defs>
            <rect className="node" x="20" y="20" width="160" height="56" rx="8" /><text x="100" y="52" textAnchor="middle">Browser</text>
            <rect className="node core" x="240" y="20" width="160" height="56" rx="8" /><text x="320" y="52" textAnchor="middle">Fastify API</text>
            <rect className="node" x="460" y="20" width="160" height="56" rx="8" /><text x="540" y="52" textAnchor="middle">Postgres</text>
            <line className="edge" x1="180" y1="48" x2="240" y2="48" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
            <line className="edge" x1="400" y1="48" x2="460" y2="48" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
            <text className="note" x="210" y="40" textAnchor="middle">REST + SSE</text>
            <text className="note" x="430" y="40" textAnchor="middle">LISTEN/NOTIFY</text>
            <rect className="node ai" x="20" y="154" width="160" height="56" rx="8" /><text x="100" y="186" textAnchor="middle">Claude Code</text>
            <rect className="node" x="460" y="154" width="160" height="56" rx="8" /><text x="540" y="186" textAnchor="middle">GitHub / CI</text>
            <path className="edge" d="M100 154V115H290V76" fill="none" markerStart="url(#arrow)" markerEnd="url(#arrow)" />
            <text className="note" x="196" y="108" textAnchor="middle">MCP (/mcp)</text>
            <path className="edge" d="M540 154V115H350V76" fill="none" markerEnd="url(#arrow)" />
            <text className="note" x="446" y="108" textAnchor="middle">webhooks</text>
          </svg></div>
          <p className="hint">{STACK.join(' · ')}</p>
        </section>

        <section id="demo">
          <p className="hint">{t('The demo is a shared sandbox that resets every hour, and its agent is a replay. In production the agent is Claude Code connected over MCP.')}</p>
          <div className="landing-actions">
            {!loggedIn && <a className="btn primary" href="/auth/demo?tour=1">{t('Try the live demo')}</a>}
            {repoUrl && <a className="btn" href={repoUrl} target="_blank" rel="noreferrer"><GithubMark size={14} /> {t('Source on GitHub')}</a>}
          </div>
        </section>
      </article>
    </div>
  );
}
