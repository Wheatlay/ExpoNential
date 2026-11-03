import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireUser } from './auth.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(root, 'data/uploads');

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const QUOTA_BYTES = 200 * 1024 * 1024;
const DEMO_MAX = 1024 * 1024;

/** Czy początek pliku zgadza się z deklarowanym typem (sam nagłówek Content-Type nic nie dowodzi). */
export function matchesMagic(ext: string, b: Buffer) {
  const at = (off: number, s: string) => b.length >= off + s.length && b.toString('latin1', off, off + s.length) === s;
  switch (ext) {
    case 'png': return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg': return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP');
    default: return false;
  }
}

/** Suma rozmiarów plików użytkownika (nazwa zaczyna się od `u<id>-`; starsze pliki bez prefiksu nie liczą się do nikogo). */
function usedBytes(userId: number) {
  const prefix = `u${userId}-`;
  let sum = 0;
  try { for (const f of readdirSync(UPLOADS_DIR)) if (f.startsWith(prefix)) sum += statSync(path.join(UPLOADS_DIR, f)).size; } catch { /* katalog jeszcze nie istnieje */ }
  return sum;
}

/** Zapisuje plik pod losową nazwą i zwraca publiczny URL (nazwa jest nie do zgadnięcia). userId trafia do nazwy (limit na osobę). */
export function saveUpload(data: Buffer, ext: string, userId?: number) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${userId != null ? `u${userId}-` : ''}${randomBytes(16).toString('hex')}.${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, name), data);
  return `/uploads/${name}`;
}

export async function registerUploads(app: FastifyInstance) {
  app.register(async (r) => {
    // Limit liczony przez Fastify na faktycznie odebranych bajtach (nie z Content-Length); w demo 1 MB.
    const limit = process.env.DEMO_MODE === '1' ? DEMO_MAX : 10 * 1024 * 1024;
    r.addContentTypeParser(Object.keys(EXT), { parseAs: 'buffer', bodyLimit: limit }, (_req, body, done) => done(null, body));
    r.post('/api/uploads', { preHandler: requireUser, bodyLimit: limit }, async (req, reply) => {
      const ext = EXT[req.headers['content-type'] ?? ''];
      if (!ext) return reply.code(415).send({ error: 'Only PNG, JPEG, GIF and WebP images' });
      const data = req.body as Buffer;
      if (!matchesMagic(ext, data)) return reply.code(415).send({ error: 'File content does not match its type' });
      if (usedBytes(req.user!.id) + data.length > QUOTA_BYTES) return reply.code(413).send({ error: 'Upload quota exceeded' });
      return { url: saveUpload(data, ext, req.user!.id) };
    });
  });
}
