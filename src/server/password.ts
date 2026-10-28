import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Hasło: min. 10, max. 200 znaków. Hash: scrypt, zapis `scrypt$N$r$p$sól$hash` (base64). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: Math.max(MAXMEM, 256 * n * r) }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await derive(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Hash atrapy: przy braku konta liczymy tyle samo co przy złym haśle, żeby czas odpowiedzi nie zdradzał, czy konto istnieje. */
let dummy: Promise<string> | null = null;
export function dummyHash() {
  return (dummy ??= hashPassword(randomBytes(16).toString('hex')));
}

/** Zwraca tekst błędu albo null, gdy hasło spełnia wymagania. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

/** Limit nieudanych prób w pamięci: `max` porażek w oknie `windowMs` na klucz (np. IP + e-mail). */
export function createAttemptLimiter(max = 10, windowMs = 15 * 60_000) {
  const hits = new Map<string, { start: number; count: number }>();
  const live = (key: string) => {
    const h = hits.get(key);
    if (h && Date.now() - h.start > windowMs) { hits.delete(key); return undefined; }
    return h;
  };
  return {
    blocked: (key: string) => (live(key)?.count ?? 0) >= max,
    fail: (key: string) => {
      if (hits.size > 10_000) for (const k of hits.keys()) live(k);
      const h = live(key);
      if (h) h.count++; else hits.set(key, { start: Date.now(), count: 1 });
    },
    reset: (key: string) => void hits.delete(key),
  };
}

export const loginLimiter = createAttemptLimiter();
