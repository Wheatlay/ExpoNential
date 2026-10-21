import { useConfig } from './api.ts';
import { restartTour } from './DemoTour.tsx';
import { GithubMark, Icon } from './icons.tsx';
import { linkProps } from './router.ts';
import { t } from './i18n.ts';

/** Wąski, zawsze widoczny pasek nad aplikacją w trybie demo. Na telefonie: pierwszy segment i ikony. */
export function DemoBanner() {
  const repoUrl = useConfig().data?.repoUrl;
  return (
    <div className="demo-banner">
      <span className="demo-banner-text">
        <b>{t('Demo')}</b>
        <span className="demo-banner-extra"> · {t('shared sandbox, resets hourly')} · {t('the AI agent is simulated')}</span>
      </span>
      <span className="spacer" />
      <a className="demo-banner-link" href="/issue/ACME-12" onClick={(e) => { e.preventDefault(); restartTour(); }} title={t('Restart tour')}>
        <Icon.play size={12} /><span className="demo-banner-label">{t('Restart tour')}</span>
      </a>
      <a className="demo-banner-link" {...linkProps('/about')} title={t('How it works')}>
        <Icon.question size={13} /><span className="demo-banner-label">{t('How it works')}</span>
      </a>
      {repoUrl && (
        <a className="demo-banner-link" href={repoUrl} target="_blank" rel="noreferrer" title="GitHub">
          <GithubMark size={13} /><span className="demo-banner-label">GitHub</span>
        </a>
      )}
    </div>
  );
}
