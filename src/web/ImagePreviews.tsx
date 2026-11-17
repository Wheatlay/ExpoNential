import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons.tsx';
import { pasteImage } from './paste.ts';
import { openLightbox } from './ImageBlock.tsx';
import { askConfirm } from './Confirm.tsx';
import { toast } from './toast.ts';
import { t } from './i18n.ts';

/**
 * Załączniki jak w Linearze: wklejony obrazek nie ląduje jako tekst w polu,
 * tylko jako podgląd pod nim; do treści dopisujemy go dopiero przy wysyłce.
 */
export function useAttachments() {
  const [urls, setUrls] = useState<string[]>([]);
  return {
    urls,
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void pasteImage(e).then((u) => { if (u) setUrls((x) => [...x, u]); }),
    remove: (u: string) => setUrls((x) => x.filter((y) => y !== u)),
    replace: (from: string, to: string) => setUrls((x) => x.map((y) => (y === from ? to : y))),
    clear: () => setUrls([]),
    /** Tekst z dopisanymi obrazkami (markdown) do zapisania. */
    withImages: (text: string) => [text.trim(), ...urls.map((u) => `![image](${u})`)].filter(Boolean).join('\n\n'),
  };
}

/** Kolory pisaka: kolory znaczeń z motywu (czerwony domyślnie: „tu jest błąd”). */
const PEN_VARS = ['--danger', '--warning', '--success', '--info'];
type Stroke = { color: string; width: number; pts: [number, number][] };

/** Sesja rysowania jednego obrazka: oryginał (do cofnięcia), aktualny zapis i kreski. */
type Session = { index: number; orig: string; cur: string; img: HTMLImageElement | null; strokes: Stroke[]; seq: number };

function paint(ctx: CanvasRenderingContext2D, img: HTMLImageElement, strokes: Stroke[]) {
  ctx.drawImage(img, 0, 0);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.01, s.pts[0][1]);
    ctx.stroke();
  }
}

async function upload(img: HTMLImageElement, strokes: Stroke[]): Promise<string | null> {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  paint(c.getContext('2d')!, img, strokes);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) return null;
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
  if (!res.ok) { toast(t('Upload failed ({status})', { status: res.status }), 'err'); return null; }
  return ((await res.json()) as { url: string }).url;
}

