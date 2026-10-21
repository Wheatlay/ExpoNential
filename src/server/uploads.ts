import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireUser } from './auth.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(root, 'data/uploads');

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Zapisuje plik pod losową nazwą i zwraca publiczny URL (nazwa jest nie do zgadnięcia). */
export function saveUpload(data: Buffer, ext: string) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const name = `${randomBytes(16).toString('hex')}.${ext}`;
  writeFileSync(path.join(UPLOADS_DIR, name), data);
  return `/uploads/${name}`;
}

export async function registerUploads(app: FastifyInstance) {
  app.register(async (r) => {
    r.addContentTypeParser(Object.keys(EXT), { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    r.post('/api/uploads', { preHandler: requireUser }, async (req, reply) => {
      const ext = EXT[req.headers['content-type'] ?? ''];
      if (!ext) return reply.code(415).send({ error: 'Only PNG, JPEG, GIF and WebP images' });
      return { url: saveUpload(req.body as Buffer, ext) };
    });
  });
}
