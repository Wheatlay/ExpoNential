import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { pad, parseDate, parseTime } from './datetime.ts';
import { t } from './i18n.ts';
import { toast } from './toast.ts';

/**
 * Data i godzina po polsku niezależnie od języka przeglądarki: systemowe <input type="date|time"> biorą
 * format z ustawień przeglądarki (u części osób 10/21/2026 i 12:00 AM). Wartości jak w natywnych polach:
 * "YYYY-MM-DD" i "HH:MM"; zmiana idzie do onChange po zatwierdzeniu (Enter, wyjście z pola).
 */

const showDate = (iso: string) => (iso ? iso.split('-').reverse().join('.') : '');

type Props = { value: string; onChange: (v: string) => void; disabled?: boolean; 'aria-label'?: string; style?: React.CSSProperties };

/**
 * Pole tekstowe, które zatwierdza wpis przy Enter/wyjściu. Zły wpis widać od razu (czerwona ramka),
 * a przy zatwierdzeniu wraca ostatnia dobra wartość z komunikatem, zamiast cicho znikać.
 */
function useCommitted(value: string, show: (v: string) => string, parse: (raw: string) => string | null, onChange: (v: string) => void, bad: string) {
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const invalid = text.trim() !== '' && parse(text) === null;
  const commit = () => {
    const v = parse(text);
    if (v && v !== value) onChange(v);
    if (invalid) toast(bad, 'err');
    setText(show(v ?? value));
  };
  return { text, setText, commit, invalid };
}

/** Maska wpisu: same cyfry dostają separator, gdy człowiek go nie wpisał ("930" -> "9:30", "0511" -> "05.11"). Kasowanie nie wstawia znaków. */
function maskTime(raw: string, prev: string) {
  if (raw.length < prev.length || /[^\d]/.test(raw)) return raw.slice(0, 5);
  const d = raw.slice(0, 4);
  if (d.length < 3 && !(d.length === 2 && Number(d) > 23)) return d;
  const split = Number(d.slice(0, 2)) > 23 || (d.length === 3 && Number(d.slice(1)) > 59) ? 1 : 2;
  // Dwukropek tylko tam, gdzie minuty mogą się zgadzać: "99" zostaje "99" (czerwona ramka), a nie cichy "9:9" = 09:09.
  if (Number(d[split]) > 5) return d;
  return `${d.slice(0, split)}:${d.slice(split)}`;
}
function maskDate(raw: string, prev: string) {
  if (raw.length < prev.length) return raw;
  // Pisanie cyfra po cyfrze po "05" albo "05.11": kropka wchodzi sama.
  if (raw.length === prev.length + 1 && raw.startsWith(prev) && /\d$/.test(raw) && /^(\d{2}|\d{2}\.\d{2})$/.test(prev)) return `${prev}.${raw.slice(-1)}`;
  if (/[^\d]/.test(raw)) return raw.slice(0, 10);
  const d = raw.slice(0, 8);
  return [d.slice(0, 2), d.slice(2, 4), d.slice(4)].filter(Boolean).join('.');
}

/** Wybór w dwóch kolumnach: godziny 00-23 i minuty co 5. */
const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad(i * 5));
const ROW = 30;

