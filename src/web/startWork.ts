import { api, queryClient, useMe, type Editor, type IssueDetail, type Me, type Meta } from './api.ts';
import { toast } from './toast.ts';
import { ident } from './project.ts';
import { t } from './i18n.ts';
import { openAgentRepos } from './settingsNav.ts';

type PromptKind = 'start' | 'analyze' | 'close';

/** Polecenie z szablonu projektu (Ustawienia), wypełnione danymi zgłoszenia przez serwer. */
export async function issuePrompt(number: number, kind: PromptKind, compact = false) {
  return (await api<{ prompt: string }>(`/api/issues/${ident(number)}/prompt/${kind}${compact ? '?compact=1' : ''}`)).prompt;
}

// Windows obcina dłuższe linki do aplikacji; powyżej tego progu bierzemy wersję ze skróconymi polami.
const MAX_LINK = 1900;

export const EDITOR_NAMES: Record<Editor, string> = { vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', terminal: 'Terminal' };
const EDITOR_SCHEMES: Record<Exclude<Editor, 'terminal'>, string> = { vscode: 'vscode', cursor: 'cursor', windsurf: 'windsurf' };

/** Link otwierający Claude Code w wybranym edytorze z wpisanym poleceniem; terminal nie ma linku (tylko przez agenta). */
export function editorLink(editor: Editor, prompt: string): string | null {
  if (editor === 'terminal') return null;
  return `${EDITOR_SCHEMES[editor]}://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
}

/** Nazwa edytora wybranego w Settings › My AI (do podpowiedzi). */
export function useEditorName() {
  return EDITOR_NAMES[useMe().data?.editor ?? 'vscode'];
}

const currentEditor = async (): Promise<Editor> =>
  (await queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') })).editor ?? 'vscode';

/** Otwiera link edytora z poleceniem (skróconym, gdy za długie) i zwraca, czy link poszedł; bez linku zostaje schowek. */
async function openPrompt(number: number, kind: PromptKind, editor: Editor, full: string) {
  let link = editorLink(editor, full);
  if (link && link.length > MAX_LINK) link = editorLink(editor, await issuePrompt(number, kind, true));
  if (!link || link.length > MAX_LINK) return false;
  location.href = link;
  return true;
}

/**
 * Otwiera nową kartę Claude Code w wybranym edytorze z wpisanym (niewysłanym) poleceniem i kopiuje
 * pełną treść do schowka, gdyby edytor się nie otworzył albo link musiał być pominięty.
 */
export async function openInClaude(number: number, kind: PromptKind) {
  const pending = issuePrompt(number, kind);
  const copied = copyLater(pending);
  const full = await pending;
  const editor = await currentEditor();
  const opened = await openPrompt(number, kind, editor, full);
  if (!opened) toast(t('Prompt copied. Paste it into {editor}.', { editor: EDITOR_NAMES[editor] }));
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

/** Telefon i tablet (ekran dotykowy): tam "Start work" nie otworzy edytora, więc polecenie leci do agenta na moim komputerze. */
export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;

/** "Start work": agent na moim komputerze otwiera edytor z poleceniem (albo przeglądarka otwiera link), przypisuje do mnie i przesuwa do In Progress (gdy jeszcze nie zaczęte). */
export async function startWork(number: number) {
  const res = api<{ viaAgent: true } | { viaAgent: false; prompt: string; noRepo?: boolean }>('/api/start-work', { method: 'POST', body: { issueId: ident(number) } });
  // Schowek musi dostać zapis jeszcze w geście kliknięcia; gdy poleceniem zajmuje się agent, obietnica odrzuca i schowek zostaje nietknięty.
  const copied = copyLater(res.then((r) => { if (r.viaAgent) throw new Error('agent'); return r.prompt; }));
  const [r, d, meta, me] = await Promise.all([
    res,
    api<IssueDetail>(`/api/issues/${ident(number)}`),
    queryClient.fetchQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/api/meta') }),
    queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me') }),
  ]);
  const editor = me.editor ?? 'vscode';
  let clip = false;
  if (r.viaAgent) toast(t('Opening in {editor}', { editor: EDITOR_NAMES[editor] }));
  else {
    // Bez folderu repo na PC link trafiłby do ostatnio aktywnego okna edytora (zwykle inne repo): tylko schowek i ostrzeżenie.
    const opened = r.noRepo ? false : await openPrompt(number, 'start', editor, r.prompt);
    clip = await copied;
    if (r.noRepo) { toast(t('This PC has no folder for the project repo. Set it in Settings › My AI.'), 'warn'); openAgentRepos(); }
    else if (!opened) toast(t(clip ? 'Prompt copied. Paste it into {editor}.' : 'Could not copy the prompt. Open it from the issue in {editor}.', { editor: EDITOR_NAMES[editor] }));
    else toast(t(clip ? 'Opening in {editor}. The prompt is also in your clipboard.' : 'Opening in {editor}', { editor: EDITOR_NAMES[editor] }));
  }
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
