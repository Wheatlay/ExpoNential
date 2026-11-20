import type { Project } from './projects.ts';
import * as svc from './service.ts';
import { identifier } from './rules.ts';
import { LOCALE, st } from './i18n.ts';
import { TYPE_LABEL_NAMES } from './analysis.ts';

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
      'Najpierw pobierz zgłoszenie: get_issue {id} i list_comments {id} (opis, analiza, decyzje, komentarze). Obrazki z opisu i komentarzy (/uploads/...) otwieraj przez get_attachment.',
      'Jeśli analiza ma „Powiązane”, przeczytaj ich pole AI (sekcje Gdzie i Decyzje): tam są miejsca w kodzie i rzeczy, których nie cofać.',
      'Dopiero potem wejdź w EnterPlanMode (tryb planu).',
      'Decyzje oznaczone „Ustalono” są już podjęte, trzymaj się ich. O pozostałe zapytaj mnie narzędziem AskUserQuestion (opcje z analizy, polecana pierwsza), a każdą odpowiedź zapisz w zgłoszeniu przez set_decision.',
    ].join('\n'),
    [
      'Przejrzyj kod wokół zmiany i napisz plan w dwóch częściach:',
      '1. „Co się zmieni” (na górze, dla mnie): językiem produktu, bez nazw plików i funkcji, np. „nowy przycisk Eksportuj w nagłówku listy zgłoszeń”. Krótka lista, którą mogę zatwierdzić jako całość.',
      '{typeGuide}',
      '2. „Technicznie”:',
      '- jak to wpasowuje się w architekturę: które istniejące wzorce i podobne funkcje w repo wykorzystasz, a gdzie odchodzisz od nich i dlaczego,',
      '- co może się zepsuć: inne ekrany, kanały i dane, które korzystają z tego samego,',
      '- kroki w kolejności commitów i jak sprawdzisz każdy.',
      'Gotowy plan oddaj przez ExitPlanMode (nie jako tekst w czacie).',
      'Czekaj na moje OK, zanim zaczniesz kodować.',
    ].join('\n'),
    'Commity z "{id}" w temacie. Po skończeniu: skill expo:close-ticket.',
  ].join('\n\n'),
  analyze: 'Użyj skilla expo:analyze-ticket dla {id}.',
  close: 'Zamknij {id} skillem expo:close-ticket.',
};

// Nazwy sekcji jak w analysis.ts (render): Related, Decided.
export const DEFAULT_PROMPTS_EN: Record<PromptKind, string> = {
  start: [
    'We are working on {id}: {title}',
    [
      'First fetch the issue: get_issue {id} and list_comments {id} (description, analysis, decisions, comments). Open images from the description and comments (/uploads/...) with get_attachment.',
      'If the analysis has "Related" issues, read their AI change notes: they list places in the code and things not to undo.',
      'Only then enter plan mode with EnterPlanMode.',
      'Decisions marked "Decided" are already made, stick to them. Ask me about the rest with the AskUserQuestion tool (options from the analysis, recommended first) and record each answer on the issue with set_decision.',
    ].join('\n'),
    [
      'Review the code around the change and write the plan in two parts:',
      '1. "What changes" (at the top, for me): in product language, no file or function names, e.g. "new Export button in the issue list header". A short list I can approve as a whole.',
      '{typeGuide}',
      '2. "Technical":',
      '- how it fits the architecture: which existing patterns and similar functions in the repo you will reuse, and where you depart from them and why,',
      '- what could break: other screens, channels and data that use the same thing,',
      '- steps in commit order and how you will check each one.',
      'Hand in the finished plan with ExitPlanMode (not as chat text).',
      'Wait for my OK before you start coding.',
    ].join('\n'),
    'Commits with "{id}" in the subject. When done: skill expo:close-ticket.',
  ].join('\n\n'),
  analyze: 'Use the skill expo:analyze-ticket for {id}.',
  close: 'Close {id} with the skill expo:close-ticket.',
};

// Wskazówka do części "Co się zmieni" zależna od etykiety typu (Bug/Feature z analizy); bez typu pusta.
export const TYPE_GUIDE: Record<'bug' | 'feature', string> = LOCALE === 'pl'
  ? {
    bug: '   To błąd: napisz, jak go odtworzyć, co dzieje się teraz i co ma się dziać po poprawce. Technicznie: przyczyna źródłowa i test, który najpierw pokazuje błąd.',
    feature: '   To nowa funkcja: napisz, co zobaczę i kliknę, w którym miejscu, i jak zachowa się w przypadkach brzegowych (puste dane, brak uprawnień).',
  }
  : {
    bug: '   This is a bug: say how to reproduce it, what happens now and what should happen after the fix. Technically: the root cause and a test that shows the bug first.',
    feature: '   This is a feature: say what I will see and click, where, and how it behaves in edge cases (empty data, no permission).',
  };

