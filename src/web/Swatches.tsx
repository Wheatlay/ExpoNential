import { useMemo } from 'react';
import { t } from './i18n.ts';

const SLOTS = [1, 2, 3, 4, 5, 6, 7];

type Option = { value: string; css: string; name: string };

/** Kolory z palety project-1…7 jako #hex (serwer zapisuje kolor jako tekst), czytane z tokenów motywu. */
function projectOptions(): Option[] {
  const cs = getComputedStyle(document.documentElement);
  return SLOTS.map((n) => ({ value: cs.getPropertyValue(`--project-${n}`).trim().toLowerCase(), css: `var(--project-${n})`, name: `${t('Color')} ${n}` }));
}

/**
 * Wybór koloru z palety (kropki jak w tagach). Domyślnie project-1…7 (projekt, etykieta, status; wartość to #hex);
 * z `tagColors` kolory tagów osób (wartość to nazwa). Kolor spoza palety zostaje, dopóki nie wybierzesz innego: żadna kropka nie jest wtedy zaznaczona.
 */
export function Swatches({ value, onChange, disabled, label, tagColors }: { value: string | null; onChange: (v: string) => void; disabled?: boolean; label?: string; tagColors?: readonly string[] }) {
  const options = useMemo<Option[]>(() => tagColors ? tagColors.map((c) => ({ value: c, css: `var(--tag-${c})`, name: c })) : projectOptions(), [tagColors]);
  const cur = (value ?? '').trim().toLowerCase();
  return (
    <div className="tag-swatches" role="radiogroup" aria-label={label ?? t('Color')}>
      {options.map((o) => (
        <button key={o.css} type="button" role="radio" aria-checked={o.value === cur} aria-label={o.name} title={o.name} disabled={disabled}
          className={`tag-swatch${o.value === cur ? ' on' : ''}`} style={{ '--tag': o.css } as React.CSSProperties}
          onClick={() => { if (o.value !== cur) onChange(o.value); }} />
      ))}
    </div>
  );
}

/** Hex kolorów palety project-1…7 (do wartości domyślnych nowego projektu albo etykiety). */
export const projectPalette = () => projectOptions().map((o) => o.value);
export const defaultSwatch = () => projectPalette()[0];
