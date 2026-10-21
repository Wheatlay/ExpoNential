import type { StatusType } from '../db/schema.ts';

export const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const;

export function identifier(key: string, number: number) {
  return `${key}-${number}`;
}

/** Klucz projektu: 2-6 wielkich liter (np. ACME, WEB). */
export function isProjectKey(key: string) {
  return /^[A-Z]{2,6}$/.test(key);
}

/** Przyjmuje "WEB-12", "acme-12" albo "12" (bez klucza: key = null, projekt wybiera wołający). */
export function parseIdentifier(id: string | number): { key: string | null; number: number } | null {
  if (typeof id === 'number') return Number.isInteger(id) && id > 0 ? { key: null, number: id } : null;
  const m = /^(?:([a-z]{2,6})-)?(\d+)$/i.exec(id.trim());
  if (!m || Number(m[2]) < 1) return null;
  return { key: m[1]?.toUpperCase() ?? null, number: Number(m[2]) };
}

/** Wszystkie identyfikatory KEY-n z treści commita (tylko podane klucze), bez duplikatów. */
export function extractIssueRefs(text: string, keys: string[]): { key: string; number: number }[] {
  if (!keys.length) return [];
  const re = new RegExp(`\\b(${keys.join('|')})-(\\d+)\\b`, 'gi');
  const out = new Map<string, { key: string; number: number }>();
  for (const m of text.matchAll(re)) {
    const ref = { key: m[1].toUpperCase(), number: Number(m[2]) };
    out.set(`${ref.key}-${ref.number}`, ref);
  }
  return [...out.values()];
}

/** Status "Need Info" rozpoznajemy po roli (admin ustawia ją w Settings), nazwa może być dowolna. */
export function isNeedInfo(s: { role?: string | null }) {
  return s.role === 'need_info';
}

export class RuleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/**
 * Done bez opisów zmian: miękkie ostrzeżenie (decyzja zespołu, wcześniej twarda blokada).
 * Zwraca tekst ostrzeżenia albo null. Canceled/duplicate nie wymagają niczego.
 */
export function doneNotesWarning(target: StatusType, issue: { changeHuman: string; changeAi: string }): string | null {
  if (target !== 'completed') return null;
  const missing = [];
  if (!issue.changeHuman.trim()) missing.push('HUMAN');
  if (!issue.changeAi.trim()) missing.push('AI');
  if (!missing.length) return null;
  return `Done without the ${missing.join(' and ')} change notes`;
}

/** Komentarze z dawnego skilla close-linear-ticket: "**HUMAN**\n\n…" / "**AI**\n\n…". */
export function parseChangeNoteComment(body: string): { kind: 'human' | 'ai'; text: string } | null {
  const m = /^\s*\*\*(HUMAN|AI)\*\*\s*\n([\s\S]*)$/.exec(body);
  if (!m) return null;
  const text = m[2].trim();
  if (!text) return null;
  return { kind: m[1] === 'HUMAN' ? 'human' : 'ai', text };
}

/** Pozycja między sąsiadami przy przeciąganiu (fractional ordering). */
export function sortBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 0;
  if (before == null) return after! - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

/** Sekrety w adresach (webhook Coolify, link kalendarza) nie trafiają do logów. */
export function maskUrl(url: string) { return url.replace(/([?&]secret=)[^&]*/i, '$1***').replace(/(\/calendar\/)[^/?]+/, '$1***'); }
