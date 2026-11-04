import { toast } from './toast.ts';
import { t } from './i18n.ts';

/** Wgrywa wybrany plik obrazka (zdjęcie profilu, logo); zwraca URL albo null po błędzie (toast już pokazany). */
export async function uploadImageFile(file: File, maxBytes: number): Promise<string | null> {
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) { toast(t('Only PNG, JPEG, GIF and WebP images'), 'err'); return null; }
  if (file.size > maxBytes) { toast(t('Image is larger than {mb} MB', { mb: Math.round(maxBytes / 1024 / 1024) }), 'err'); return null; }
  const res = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
  if (!res.ok) { toast(t('Upload failed ({status})', { status: res.status }), 'err'); return null; }
  return ((await res.json()) as { url: string }).url;
}

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

const IMG_MD = /!\[image\]\((\/uploads\/[^)\s]+)\)/g;

/** Opis w polu edycji: długie `![image](/uploads/…)` skrócone do `![image 1]`; mapa pozwala je odtworzyć przy zapisie. */
export function collapseImages(md: string): { text: string; map: Record<string, string> } {
  const map: Record<string, string> = {};
  let n = 0;
  const text = md.replace(IMG_MD, (_m, url: string) => { const key = `![image ${++n}]`; map[key] = url; return key; });
  return { text, map };
}

export function expandImages(text: string, map: Record<string, string>): string {
  return text.replace(/!\[image \d+\]/g, (m) => (map[m] ? `![image](${map[m]})` : m));
}
