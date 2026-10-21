import { useConfig } from './api.ts';
import { BrandMark, GithubMark, Icon } from './icons.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';

/** Strona startowa publicznego dema (niezalogowani, gdy serwer działa w trybie demo). */
export function Landing() {
  const repoUrl = useConfig().data?.repoUrl;
  const flow = [
    { icon: <Icon.edit size={14} />, name: t('Issue'), text: t('Someone files a bug or an idea.') },
    { icon: <Icon.sparkle size={14} />, name: t('Agent analysis'), text: t('An AI agent reads the code and writes a structured analysis.') },
    { icon: <Icon.user size={14} />, name: t('Your decision'), text: t('You pick an option. The agent never decides alone.') },
    { icon: <Icon.rocket size={14} />, name: t('Agent ships'), text: t('It commits, links the commits and tracks the deploy.') },
    { icon: <Icon.comment size={14} />, name: t('Change notes'), text: t('Human and technical notes write the sprint review.') },
  ];
  const err = new URLSearchParams(location.search).get('error');
  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="landing-brand"><BrandMark size={28} /> <b>Exponential</b></div>
        <h1>{t('Your issue tracker where AI agents do the legwork and humans make the calls.')}</h1>
        <p className="landing-sub">{t('A Linear-style tracker built around Claude Code: agents analyse issues, ship the code and write the change notes — people decide what matters.')}</p>
        {err && <div className="err">{t('Login failed')}</div>}
        <ol className="flow">
          {flow.map((s, i) => (
            <li key={s.name} className="flow-step">
              <span className="flow-head"><span className="step-dot">{s.icon}</span><span className="hint">{i + 1}</span></span>
              <b>{s.name}</b>
              <span className="hint">{s.text}</span>
            </li>
          ))}
        </ol>
        <div className="landing-actions">
          <a className="btn primary landing-cta" href="/auth/demo?tour=1">{t('Try the live demo')}</a>
          <a className="btn landing-cta" {...linkProps('/about')}>{t('How it works')}</a>
          {repoUrl && <a className="btn landing-cta" href={repoUrl} target="_blank" rel="noreferrer"><GithubMark size={14} /> GitHub</a>}
        </div>
        <p className="hint">{t('No sign-up. Shared sandbox, resets every hour. The AI agent in the demo is a replay; in production it is Claude Code connected over MCP.')}</p>
        <a className="hint landing-team" href="/auth/login">{t('Team login with GitHub')}</a>
      </div>
    </div>
  );
}
