import { t } from './i18n.ts';

/** Błąd ładowania: komunikat i ponowienie (zamiast pustego ekranu albo mylącego "nie znaleziono"). */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="state-block">
      <b>{t('Could not load this view')}</b>
      <span className="hint">{(error as Error | null)?.message ?? ''}</span>
      <button className="btn" onClick={onRetry}>{t('Retry')}</button>
    </div>
  );
}

/** Pusty stan (brak danych, nie błąd): ten sam układ co ErrorState, bez role="alert". */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="state-block">
      <b>{title}</b>
      {hint && <span className="hint">{hint}</span>}
      {action}
    </div>
  );
}

/** Ładowanie: sam napis (bez nowego wzoru komponentu), czytnik ekranu dostaje aria-busy. */
export function LoadingState() {
  return <div aria-busy="true" className="hint state-block">{t('Loading…')}</div>;
}
