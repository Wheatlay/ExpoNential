import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { pad, parseDate, parseTime } from './datetime.ts';
import { t } from './i18n.ts';

/**
 * Data i godzina po polsku niezależnie od języka przeglądarki: systemowe <input type="date|time"> biorą
 * format z ustawień przeglądarki (u części osób 10/21/2026 i 12:00 AM). Wartości jak w natywnych polach:
 * "YYYY-MM-DD" i "HH:MM"; zmiana idzie do onChange po zatwierdzeniu (Enter, wyjście z pola).
 */

const showDate = (iso: string) => (iso ? iso.split('-').reverse().join('.') : '');

type Props = { value: string; onChange: (v: string) => void; disabled?: boolean; 'aria-label'?: string; style?: React.CSSProperties };

/** Pole tekstowe, które zatwierdza wpis przy Enter/wyjściu, a zły wpis cofa do ostatniej dobrej wartości. */
function useCommitted(value: string, show: (v: string) => string, parse: (raw: string) => string | null, onChange: (v: string) => void) {
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    const v = parse(text);
    if (v && v !== value) onChange(v);
    setText(show(v ?? value));
  };
  return { text, setText, commit };
}

/** Wybór w dwóch kolumnach: godziny 00-23 i minuty co 5. */
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));
const ROW = 30;

export function TimeInput({ value, onChange, disabled, style, ...rest }: Props) {
  const { text, setText, commit } = useCommitted(value, (v) => v, parseTime, onChange);
  const [open, setOpen] = useState(false);
  const hoursCol = useRef<HTMLDivElement>(null);
  const minutesCol = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  // Lista w position: fixed przy polu, żeby okno spotkania (z przewijaniem) jej nie ucinało.
  const at = open && field.current ? field.current.getBoundingClientRect() : null;
  // Strzałki: ±15 min jak w natywnym polu (bez przechodzenia przez północ).
  const step = (dir: number) => {
    const [h, m] = (parseTime(text) ?? value ?? '00:00').split(':').map(Number);
    const total = Math.min(23 * 60 + 45, Math.max(0, Math.round((h * 60 + m) / 15) * 15 + dir * 15));
    onChange(`${pad(Math.floor(total / 60))}:${pad(total % 60)}`);
  };
  const [hh, mm] = (value || '09:00').split(':');
  // Wybrana godzina i minuta stoją obok siebie w środkowym wierszu.
  useEffect(() => {
    if (!open) return;
    // Kolumny mają 3 puste wiersze z góry i z dołu, więc każdą wartość da się postawić w środkowym wierszu.
    if (hoursCol.current) hoursCol.current.scrollTop = Number(hh) * ROW;
    if (minutesCol.current) minutesCol.current.scrollTop = Math.round(Number(mm) / 5) * ROW;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (h: string, m: string) => {
    const v = `${h}:${m}`;
    if (v === value) return;
    onChange(v);
    setText(v);
  };
  // Jak kółko w telefonie: co stanie na środku po przewinięciu, to jest wybrane (po krótkiej chwili bez ruchu).
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      const row = (el: HTMLDivElement | null, n: number) => Math.min(n - 1, Math.max(0, Math.round((el?.scrollTop ?? 0) / ROW)));
      pick(HOURS[row(hoursCol.current, HOURS.length)], MINUTES[row(minutesCol.current, MINUTES.length)]);
    }, 120);
  };
  const center = (col: HTMLDivElement | null, i: number) => col?.scrollTo({ top: i * ROW, behavior: 'smooth' });
  return (
    <span className="time-input-wrap">
      <input ref={field} className="input time-input" inputMode="numeric" placeholder="14:00" value={text} disabled={disabled} aria-label={rest['aria-label'] ?? t('Time')}
        style={{ width: 72, ...style }} onChange={(e) => setText(e.target.value)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={() => { commit(); setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); setOpen(false); }
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
        }} />
      {open && !disabled && at && createPortal(
        // W <body>: okno spotkania ma animację (transform), która przesuwałaby position: fixed.
        // mousedown zamiast click: inaczej pole traci fokus i lista znika. Klik przewija wartość na środek,
        // a wybór robi przewijanie; lista zamyka się kliknięciem obok, Enterem albo Escape.
        <div className="time-list" style={{ top: at.bottom + 214 > window.innerHeight ? at.top - 214 : at.bottom + 4, left: at.left }}
          onMouseDown={(e) => e.preventDefault()}>
          <div ref={hoursCol} className="time-col" role="listbox" aria-label={t('Hour')} onScroll={onScroll}>
            {HOURS.map((h, i) => (
              <button key={h} type="button" role="option" aria-selected={h === hh} className={h === hh ? 'on' : ''}
                onMouseDown={(e) => { e.preventDefault(); center(hoursCol.current, i); }}>{h}</button>
            ))}
          </div>
          <div ref={minutesCol} className="time-col" role="listbox" aria-label={t('Minute')} onScroll={onScroll}>
            {MINUTES.map((m, i) => (
              <button key={m} type="button" role="option" aria-selected={m === mm} className={m === mm ? 'on' : ''}
                onMouseDown={(e) => { e.preventDefault(); center(minutesCol.current, i); }}>{m}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

export function DateInput({ value, onChange, disabled, style, ...rest }: Props) {
  const { text, setText, commit } = useCommitted(value, showDate, (raw) => parseDate(raw, Number(value.slice(0, 4)) || undefined), onChange);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <span className="date-input" style={style}>
      <input className="input" placeholder="21.10.2026" value={text} disabled={disabled} aria-label={rest['aria-label'] ?? t('Day')}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      {/* Kalendarz z przeglądarki do wybierania klikiem; wpisana wartość i tak pokazuje się po polsku. */}
      <button type="button" className="icon-btn" aria-label={t('Pick a day')} disabled={disabled} onClick={() => picker.current?.showPicker?.()}><Icon.calendar size={14} /></button>
      <input ref={picker} type="date" tabIndex={-1} aria-hidden className="date-input-native" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </span>
  );
}
