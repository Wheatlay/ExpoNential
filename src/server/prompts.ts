import type { Project } from './projects.ts';
import * as svc from './service.ts';
import { identifier } from './rules.ts';
import { LOCALE, st } from './i18n.ts';

/**
 * Polecenia dla Claude Code, które tracker podaje z guzików. Treść edytuje admin projektu
 * w Ustawieniach; tu są domyślne i jedyne miejsce, gdzie wstawia się dane zgłoszenia.
 * Uprawnienia agenta (co mu wolno) NIE są w szablonie, tylko w lokalnym skrypcie.
 */
export const PROMPT_KINDS = ['start', 'analyze', 'close'] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

export const DEFAULT_PROMPTS_PL: Record<PromptKind, string> = {
  // Bez wklejonego opisu i analizy: agent pobiera je przez MCP w całości, a link vscode:// ma limit
  // długości, przez który ucięta analiza gubiła decyzje. "Pracujemy nad {id}" przypina sesję (hook).
  start: [
    'Pracujemy nad {id}: {title}',
    [
      'Najpierw pobierz zgłoszenie: get_issue {id} i list_comments {id} (opis, analiza, decyzje, komentarze).',
      'Jeśli analiza ma „Powiązane”, przeczytaj ich pole AI (sekcje Gdzie i Decyzje): tam są miejsca w kodzie i rzeczy, których nie cofać.',
      'Decyzje oznaczone „Ustalono” są już podjęte, trzymaj się ich. O pozostałe zapytaj mnie narzędziem AskUserQuestion (opcje z analizy, polecana pierwsza).',
    ].join('\n'),
    [
      'Potem przejrzyj kod wokół zmiany i napisz plan:',
      '- jak to wpasowuje się w architekturę: które istniejące wzorce i podobne funkcje w repo wykorzystasz, a gdzie odchodzisz od nich i dlaczego,',
      '- co może się zepsuć: inne ekrany, kanały i dane, które korzystają z tego samego,',
      '- kroki w kolejności commitów i jak sprawdzisz każdy.',
      'Czekaj na moje OK, zanim zaczniesz kodować.',
    ].join('\n'),
    'Commity z "{id}" w temacie. Po skończeniu: skill tracker:close-ticket.',
  ].join('\n\n'),
  analyze: 'Użyj skilla tracker:analyze-tracker-ticket dla {id}.',
  close: 'Zamknij {id} skillem tracker:close-ticket.',
};

// Nazwy sekcji jak w analysis.ts (render): Related, Decided.
export const DEFAULT_PROMPTS_EN: Record<PromptKind, string> = {
  start: [
    'We are working on {id}: {title}',
    [
      'First fetch the issue: get_issue {id} and list_comments {id} (description, analysis, decisions, comments).',
      'If the analysis has "Related" issues, read their AI change notes: they list places in the code and things not to undo.',
      'Decisions marked "Decided" are already made, stick to them. Ask me about the rest with the AskUserQuestion tool (options from the analysis, recommended first).',
    ].join('\n'),
    [
      'Then review the code around the change and write a plan:',
      '- how it fits the architecture: which existing patterns and similar functions in the repo you will reuse, and where you depart from them and why,',
      '- what could break: other screens, channels and data that use the same thing,',
      '- steps in commit order and how you will check each one.',
      'Wait for my OK before you start coding.',
    ].join('\n'),
    'Commits with "{id}" in the subject. When done: skill tracker:close-ticket.',
  ].join('\n\n'),
  analyze: 'Use the skill tracker:analyze-tracker-ticket for {id}.',
  close: 'Close {id} with the skill tracker:close-ticket.',
};

export const DEFAULT_PROMPTS: Record<PromptKind, string> = LOCALE === 'pl' ? DEFAULT_PROMPTS_PL : DEFAULT_PROMPTS_EN;

export const PROMPT_VARS = ['{id}', '{title}', '{description}', '{analysis}', '{comments}'];

const column = { start: 'promptStart', analyze: 'promptAnalyze', close: 'promptClose' } as const;

// Ucięte pole mówi wprost, że jest niepełne: inaczej agent bierze urywek za całość.
const cut = (s: string, n: number, id = '') =>
  s.length > n ? `${s.slice(0, n).trimEnd()}… ${st('[truncated{full}]', { full: id && st(', full text: get_issue {id}', { id }) })}` : s;

/**
 * Gotowe polecenie dla zgłoszenia. `compact` skraca długie pola: link vscode:// ma limit
 * długości, a pełne dane agent i tak pobiera przez get_issue.
 */
export async function renderPrompt(p: Project, number: number, kind: PromptKind, compact = false) {
  const d = await svc.getIssueDetail(p, number);
  const meta = await svc.getMeta(p);
  const who = (id: number | null) => meta.users.find((u) => u.id === id)?.name ?? '?';
  const lim = compact ? { text: 300, comment: 150, comments: 2 } : { text: 4000, comment: 600, comments: 5 };
  const id = identifier(p.key, number);
  const more = d.comments.length > lim.comments ? `\n- ${st('… and {n} older (list_comments {id})', { n: d.comments.length - lim.comments, id })}` : '';
  const vars: Record<string, string> = {
    id,
    title: d.title,
    description: d.description.trim() && `${st('## Description')}\n${cut(d.description.trim(), lim.text, id)}`,
    analysis: d.analysis.trim() && `${st('## AI analysis (from the tracker)')}\n${cut(d.analysis.trim(), lim.text, id)}`,
    comments: d.comments.length
      ? `${st('## Recent comments')}\n${d.comments.slice(-lim.comments).map((c) => `- ${who(c.authorId)}: ${cut(c.body, lim.comment, id)}`).join('\n')}${more}`
      : '',
  };
  const template = p[column[kind]] || DEFAULT_PROMPTS[kind];
  return template
    .replace(/\{(id|title|description|analysis|comments)\}/g, (_, k: string) => vars[k])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
