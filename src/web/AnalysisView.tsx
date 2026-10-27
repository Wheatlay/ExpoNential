import { useState } from 'react';
import { Markdown } from './Markdown.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { api, type AnalysisData, type IssueDetail } from './api.ts';
import { ident } from './project.ts';
import { toast } from './toast.ts';
import { timeAgo } from './time.ts';
import { t } from './i18n.ts';

// Kolejność i nazwy jak SECTION_KEYS w src/server/analysis.ts.
const SECTIONS = [
  ['verdict', 'Does it happen'], ['howToCheck', 'How to check'], ['current', 'Current state'], ['answer', 'Answer'],
  ['todo', 'Anything to do'], ['system', 'In the system'], ['after', 'After the change'], ['risk', 'Watch out'], ['related', 'Related'],
] as const;

/**
 * Analiza AI w sekcjach (z set_analysis) i decyzje do kliknięcia. Wybór zapisuje się od razu
 * i trafia do polecenia Start work jako "Ustalono".
 */
export function AnalysisView({ issue, data }: { issue: IssueDetail; data: AnalysisData }) {
  return (
    <div className="analysis">
      {SECTIONS.map(([key, name]) => data.sections[key] && (
        <div key={key} className="analysis-section">
          <div className="desc-label">{t(name)}</div>
          <Markdown className="analysis-text" text={data.sections[key]!} />
        </div>
      ))}
      {data.decisions.length > 0 && (
        <div className="analysis-section">
          <div className="desc-label">{t('To decide')}</div>
          {data.decisions.map((d, i) => <Decision key={i} issue={issue} index={i} d={d} />)}
        </div>
      )}
    </div>
  );
}

function Decision({ issue, index, d }: { issue: IssueDetail; index: number; d: AnalysisData['decisions'][number] }) {
  const qc = useQueryClient();
  // Tekst w polu "Inne", gdy jest otwarte; null = pole zamknięte (zapisana odpowiedź to zaznaczona opcja).
  const [other, setOther] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async (option: number | null, text = '') => {
    setBusy(true);
    try {
      const next = await api<AnalysisData>(`/api/issues/${ident(issue.number)}/analysis/decision`, { method: 'POST', body: { index, option, other: text } });
      qc.setQueryData<IssueDetail>(['issue', issue.number], (old) => (old ? { ...old, analysisData: next } : old));
      void qc.invalidateQueries({ queryKey: ['issue', issue.number] });
      setOther(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const chosen = d.choice?.option;
  const isOther = d.choice != null && chosen == null;
  return (
    <div className="decision" role="radiogroup" aria-label={d.question}>
      <div className="decision-q">
        <span>{index + 1}. {d.question}</span>
        {d.choice && <span className="decision-by">{d.choice.by} · {timeAgo(d.choice.at)}</span>}
      </div>
      {d.options.map((o, j) => (
        <button key={j} role="radio" aria-checked={chosen === j} disabled={busy}
          className={`decision-opt${chosen === j ? ' on' : ''}`}
          onClick={() => void choose(chosen === j ? null : j)}
          title={chosen === j ? t('Click again to clear the choice') : undefined}>
          <span className="decision-dot" />
          <span className="decision-body">
            <span className="decision-label">{o.label}{o.recommended && <span className="badge ai">{t('Recommended')}</span>}</span>
            {o.desc && <span className="decision-desc">{o.desc}</span>}
          </span>
        </button>
      ))}
      {other == null
        ? <button role="radio" aria-checked={isOther} className={`decision-opt${isOther ? ' on' : ''}`} disabled={busy}
            onClick={() => setOther(isOther ? d.choice!.other : '')} title={isOther ? t('Click to change your answer') : undefined}>
            <span className="decision-dot" />
            <span className="decision-body">
              <span className="decision-label">{isOther ? t('Other') : t('Other…')}</span>
              {isOther && <span className="decision-desc">{d.choice!.other}</span>}
            </span>
          </button>
        : <form className="decision-other" onSubmit={(e) => { e.preventDefault(); if (other.trim()) void choose(null, other); }}>
            <input className="input" autoFocus value={other} placeholder={t('Your answer')} onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setOther(null); }} />
            <button type="submit" className="btn sm primary" disabled={busy || !other.trim()}>{t('Save')}</button>
            {isOther
              ? <button type="button" className="btn sm" disabled={busy} onClick={() => void choose(null, '')}>{t('Clear')}</button>
              : <button type="button" className="btn sm" onClick={() => setOther(null)}>{t('Cancel')}</button>}
          </form>}
    </div>
  );
}
