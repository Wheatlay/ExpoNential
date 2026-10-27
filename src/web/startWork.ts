import { api, queryClient, type IssueDetail, type Me, type Meta } from './api.ts';
import { toast } from './toast.ts';
import { ident } from './project.ts';
import { t } from './i18n.ts';

type PromptKind = 'start' | 'analyze' | 'close';

/** Polecenie z szablonu projektu (Ustawienia), wypełnione danymi zgłoszenia przez serwer. */
export async function issuePrompt(number: number, kind: PromptKind, compact = false) {
  return (await api<{ prompt: string }>(`/api/issues/${ident(number)}/prompt/${kind}${compact ? '?compact=1' : ''}`)).prompt;
}

// Windows obcina dłuższe linki do aplikacji; powyżej tego progu bierzemy wersję ze skróconymi polami.
const MAX_LINK = 1900;
const claudeLink = (prompt: string) => `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;

/**
 * Otwiera nową kartę Claude Code w VS Code z wpisanym (niewysłanym) poleceniem i kopiuje
 * pełną treść do schowka, gdyby VS Code się nie otworzył albo link musiał być skrócony.
 */
export async function openInClaude(number: number, kind: PromptKind) {
  const pending = issuePrompt(number, kind);
  const copied = copyLater(pending);
  const full = await pending;
  let link = claudeLink(full);
  if (link.length > MAX_LINK) link = claudeLink(await issuePrompt(number, kind, true));
  if (link.length > MAX_LINK) link = claudeLink(`Pracujemy nad ${ident(number)}. Pełne dane: get_issue ${ident(number)}.`);
  location.href = link;
  return copied;
}

/**
 * Schowek musi dostać zapis jeszcze w obsłudze kliknięcia: Firefox odrzuca writeText po
 * kilku await (gest użytkownika wygasa). ClipboardItem przyjmuje obietnicę, więc tekst może
 * dojść później. Wynik: czy się udało (toast nie obiecuje schowka, gdy go nie ma).
 */
function copyLater(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined') {
      const blob = text.then((s) => new Blob([s], { type: 'text/plain' }));
      return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(() => true,
        () => text.then((s) => navigator.clipboard.writeText(s)).then(() => true, () => false));
    }
  } catch { /* stara przeglądarka: niżej writeText */ }
  return text.then((s) => navigator.clipboard.writeText(s)).then(() => true, () => false);
}

/** Analiza na komputerze dewelopera: lokalny skrypt obsługuje tracker:// (scripts/local-agent, instalacja z Settings). */
/** Z tokenem: pierwsza instalacja, instalator sam dodaje serwer MCP trackera każdemu kontu Claude Code. */
export const agentInstallCommand = (token?: string) =>
  `${token ? `$env:TRACKER_TOKEN='${token}'; ` : ''}irm ${location.origin}/agent/install.ps1 | iex`;
/**
 * Czy ta przeglądarka działa na komputerze z agentem (wtedy link tracker:// ruszy analizę od razu). Telefon i tablet nie;
 * laptop z ekranem dotykowym ręcznie przełącza to w Ustawieniach (localStorage), bo `pointer: coarse` bywa mylące.
 */
export function agentHere(me?: Me | null) {
  try {
    const v = localStorage.getItem('tracker.agentHere');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* prywatne okno */ }
  return !!me?.localAgentAt && !matchMedia('(pointer: coarse)').matches;
}
export function runLocalAnalysis(number: number, deep: boolean) {
  location.href = `tracker://analyze/${ident(number)}${deep ? '?deep' : ''}`;
}

/** "Start work": otwiera Claude z poleceniem, przypisuje do mnie i przesuwa do In Progress (gdy jeszcze nie zaczęte). */
export async function startWork(number: number) {
  const opened = openInClaude(number, 'start'); // pierwsze: schowek jeszcze w geście kliknięcia
  const [d, meta, me] = await Promise.all([
    api<IssueDetail>(`/api/issues/${ident(number)}`),
    queryClient.fetchQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/api/meta') }),
    queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') }),
  ]);
  const copied = await opened;
  const cur = meta.statuses.find((s) => s.id === d.statusId);
  const inProgress = meta.statuses.find((s) => s.type === 'started' && /progress/i.test(s.name)) ?? meta.statuses.find((s) => s.type === 'started');
  const patch: Record<string, unknown> = {};
  if (inProgress && cur && (cur.type === 'backlog' || cur.type === 'unstarted')) patch.statusId = inProgress.id;
  if (d.assigneeId == null) patch.assigneeId = me.id;
  if (Object.keys(patch).length) {
    await api(`/api/issues/${ident(number)}`, { method: 'PATCH', body: patch });
    void queryClient.invalidateQueries({ queryKey: ['issues'] });
    void queryClient.invalidateQueries({ queryKey: ['issue', number] });
  }
  toast(t((await copied) ? 'Opening Claude Code with {id}. The prompt is also in your clipboard.' : 'Opening Claude Code with {id}.', { id: ident(number) }));
}

/** Telefon: zleca agentowi na moim komputerze otwarcie Claude Code z zadaniem (serwer też przypisuje i przesuwa do In Progress). */
export async function startOnPc(number: number) {
  await api(`/api/issues/${ident(number)}/start-on-pc`, { method: 'POST' });
  void queryClient.invalidateQueries({ queryKey: ['issues'] });
  void queryClient.invalidateQueries({ queryKey: ['issue', number] });
  toast(t('Sent to your PC. Claude Code opens there in a few seconds if the PC is on and up to date.'));
}

/** Demo: zamiast prawdziwego agenta serwer odgrywa nagraną sesję; zmiany wracają zwykłym SSE. */
export async function simulateAgent(number: number, kind: 'analyze' | 'work') {
  try {
    await api(`/api/demo/simulate/${ident(number)}`, { method: 'POST', body: { kind } });
    void queryClient.invalidateQueries({ queryKey: ['issue', number] });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'busy') toast(t('The agent is already working on this issue'), 'warn');
    else if (!['demo', 'rate'].includes((e as { code?: string }).code ?? '')) toast((e as Error).message, 'err');
    return false;
  }
}
