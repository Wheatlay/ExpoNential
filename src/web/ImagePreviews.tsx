import { useState } from 'react';
import { Icon } from './icons.tsx';
import { pasteImage } from './paste.ts';
import { openLightbox } from './ImageBlock.tsx';
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
    clear: () => setUrls([]),
    /** Tekst z dopisanymi obrazkami (markdown) do zapisania. */
    withImages: (text: string) => [text.trim(), ...urls.map((u) => `![image](${u})`)].filter(Boolean).join('\n\n'),
  };
}

export function Attachments({ urls, onRemove }: { urls: string[]; onRemove: (u: string) => void }) {
  if (!urls.length) return null;
  return (
    <div className="attachments">
      {urls.map((u) => (
        <span key={u} className="attachment">
          <img src={u} alt={t('Pasted image')} onClick={() => openLightbox(u)} style={{ cursor: "zoom-in" }} />
          <button type="button" className="attachment-remove" aria-label={t('Remove image')} title={t('Remove image')} onClick={() => onRemove(u)}>
            <Icon.close size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}
