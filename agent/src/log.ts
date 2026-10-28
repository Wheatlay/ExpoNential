import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

const MAX = 1024 * 1024;

export const logFile = () => join(dataDir(), 'log.txt');

export function logRaw(text: string) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    const f = logFile();
    try { if (statSync(f).size > MAX) renameSync(f, join(dataDir(), 'log.old.txt')); } catch { /* no file yet */ }
    appendFileSync(f, text);
  } catch { /* logging must never throw */ }
}

export const log = (m: string) => logRaw(`${new Date().toISOString()} agent: ${m}\n`);
