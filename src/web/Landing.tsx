import { useConfig } from './api.ts';
import { BrandMark, GithubMark, Icon } from './icons.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';
import { LandingPreview } from './LandingPreview.tsx';

/** Obieg pracy: ten sam na stronie startowej i w "How it works". */
export function flowSteps() {
  return [
    { icon: <Icon.edit size={14} />, name: t('Issue'), text: t('Someone files a bug or an idea.') },
    { icon: <Icon.sparkle size={14} />, name: t('Agent analysis'), text: t('An AI agent reads the code and writes a structured analysis.') },
    { icon: <Icon.user size={14} />, name: t('Your decision'), text: t('You pick an option. The agent never decides alone.') },
    { icon: <Icon.rocket size={14} />, name: t('Agent ships'), text: t('It commits, links the commits and tracks the deploy.') },
    { icon: <Icon.comment size={14} />, name: t('Change notes'), text: t('Human and technical notes write the sprint review.') },
  ];
}

export function Flow() {
  return (
    <ol className="flow">
      {flowSteps().map((s, i) => (
        <li key={s.name} className="flow-step">
          <span className="flow-head"><span className="step-dot">{s.icon}</span><span className="hint">{i + 1}</span></span>
          <b>{s.name}</b>
          <span className="hint">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** Strona startowa publicznego dema (niezalogowani, gdy serwer działa w trybie demo). */
export function Landing() {
  const repoUrl = useConfig().data?.repoUrl;
  return (
    <div className="landing">
      <header className="landing-head">
        <div className="landing-brand"><BrandMark size={28} /> <b>Exponential</b></div>
        <nav className="landing-nav">
          <a className="landing-link" {...linkProps('/about')}>{t('How it works')}</a>
          {repoUrl && <a className="landing-link" href={repoUrl} target="_blank" rel="noreferrer"><GithubMark size={14} /> GitHub</a>}
        </nav>
      </header>
      <div className="landing-hero">
        <h1>{t('Because your progress should be')} <span className="landing-exp">{t('exponential')}</span>, {t('not')} <span className="landing-lin">{t('linear')}</span>.</h1>
        <a className="btn primary landing-cta" href="/auth/demo?tour=1">{t('Try the live demo')}</a>
        <p className="hint">{t('No sign-up · resets every hour · the agent in the demo is a replay')}</p>
      </div>
      <LandingPreview />
    </div>
  );
}