export function TimeInput({ value, onChange, disabled, style, ...rest }: Props) {
  const { text, setText, commit, invalid } = useCommitted(value, (v) => v, parseTime, onChange, t('That is not a time. Use e.g. 14:30.'));
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
  const mi = Math.min(MINUTES.length - 1, Math.round(Number(mm) / 5));
  // Wybrana wartość na środku kolumny: od razu przy otwarciu, płynnie po zmianie (klik, wpis, strzałki).
  // Kolumny mają 3 puste wiersze z góry i z dołu, więc każdą wartość da się postawić na środku.
  const shown = useRef(false);
  useEffect(() => {
    // Zamknięcie anuluje czekający wybór po przewinięciu: inaczej odpaliłby się bez kolumn i ustawił 00:00.
    if (!open) { shown.current = false; if (settle.current) clearTimeout(settle.current); return; }
    const behavior = shown.current ? 'smooth' : 'instant';
    hoursCol.current?.scrollTo({ top: Number(hh) * ROW, behavior });
    minutesCol.current?.scrollTo({ top: mi * ROW, behavior });
    shown.current = true;
  }, [open, hh, mi]);
  // Klik wybiera od razu; po przewinięciu (kółko, przeciąganie, palec) wybiera to, co stanęło na środku.
  const pick = (h: string, m: string) => {
    const v = `${h}:${m}`;
    if (v === value) return;
    onChange(v);
    setText(v);
  };
  // Wybór po chwili bez ruchu; dociągnięcie do wiersza robi zwykle snap przeglądarki (CSS), a gdy lista
  // stanie krzywo (proximity nie zadziałało), dosuwamy ją sami.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current);
    settle.current = setTimeout(() => {
      if (drag.current?.moved) return; // mysz jeszcze trzyma listę: wybór po puszczeniu
      const hc = hoursCol.current, mc = minutesCol.current;
      if (!hc || !mc) return; // lista już zamknięta
      const row = (el: HTMLDivElement, n: number) => Math.min(n - 1, Math.max(0, Math.round(el.scrollTop / ROW)));
      const [h, m] = [HOURS[row(hc, HOURS.length)], MINUTES[row(mc, MINUTES.length)]];
      if (`${h}:${m}` === `${hh}:${MINUTES[mi]}`) {
        // Ta sama wartość, ale lista stoi krzywo: dosuń.
        hoursCol.current?.scrollTo({ top: Number(hh) * ROW, behavior: 'smooth' });
        minutesCol.current?.scrollTo({ top: mi * ROW, behavior: 'smooth' });
      } else pick(h, m);
    }, 150);
  };
  useEffect(() => () => { if (settle.current) clearTimeout(settle.current); }, []);
  // Przeciąganie myszą jak palcem; ruch powyżej 4 px to przewijanie, nie klik.
  const drag = useRef<{ y: number; top: number; moved: boolean } | null>(null);
  const dragProps = (col: React.RefObject<HTMLDivElement | null>) => ({
    onPointerDown: (e: React.PointerEvent) => { suppress.current = false; if (e.pointerType === 'mouse' && col.current) drag.current = { y: e.clientY, top: col.current.scrollTop, moved: false }; },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || !col.current || !(e.buttons & 1)) return;
      if (Math.abs(e.clientY - d.y) > 4 && !d.moved) { d.moved = true; col.current.classList.add('dragging'); }
      if (d.moved) col.current.scrollTop = d.top - (e.clientY - d.y);
    },
    // Puszczenie: snap wraca i przeglądarka sama płynnie dociąga do najbliższego wiersza.
    onPointerUp: () => { if (drag.current?.moved) { release(col); suppress.current = true; } else drag.current = null; },
    onPointerLeave: () => { if (drag.current?.moved) release(col); else drag.current = null; },
    onClickCapture: (e: React.MouseEvent) => { if (suppress.current) e.stopPropagation(); suppress.current = false; },
    onScroll,
  });
  const suppress = useRef(false);
  const release = (col: React.RefObject<HTMLDivElement | null>) => {
    drag.current = null;
    col.current?.classList.remove('dragging');
    onScroll();
  };
  return (
    <span className="time-input-wrap">
      <input ref={field} className={`input time-input ${invalid ? 'invalid' : ''}`} aria-invalid={invalid} inputMode="numeric" maxLength={5} placeholder="14:00" value={text} disabled={disabled} aria-label={rest['aria-label'] ?? t('Time')}
        style={{ width: 72, ...style }} onChange={(e) => setText(maskTime(e.target.value, text))} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={() => { commit(); setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); setOpen(false); }
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
        }} />
      {open && !disabled && at && createPortal(
        // W <body>: okno spotkania ma animację (transform), która przesuwałaby position: fixed.
        // preventDefault na mousedown: pole nie traci fokusu, więc lista nie znika przy kliku w nią;
        // zamyka się kliknięciem obok, Enterem albo Escape.
        <div className="time-list" style={{ top: at.bottom + 214 > window.innerHeight ? at.top - 214 : at.bottom + 4, left: at.left }}
          onMouseDown={(e) => e.preventDefault()}>
          <div ref={hoursCol} className="time-col" role="listbox" aria-label={t('Hour')} {...dragProps(hoursCol)}>
            {HOURS.map((h) => (
              <button key={h} type="button" role="option" aria-selected={h === hh} className={h === hh ? 'on' : ''}
                onClick={() => pick(h, MINUTES[mi])}>{h}</button>
            ))}
          </div>
          <div ref={minutesCol} className="time-col" role="listbox" aria-label={t('Minute')} {...dragProps(minutesCol)}>
            {MINUTES.map((m, i) => (
              <button key={m} type="button" role="option" aria-selected={i === mi} className={i === mi ? 'on' : ''}
                onClick={() => pick(hh, m)}>{m}</button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}

export function DateInput({ value, onChange, disabled, style, ...rest }: Props) {
  const { text, setText, commit, invalid } = useCommitted(value, showDate, (raw) => parseDate(raw, Number(value.slice(0, 4)) || undefined), onChange, t('That is not a date. Use e.g. 21.10.2026.'));
  const picker = useRef<HTMLInputElement>(null);
  return (
    <span className="date-input" style={style}>
      {/* Kalendarz tylko z ikony: systemowy kalendarz otwarty klikiem w pole przejmuje klawiaturę i nie da się pisać. */}
      <input className={`input ${invalid ? 'invalid' : ''}`} aria-invalid={invalid} inputMode="numeric" maxLength={10} placeholder="21.10.2026" value={text} disabled={disabled} aria-label={rest['aria-label'] ?? t('Day')}
        onChange={(e) => setText(maskDate(e.target.value, text))}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />
      {/* Kalendarz z przeglądarki do wybierania klikiem; wpisana wartość i tak pokazuje się po polsku. */}
      <button type="button" className="icon-btn" aria-label={t('Pick a day')} disabled={disabled} onClick={() => picker.current?.showPicker?.()}><Icon.calendar size={14} /></button>
      <input ref={picker} type="date" tabIndex={-1} aria-hidden className="date-input-native" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </span>
  );
}
