import { readFileSync } from 'node:fs';

/** Procedury agenta (analiza i zamykanie zgłoszenia), serwowane przez MCP: działają w każdym kliencie, nie tylko w pluginie Claude Code. */
const load = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

export const procedures: Record<'analyze' | 'close', { title: string; text: string }> = {
  analyze: { title: 'Analyze an issue', text: load('analyze.md') },
  close: { title: 'Close an issue with change notes', text: load('close.md') },
};
