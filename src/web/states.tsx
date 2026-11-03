import { t } from './i18n.ts';

/** Błąd ładowania: komunikat i ponowienie (zamiast pustego ekranu albo mylącego "nie znaleziono"). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
      <b>{t('Could not load this view')}</b>
      <span className="hint">{(error as Error | null)?.message ?? ''}</span>
      <button className="btn" onClick={onRetry}>{t('Retry')}</button>
    </div>
  );
}

/** Ładowanie: sam napis (bez nowego wzoru komponentu), czytnik ekranu dostaje aria-busy. */
export function LoadingState() {
  return <div aria-busy="true" className="hint" style={{ padding: 24 }}>{t('Loading…')}</div>;
}
