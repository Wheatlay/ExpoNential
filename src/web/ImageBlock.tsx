import { useEffect, useSyncExternalStore } from 'react';
import { Icon } from './icons.tsx';
import { copyText, toast } from './toast.ts';
import { t } from './i18n.ts';

let open: string | null = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());
export function openLightbox(src: string) { open = src; emit(); }
function closeLightbox() { open = null; emit(); }

/** Podgląd obrazka na pełny ekran (klik w tło albo Esc zamyka). */
export function LightboxHost() {
  const src = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => open);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [src]);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={closeLightbox}>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-tools" onClick={(e) => e.stopPropagation()}>
        <ImageTools src={src} />
        <button className="img-tool" title={t('Close (Esc)')} onClick={closeLightbox}><Icon.close size={15} /></button>
      </div>
    </div>
  );
}

async function copyImage(src: string) {
  try {
    const blob = await (await fetch(src)).blob();
    // Schowek przyjmuje pewnie tylko PNG: inne formaty przepuszczamy przez canvas.
    const png = blob.type === 'image/png' ? blob : await toPng(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast(t('Image copied'));
  } catch {
    toast(t('Copying images is not supported in this browser'), 'err');
  }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
}

function ImageTools({ src, onExpand }: { src: string; onExpand?: () => void }) {
  const name = src.split('/').pop() ?? 'image.png';
  return (
    <>
      {onExpand && <button className="img-tool" title={t('Expand')} onClick={onExpand}><Icon.expand size={14} /></button>}
      <a className="img-tool" title={t('Download')} href={src} download={name}><Icon.download size={14} /></a>
      <button className="img-tool" title={t('Copy image')} onClick={() => void copyImage(src)}><Icon.copy size={14} /></button>
      <button className="img-tool" title={t('Copy link')} onClick={() => copyText(new URL(src, location.origin).href, t('Link copied'))}><Icon.link size={14} /></button>
    </>
  );
}

/** Obrazek w treści (opis, komentarz): pasek narzędzi na hover jak w Linearze, klik powiększa. */
export function ImageBlock({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  return (
    <span className="img-block" onClick={(e) => e.stopPropagation()}>
      <img src={src} alt={alt ?? ''} onClick={() => openLightbox(src)} />
      <span className="img-tools"><ImageTools src={src} onExpand={() => openLightbox(src)} /></span>
    </span>
  );
}
