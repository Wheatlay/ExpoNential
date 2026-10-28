import { z } from 'zod';
import { st } from './i18n.ts';

/**
 * Analiza AI w formie danych: agent wypełnia sekcje i decyzje (set_analysis), tracker rysuje je
 * per sekcja i pozwala kliknąć wybór w decyzji. Markdown z render() trafia do pola `analysis`,
 * więc get_issue, polecenia dla Claude i stare analizy działają bez zmian.
 */
export const ANALYSIS_TYPES = ['bug', 'feature', 'investigate'] as const;

/** Etykieta zgłoszenia ustawiana przez analizę według typu; kolor tylko przy jej tworzeniu (dane, nie motyw UI). */
export const TYPE_LABEL_NAMES: Record<(typeof ANALYSIS_TYPES)[number], string> = { bug: 'Bug', feature: 'Feature', investigate: 'Investigate' };
export const TYPE_LABEL_COLORS: Record<string, string> = { Bug: '#eb5757', Feature: '#3b82f6', Investigate: '#f2994a' };

/** Kolejność wyświetlania. Które sekcje pasują do którego typu, mówi skill; tu każda jest opcjonalna. */
export const SECTION_KEYS = ['verdict', 'howToCheck', 'current', 'answer', 'todo', 'system', 'after', 'risk', 'related'] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** Nagłówki w markdown (dla agenta i eksportu; UI ma własne tłumaczenia). */
export const SECTION_LABELS: Record<SectionKey, string> = {
  verdict: 'Does it happen', howToCheck: 'How to reproduce', current: 'Current state', answer: 'Answer',
  todo: 'Anything to do', system: 'Also affects', after: 'After the change', risk: 'Watch out for', related: 'Related',
};
const TYPE_LABELS = { bug: 'bug', feature: 'feature', investigate: 'to investigate' } as const;

const text = (max: number) => z.string().trim().min(1).max(max);
export const optionSchema = z.object({
  label: text(80).describe('1-4 words'),
  desc: z.string().trim().max(200).default('').describe('Up to ~8 words: effect for the product'),
  recommended: z.boolean().optional().describe('true on the one option you recommend (at most one)'),
});
export const decisionSchema = z.object({
  question: text(300),
  options: z.array(optionSchema).min(2).max(4),
});

/** Wejście z MCP: same treści, bez wyborów (te robi człowiek w trackerze). */
export const analysisInputSchema = z.object({
  type: z.enum(ANALYSIS_TYPES),
  sections: z.object(Object.fromEntries(SECTION_KEYS.map((k) => [k, z.string().trim().max(1500).optional()])) as Record<SectionKey, z.ZodOptional<z.ZodString>>),
  decisions: z.array(decisionSchema).max(5).default([]),
}).superRefine((a, ctx) => {
  a.decisions.forEach((d, i) => {
    if (d.options.filter((o) => o.recommended).length > 1) ctx.addIssue({ code: 'custom', path: ['decisions', i], message: 'At most one recommended option' });
  });
  if (!SECTION_KEYS.some((k) => a.sections[k])) ctx.addIssue({ code: 'custom', path: ['sections'], message: 'At least one section is required' });
});
export type AnalysisInput = z.infer<typeof analysisInputSchema>;

export type Choice = { option: number | null; other: string; by: string; at: string };
export type AnalysisData = {
  type: (typeof ANALYSIS_TYPES)[number];
  sections: Partial<Record<SectionKey, string>>;
  decisions: (z.infer<typeof decisionSchema> & { choice?: Choice })[];
};

/** Nowa analiza z wejścia agenta. Wybory z poprzedniej przechodzą na pytania o tej samej treści. */
export function fromInput(input: AnalysisInput, prev: AnalysisData | null): AnalysisData {
  const sections: AnalysisData['sections'] = {};
  for (const k of SECTION_KEYS) if (input.sections[k]) sections[k] = input.sections[k];
  const decisions = input.decisions.map((d) => {
    const old = prev?.decisions.find((x) => x.question.trim().toLowerCase() === d.question.trim().toLowerCase());
    const choice = old?.choice && remap(old, d);
    return choice ? { ...d, choice } : { ...d };
  });
  return { type: input.type, sections, decisions };
}

/** Wybór ze starej decyzji w nowych opcjach (po nazwie opcji); własna odpowiedź zostaje. */
function remap(old: AnalysisData['decisions'][number], d: z.infer<typeof decisionSchema>): Choice | undefined {
  const c = old.choice!;
  if (c.option == null) return c;
  const label = old.options[c.option]?.label.toLowerCase();
  const i = d.options.findIndex((o) => o.label.toLowerCase() === label);
  return i >= 0 ? { ...c, option: i } : undefined;
}

export function chosenText(d: AnalysisData['decisions'][number]) {
  const c = d.choice;
  if (!c) return null;
  return c.option != null ? d.options[c.option]?.label ?? null : c.other || null;
}

/** Markdown do pola `analysis`: ten sam tekst czyta agent (get_issue, Start work) i eksport. */
export function render(a: AnalysisData): string {
  const out = [`**${st('Type')}:** ${st(TYPE_LABELS[a.type])}`];
  for (const k of SECTION_KEYS) if (a.sections[k]) out.push(`**${st(SECTION_LABELS[k])}:** ${a.sections[k]}`);
  if (a.decisions.length) {
    const lines = a.decisions.map((d, i) => {
      const chosen = chosenText(d);
      const head = `${i + 1}. ${d.question}${chosen ? `\n   **${st('Decided')}: ${chosen}** (${d.choice!.by})` : ''}`;
      const opts = d.options.map((o, j) => `   - **${o.label}${o.recommended ? ` (${st('recommended')})` : ''}:** ${o.desc}${d.choice?.option === j ? ' ✓' : ''}`);
      return [head, ...opts].join('\n');
    });
    out.push(`**${st('To decide')}**\n${lines.join('\n')}`);
  }
  return out.join('\n\n');
}

export function parseData(v: unknown): AnalysisData | null {
  return v && typeof v === 'object' && 'type' in v ? (v as AnalysisData) : null;
}
