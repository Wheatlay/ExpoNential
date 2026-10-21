import { useConfig } from './api.ts';
import { BrandMark, GithubMark, Icon } from './icons.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';

/** Strona "How it works" dla technicznego czytelnika: teza, przepływ pracy, architektura, decyzje. Dostępna bez logowania. */
// loggedIn z App, nie useMe(): drugi obserwator zapytania 'me' z błędem 401 ponawia je przy montowaniu,
// App wraca wtedy do stanu ładowania i odmontowuje tę stronę, co dawało pętlę zapytań i pustą stronę.
export function About({ loggedIn }: { loggedIn: boolean }) {
  const me = loggedIn;
  const repoUrl = useConfig().data?.repoUrl;
  const steps: [string, string][] = [
    [t('Issue'), t('A person files a bug or an idea. Issues have statuses, sprints, relations and comments, like in any tracker.')],
    [t('Agent analysis'), t('Analyze marks the issue. An agent running the analyze-tracker-ticket skill reads the code and writes a structured analysis (sections plus decisions to take) over MCP with set_analysis.')],
    [t('Your decision'), t('Decisions are options with a recommendation. People click one, or write their own answer. The choice is stored on the issue and logged in the activity.')],
    [t('Agent ships'), t('Start work puts a ready prompt into Claude Code. The Claude Code plugin hook sends a worklog (prompts, files, commits). Commits are linked to the issue by its ID, and deploy events arrive from a webhook, GitHub Deployments or Coolify.')],
    [t('Change notes'), t('The close-ticket skill writes two notes: a short HUMAN summary and a detailed TECH log for the next agent. Together they become the sprint review.')],
  ];
  const stack = [
    t('Fastify + TypeScript API'),
    t('Postgres with LISTEN/NOTIFY, turned into Server-Sent Events for realtime updates'),
    t('Drizzle migrations'),
    t('React 19 + TanStack Query front end (Vite)'),
    t('MCP server over Streamable HTTP at /mcp'),
    t('Claude Code plugin served by the tracker itself (skills + worklog hook)'),
    t('Web Push notifications and an iCal feed'),
  ];
  const decisions: [string, string][] = [
    [t('Humans decide, agents propose'), t('An agent can analyse, code and write notes, but every fork in the road is a decision a person clicks.')],
    [t('Structured analysis instead of free text'), t('Sections and options can be rendered, compared and answered. A wall of prose cannot.')],
    [t('One source of truth for prompts'), t('The plugin with skills and prompts is served by the server, so every machine runs the same version.')],
    [t('Hardened local agent'), t('The local analysis agent runs with allow-listed tools only, so a malicious issue text cannot make it run arbitrary commands (prompt injection).')],
    [t('Soft rules over hard blocks'), t('Missing change notes or a waiting issue produce a warning, not a wall. The team stays in control.')],
  ];
  return (
    <div className="about">
      <article className="about-inner">
        <a className="btn sm" {...linkProps('/')}><Icon.chevron size={12} /> {me ? t('Back to board') : t('Back')}</a>
        <header className="about-head">
          <BrandMark size={28} />
          <h1>{t('How Exponential works')}</h1>
        </header>

        <section id="why">
          <h2>{t('Why')}</h2>
          <p>{t('Your issue tracker where AI agents do the legwork and humans make the calls.')}</p>
          <p>{t('Coding agents are fast, but they need a shared place to find the work, report what they found and wait for a person to choose. A chat window is not that place. Exponential is the issue tracker built for this loop: the agent does the reading, coding and writing; people keep the decisions.')}</p>
        </section>

        <section id="workflow">
          <h2>{t('The workflow')}</h2>
          <ol className="about-steps">
            {steps.map(([name, text]) => (
              <li key={name}><b>{name}</b><span>{text}</span></li>
            ))}
          </ol>
        </section>

        <section id="how-commits-link">
          <h2>{t('How commits link to issues')}</h2>
          <p>{t('Put the issue ID in the commit message or the branch name, for example')} <code>ACME-12</code>. {t('A GitHub webhook delivers each push. The server matches the ID, only for the repository configured in the project, and attaches the commit to the issue. Deployment events then mark those commits as deployed, and the sidebar shows the live status.')}</p>
        </section>

        <section id="architecture">
          <h2>{t('Architecture')}</h2>
          <ul>
            {stack.map((s) => <li key={s}>{s}</li>)}
          </ul>
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
        </section>

        <section id="decisions">
          <h2>{t('Design decisions')}</h2>
          <ul>
            {decisions.map(([name, text]) => <li key={name}><b>{name}.</b> {text}</li>)}
          </ul>
        </section>

        <section id="run-it">
          <h2>{t('Run it yourself')}</h2>
          <pre className="about-code"><code>{'docker compose up -d db\nnpm install\nnpm run dev'}</code></pre>
          {repoUrl && <p><a className="btn" href={repoUrl} target="_blank" rel="noreferrer"><GithubMark size={14} /> {t('Source on GitHub')}</a></p>}
        </section>

        <section id="demo">
          <h2>{t('About the demo')}</h2>
          <p>{t('The demo is a shared sandbox that resets every hour. The AI agent in it is a replay of a real session, so nothing calls a model and nothing costs money. In production the agent is Claude Code connected over MCP.')}</p>
          {!me && <p><a className="btn primary" href="/auth/demo?tour=1">{t('Try the live demo')}</a></p>}
        </section>
      </article>
    </div>
  );
}