export function Attachments({ urls, onRemove, onReplace }: { urls: string[]; onRemove: (u: string) => void; onReplace?: (from: string, to: string) => void }) {
  const session = useRef<Session | null>(null);
  const [, render] = useState(0);
  const [full, setFull] = useState(false);
  const [color, setColor] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);
  const rerender = () => render((x) => x + 1);
  const s = session.current;

  // Fokus wraca do pola tekstu obok, żeby Esc i Ctrl+Enter działały dalej.
  const refocus = () => requestAnimationFrame(() => root.current?.parentElement?.querySelector<HTMLTextAreaElement>('textarea')?.focus());

  const start = (index: number) => {
    const im = new Image();
    session.current = { index, orig: urls[index], cur: urls[index], img: null, strokes: [], seq: 0 };
    im.onload = () => { if (session.current?.orig === urls[index]) { session.current.img = im; rerender(); } };
    im.src = urls[index];
    setColor(getComputedStyle(document.documentElement).getPropertyValue(PEN_VARS[0]).trim());
    setFull(false);
    rerender();
  };

  // Zapis sam po każdej kresce (z małym opóźnieniem): nowy plik zastępuje poprzedni w liście.
  const autosave = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const cur = session.current;
      if (!cur?.img || !onReplace) return;
      const seq = ++cur.seq;
      const url = cur.strokes.length ? await upload(cur.img, cur.strokes) : cur.orig;
      if (!url || session.current !== cur || seq !== cur.seq) return;
      onReplace(cur.cur, url);
      cur.cur = url;
    }, 400);
  };

  const finish = () => { window.clearTimeout(timer.current); const cur = session.current; session.current = null; setFull(false); rerender(); refocus(); return cur; };
  /** Zamknięcie bez zapisu: obrazek wraca do stanu sprzed otwarcia pisaka. */
  const discard = () => { const cur = finish(); if (cur && onReplace && cur.cur !== cur.orig) onReplace(cur.cur, cur.orig); };
  /** Klik poza obrazkiem: przy kreskach pyta, czy je zostawić (Esc i Keep zostawiają). */
  const leave = () => {
    if (!session.current?.strokes.length) { discard(); return; }
    void askConfirm({ title: t('Discard the drawing?'), action: t('Discard'), cancel: t('Keep'), danger: true }).then((ok) => {
      if (ok) discard();
      else { if (session.current) autosaveNow(); finish(); }
    });
  };
  // Zostawienie rysunku tuż po kresce: zapis od razu, nie po opóźnieniu.
  const autosaveNow = () => {
    const cur = session.current;
    window.clearTimeout(timer.current);
    if (!cur?.img || !onReplace || !cur.strokes.length) return;
    const seq = ++cur.seq;
    void upload(cur.img, cur.strokes).then((url) => { if (url && seq === cur.seq) { onReplace(cur.cur, url); cur.cur = url; } });
  };

  const stroke = (st: Stroke) => { session.current?.strokes.push(st); rerender(); autosave(); };
  const undo = () => { session.current?.strokes.pop(); rerender(); autosave(); };

  // Klik poza rysowanym obrazkiem (i poza jego paskiem) w widoku w polu.
  useEffect(() => {
    if (!s || full) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('.attachment.drawing, .backdrop.confirm-host, [role="alertdialog"]')) return;
      leave();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  });

  useEffect(() => {
    if (!s) return;
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"]')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (full) setFull(false); else leave(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!urls.length) return null;
  const colors = PEN_VARS.map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const tools = (
    <>
      {colors.map((c) => (
        <button key={c} type="button" className={`img-tool${c === color ? ' on' : ''}`} title={t('Pen color')} aria-label={t('Pen color')} aria-pressed={c === color} onClick={() => setColor(c)}>
          <span className="draw-swatch" style={{ background: c }} />
        </button>
      ))}
      <button type="button" className="img-tool" title={`${t('Undo')} (Ctrl+Z)`} aria-label={t('Undo')} disabled={!s?.strokes.length} onClick={undo}><Icon.undo size={14} /></button>
      <button type="button" className="img-tool" title={full ? t('Back') : t('Expand')} aria-label={full ? t('Back') : t('Expand')} onClick={() => setFull(!full)}><Icon.expand size={14} /></button>
      <button type="button" className="img-tool" title={t('Close without saving')} aria-label={t('Close without saving')} onClick={discard}><Icon.close size={15} /></button>
    </>
  );
  const canvas = s?.img ? <DrawCanvas img={s.img} strokes={s.strokes} color={color} onStroke={stroke} /> : null;
  return (
    <div className="attachments" ref={root}>
      {urls.map((u, i) => {
        const on = s?.index === i && onReplace;
        return (
          <span key={i} className={`attachment${on ? ' drawing' : ''}`}>
            {on && !full && canvas ? canvas : <img src={u} alt={t('Pasted image')} onClick={() => !on && openLightbox(u)} style={{ cursor: on ? 'default' : 'zoom-in' }} />}
            {on ? <span className="draw-tools">{tools}</span> : (
              <span className="attachment-tools">
                {onReplace && (
                  <button type="button" className="attachment-btn" aria-label={t('Draw on image')} title={t('Draw on image')} onClick={() => { if (session.current) leave(); else start(i); }}>
                    <Icon.edit size={13} />
                  </button>
                )}
                <button type="button" className="attachment-btn remove" aria-label={t('Remove image')} title={t('Remove image')} onClick={() => onRemove(u)}>
                  <Icon.close size={13} />
                </button>
              </span>
            )}
          </span>
        );
      })}
      {s && full && createPortal(
        <div className="lightbox draw-editor" onMouseDown={(e) => { if (e.target === e.currentTarget) leave(); }}>
          {canvas}
          <div className="lightbox-tools">{tools}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Płótno z obrazkiem i kreskami; rysowanie myszą, palcem albo rysikiem. */
function DrawCanvas({ img, strokes, color, onStroke }: { img: HTMLImageElement; strokes: Stroke[]; color: string; onStroke: (s: Stroke) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const current = useRef<Stroke | null>(null);
  const redraw = () => {
    const c = ref.current;
    if (!c) return;
    paint(c.getContext('2d')!, img, current.current ? [...strokes, current.current] : strokes);
  };
  useEffect(() => {
    const c = ref.current!;
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    redraw();
  }, [img]);
  useEffect(redraw);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)];
  };
  return (
    <canvas ref={ref} className="draw-canvas"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = e.currentTarget.getBoundingClientRect();
        // Grubość ok. 4 px na ekranie, niezależnie od rozdzielczości zrzutu.
        current.current = { color, width: Math.max(2, 4 * (e.currentTarget.width / r.width)), pts: [point(e)] };
        redraw();
      }}
      onPointerMove={(e) => { if (current.current) { current.current.pts.push(point(e)); redraw(); } }}
      onPointerUp={() => { if (current.current) { const st = current.current; current.current = null; onStroke(st); } }}
      onPointerCancel={() => { current.current = null; redraw(); }} />
  );
}
