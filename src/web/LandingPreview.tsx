import { Avatar, Icon, StatusIcon } from './icons.tsx';
import { t } from './i18n.ts';

const testing = { type: 'started', color: 'var(--accent)' } as const;
const you = { id: 0, name: 'You', avatarUrl: null };

/**
 * Statyczna, nieinteraktywna replika strony zgłoszenia dla landingu. Te same klasy co w IssuePage
 * i AnalysisView, więc wygląda identycznie; nic w środku nie jest fokusowalne (inert + aria-hidden).
 */
export function LandingPreview() {
  return (
    <div className="lp-wrap">
      <p className="lp-sr">{t('Preview of an issue page: the agent analysed the bug, you picked an option, the fix was deployed.')}</p>
      <div className="lp-frame" aria-hidden="true" inert>
        <div className="issue-page">
          <div className="issue-main">
            <div className="issue-content">
              <div className="hint">ACME-12</div>
              <div className="issue-title">{t('Checkout fails for EU VAT numbers')}</div>
              <div className="issue-actions">
                <span className="btn sm start-btn"><Icon.play size={12} /> {t('Start work in Claude')}</span>
              </div>
              <div className="section fold-group">
                <div className="fold open">
                  <div className="fold-bar">
                    <span className="fold-caret"><Icon.caret /></span>
                    <span className="badge ai">AI</span>
                    <span className="fold-name">{t('Problem analysis')}</span>
                    <span className="fold-preview" />
                    <span className="hint">{t('Bug')}</span>
                  </div>
                  <div className="fold-body">
                    <div className="panel ai">
                      <div className="analysis">
                        <div className="analysis-section">
                          <div className="desc-label">{t('Does it happen')}</div>
                          <div className="md analysis-text"><p>{t('Yes · the VAT check runs on the raw input, so a trailing space fails it.')}</p></div>
                        </div>
                        <div className="analysis-section">
                          <div className="desc-label">{t('Watch out')}</div>
                          <div className="md analysis-text"><p>{t('The same validator serves the invoice settings and the public API.')}</p></div>
                        </div>
                        <div className="analysis-section">
                          <div className="desc-label">{t('To decide')}</div>
                          <div className="decision">
                            <div className="decision-q">
                              <span>1. {t('Where should we normalise VAT IDs?')}</span>
                              <span className="decision-by">{t('You · 2 min ago')}</span>
                            </div>
                            <div className="decision-opt on">
                              <span className="decision-dot" />
                              <span className="decision-body">
                                <span className="decision-label">{t('Server, on save')}<span className="badge ai">{t('Recommended')}</span></span>
                              </span>
                            </div>
                            <div className="decision-opt">
                              <span className="decision-dot" />
                              <span className="decision-body">
                                <span className="decision-label">{t('Only in the form')}</span>
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="fold">
                  <div className="fold-bar">
                    <span className="fold-caret"><Icon.caret /></span>
                    <span className="badge human">HUMAN</span>
                    <span className="fold-name">{t('What changed')}</span>
                    <span className="fold-preview">{t('Company customers can enter VAT IDs with spaces or a lowercase prefix; checkout accepts them.')}</span>
                  </div>
                </div>
                <div className="fold">
                  <div className="fold-bar">
                    <span className="fold-caret"><Icon.caret /></span>
                    <span className="badge tech">TECH</span>
                    <span className="fold-name">{t('Change log')}</span>
                    <span className="fold-preview">{t('vat.ts · normaliseVatId() · 4 tests')}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <aside className="props-panel">
            <div className="props-group">
              <h4>{t('Properties')}</h4>
              <div className="prop"><StatusIcon status={testing} fraction={0.75} /> {t('Testing')}</div>
              <div className="prop"><Avatar user={you} size={16} /> <span>{t('You')}</span></div>
            </div>
            <div className="props-group">
              <h4>{t('Commits')}</h4>
              <div className="prop">
                <Icon.commit size={14} />
                <code style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>a3f9c21</code>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400 }}>{t('ACME-12: normalise VAT IDs before validation')}</span>
                <span title={t('Deployed 1 hour ago')} style={{ color: 'var(--success-text)', marginLeft: 'auto' }}><Icon.rocket size={13} /></span>
              </div>
              <div className="prop">
                <Icon.commit size={14} />
                <code style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>7be0d44</code>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400 }}>{t('ACME-12: tests for VAT IDs with spaces')}</span>
                <span title={t('Deployed 1 hour ago')} style={{ color: 'var(--success-text)', marginLeft: 'auto' }}><Icon.rocket size={13} /></span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