export const DEFAULT_PROMPTS: Record<PromptKind, string> = LOCALE === 'pl' ? DEFAULT_PROMPTS_PL : DEFAULT_PROMPTS_EN;

// Polecenia nie są edytowalne w projekcie (stare prompt* w bazie są ignorowane). Jak szukać i co zapisać
// przy Deep, mówi skill (tryb deep); rozpoznaje go po słowie "deep", tym samym w obu językach.
export const CODEX_ANALYZE_PROMPT = LOCALE === 'pl' ? 'Wywołaj narzędzie MCP get_procedure z name analyze i postępuj zgodnie z nim dla {id}.' : 'Call the MCP tool get_procedure with name analyze and follow it for {id}.';
export const CODEX_DEEP_PROMPT = LOCALE === 'pl' ? 'Wywołaj narzędzie MCP get_procedure z name analyze i postępuj zgodnie z nim dla {id}, tryb deep.' : 'Call the MCP tool get_procedure with name analyze and follow it for {id}, deep mode.';
export const DEEP_PROMPT = LOCALE === 'pl' ? 'Użyj skilla expo:analyze-ticket dla {id}, tryb deep.' : 'Use the skill expo:analyze-ticket for {id}, deep mode.';

// Modele lokalnej analizy (aliasy claude --model, zawsze najnowsza wersja). Pusty wybór projektu = domyślny.
export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const DEFAULT_MODELS = { analyze: 'sonnet', deep: 'opus' };
export const analysisModel = (p: Project, deep: boolean) => (deep ? p.deepModel || DEFAULT_MODELS.deep : p.analyzeModel || DEFAULT_MODELS.analyze);

export const PROMPT_VARS = ['{id}', '{title}', '{description}', '{analysis}', '{comments}'];


// Ucięte pole mówi wprost, że jest niepełne: inaczej agent bierze urywek za całość.
const cut = (s: string, n: number, id = '') =>
  s.length > n ? `${s.slice(0, n).trimEnd()}… ${st('[truncated{full}]', { full: id && st(', full text: get_issue {id}', { id }) })}` : s;

/**
 * Gotowe polecenie dla zgłoszenia. `compact` skraca długie pola: link vscode:// ma limit
 * długości, a pełne dane agent i tak pobiera przez get_issue.
 */
export async function renderPrompt(p: Project, number: number, kind: PromptKind, compact = false, deep = false, codex = false) {
  const d = await svc.getIssueDetail(p, number);
  const meta = await svc.getMeta(p);
  const labelNames = d.labelIds.map((l) => meta.labels.find((x) => x.id === l)?.name);
  const type = labelNames.includes(TYPE_LABEL_NAMES.bug) ? 'bug' : labelNames.includes(TYPE_LABEL_NAMES.feature) ? 'feature' : null;
  const who = (id: number | null) => meta.users.find((u) => u.id === id)?.name ?? '?';
  const lim = compact ? { text: 300, comment: 150, comments: 2 } : { text: 4000, comment: 600, comments: 5 };
  const id = identifier(p.key, number);
  const more = d.comments.length > lim.comments ? `\n- ${st('… and {n} older (list_comments {id})', { n: d.comments.length - lim.comments, id })}` : '';
  const vars: Record<string, string> = {
    id,
    title: d.title,
    typeGuide: type ? TYPE_GUIDE[type] : '',
    description: d.description.trim() && `${st('## Description')}\n${cut(d.description.trim(), lim.text, id)}`,
    analysis: d.analysis.trim() && `${st('## AI analysis (from the tracker)')}\n${cut(d.analysis.trim(), lim.text, id)}`,
    comments: d.comments.length
      ? `${st('## Recent comments')}\n${d.comments.slice(-lim.comments).map((c) => `- ${who(c.authorId)}: ${cut(c.body, lim.comment, id)}`).join('\n')}${more}`
      : '',
  };
  // Codex nie ma skilli Claude: procedurę bierze z MCP (get_procedure).
  const template = codex && kind === 'analyze' ? (deep ? CODEX_DEEP_PROMPT : CODEX_ANALYZE_PROMPT) : deep && kind === 'analyze' ? DEEP_PROMPT : DEFAULT_PROMPTS[kind];
  return template
    .replace(/\{(id|title|description|analysis|comments|typeGuide)\}/g, (_, k: string) => vars[k])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
