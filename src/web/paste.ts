import { toast } from './toast.ts';
import { t } from './i18n.ts';

/**
 * Wklejony obrazek (zrzut ekranu) idzie na serwer; zwraca jego URL albo null, gdy w schowku nie ma obrazka.
 * Firefox podaje zrzut przez clipboardData.items, Chrome także przez files: sprawdzamy oba.
 */
export async function pasteImage(e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<string | null> {
  const fromItems = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
  const file = fromItems.find((f): f is File => !!f) ?? [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
  if (!file) return null;
  e.preventDefault();
  const type = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) ? file.type : 'image/png';
  if (file.size > 10 * 1024 * 1024) { toast(t('Image is larger than 10 MB'), 'err'); return null; }
  toast(t('Uploading image…'));
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': type }, body: file });
  if (!res.ok) { toast(t('Upload failed ({status})', { status: res.status }), 'err'); return null; }
  const { url } = (await res.json()) as { url: string };
  return url;
}
