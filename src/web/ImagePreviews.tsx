import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { pasteImage } from './paste.ts';
import { openLightbox } from './ImageBlock.tsx';
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

export function Attachments({ urls, onRemove, onReplace }: { urls: string[]; onRemove: (u: string) => void; onReplace?: (from: string, to: string) => void }) {
  const [drawing, setDrawing] = useState<string | null>(null);
  if (!urls.length) return null;
  return (
    <div className="attachments">
      {urls.map((u) => (
        <span key={u} className="attachment">
          <img src={u} alt={t('Pasted image')} onClick={() => openLightbox(u)} style={{ cursor: "zoom-in" }} />
          <span className="attachment-tools">
            {onReplace && (
              <button type="button" className="attachment-btn" aria-label={t('Draw on image')} title={t('Draw on image')} onClick={() => setDrawing(u)}>
                <Icon.edit size={13} />
              </button>
            )}
            <button type="button" className="attachment-btn remove" aria-label={t('Remove image')} title={t('Remove image')} onClick={() => onRemove(u)}>
              <Icon.close size={13} />
            </button>
          </span>
        </span>
      ))}
      {drawing && onReplace && (
        <DrawEditor src={drawing} onClose={() => setDrawing(null)} onSaved={(url) => { onReplace(drawing, url); setDrawing(null); }} />
      )}
    </div>
  );
}

/** Kolory pisaka: kolory znaczeń z motywu (czerwony domyślnie: „tu jest błąd”). */
const PEN_VARS = ['--danger', '--warning', '--success', '--info'];
type Stroke = { color: string; width: number; pts: [number, number][] };

/** Rysowanie pisakiem po obrazku, np. zaznaczenie miejsca błędu na zrzucie ekranu. Zapis wgrywa nowy PNG. */
function DrawEditor({ src, onClose, onSaved }: { src: string; onClose: () => void; onSaved: (url: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const colors = PEN_VARS.map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
  const [color, setColor] = useState(colors[0]);
  const [count, setCount] = useState(0);
  const [saving, setSaving] = useState(false);

  const redraw = () => {
    const c = canvas.current; const im = img.current;
    if (!c || !im) return;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(im, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.01, s.pts[0][1]);
      ctx.stroke();
    }
  };

  useEffect(() => {
    const im = new Image();
    im.onload = () => {
      img.current = im;
      const c = canvas.current!;
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      redraw();
    };
    im.src = src;
  }, [src]);

  const undo = () => { strokes.current.pop(); setCount(strokes.current.length); redraw(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)];
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    // Grubość ok. 4 px na ekranie, niezależnie od rozdzielczości zrzutu.
    current.current = { color, width: Math.max(2, 4 * (e.currentTarget.width / r.width)), pts: [point(e)] };
    redraw();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!current.current) return;
    current.current.pts.push(point(e));
    redraw();
  };
  const up = () => {
    if (!current.current) return;
    strokes.current.push(current.current);
    current.current = null;
    setCount(strokes.current.length);
  };

  const save = async () => {
    if (!canvas.current) return;
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((r) => canvas.current!.toBlob(r, 'image/png'));
      if (!blob) throw new Error();
      const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
      if (!res.ok) { toast(t('Upload failed ({status})', { status: res.status }), 'err'); return; }
      onSaved(((await res.json()) as { url: string }).url);
    } catch {
      toast(t('Upload failed ({status})', { status: 0 }), 'err');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lightbox draw-editor" onClick={(e) => e.stopPropagation()}>
      <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="lightbox-tools">
        {colors.map((c) => (
          <button key={c} type="button" className={`img-tool${c === color ? ' on' : ''}`} title={t('Pen color')} aria-label={t('Pen color')} aria-pressed={c === color} onClick={() => setColor(c)}>
            <span className="draw-swatch" style={{ background: c }} />
          </button>
        ))}
        <button type="button" className="img-tool" title={`${t('Undo')} (Ctrl+Z)`} aria-label={t('Undo')} disabled={!count} onClick={undo}><Icon.undo size={14} /></button>
        <button type="button" className="img-tool" title={t('Save drawing')} aria-label={t('Save drawing')} disabled={!count || saving} onClick={() => void save()}><Icon.check size={15} /></button>
        <button type="button" className="img-tool" title={t('Close (Esc)')} aria-label={t('Close (Esc)')} onClick={onClose}><Icon.close size={15} /></button>
      </div>
    </div>
  );
}
