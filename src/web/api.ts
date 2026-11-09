import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from './toast.ts';
import { receivePresence } from './presence.ts';
import { getProjectKey, ident, onProjectChange } from './project.ts';
import { t } from './i18n.ts';

export type StatusType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'duplicate';
export type Status = { id: number; name: string; type: StatusType; color: string; position: number; hiddenOnBoard: boolean; role: 'need_info' | 'testing' | null };
export type Label = { id: number; name: string; color: string };
export type User = { id: number; login: string; name: string; avatarUrl: string | null; isAdmin: boolean; active: boolean; role?: 'admin' | 'member'; tagIds?: number[] };
export type ProjectSummary = { id: number; key: string; name: string; color: string; logoUrl: string; role: 'admin' | 'member'; memberCount: number; githubRepo: string };
export type Me = { id: number; name: string; login: string; avatarUrl: string | null; avatarCustom: boolean; provider: 'github' | 'google' | null; isAdmin: boolean; hasPassword: boolean; hasAgent: boolean; agentOnline: boolean; agentLastSeen: string | null; agentOutdated: boolean; demo?: boolean; editor: Editor;
  setupDoneAt: string | null; lang: 'en' | 'pl' | null; aiStatus: { attention: string[]; client: boolean; clientName: string | null; clientAt: string | null; workTrace: boolean; agent: boolean; clients?: Record<'Claude Code' | 'Codex' | 'Cursor', { connected: boolean; at: string | null }> } };
export type Editor = 'vscode' | 'cursor' | 'windsurf' | 'terminal';
export type AppConfig = { demo: boolean; repoUrl: string | null; providers: { github: boolean; google: boolean }; devLogin?: boolean };
export type TagColor = 'green' | 'teal' | 'sky' | 'violet' | 'pink' | 'amber' | 'blue' | 'slate';
export const TAG_COLORS: TagColor[] = ['green', 'teal', 'sky', 'violet', 'pink', 'amber', 'blue', 'slate'];
/** Tag osób (#nazwa): pisząc go, powiadamiasz wszystkich członków. */
export type Tag = { id: number; name: string; color: TagColor; createdBy: number | null; memberIds: number[] };
export type Meta = { statuses: Status[]; labels: Label[]; users: User[]; priorities: string[]; tags: Tag[] };
export type InboxItem = {
  id: number; kind: 'mention' | 'tag' | 'question'; projectKey: string; issueNumber: number; issueTitle: string;
  actorId: number | null; actorName: string | null; tagName: string | null; excerpt: string; createdAt: string; readAt: string | null;
};
export type Sprint = { id: number; name: string; startsAt: string; endsAt: string; status: 'planned' | 'active' | 'ended' | 'reviewed'; reviewNotes: string };

export type Vote = 'yes' | 'maybe' | 'no';
export type MeetingSlot = { id: number; startsAt: string; endsAt: string; proposedBy: number | null; reason: string | null; votes: { userId: number; vote: Vote; note?: string | null }[] };
export type Meeting = {
  id: number; title: string; kind: 'poll' | 'fixed' | 'sprint_review'; status: 'polling' | 'scheduled' | 'cancelled' | 'expired';
  startsAt: string | null; endsAt: string | null; locationUrl: string; agenda: string; sprintId: number | null; createdBy: number | null;
  /** null = cały projekt */
  attendeeIds: number[] | null;
  reminders: number[]; slots: MeetingSlot[];
};
export type NotifySettings = { inApp: boolean; push: boolean; discord: boolean; onlyImportant: boolean; notifyPromptShown: boolean; pushKey: string | null; analysisToastSticky: boolean; discordProjects: { key: string; name: string }[] };

export type IssueRow = {
  id: number; number: number; title: string; statusId: number; assigneeId: number | null; creatorId: number | null; priority: number;
  parentId: number | null; sprintId: number | null; sortOrder: number; analysisRequestedAt: string | null; analysisClaimedAt: string | null; analysisClaimedDeviceName?: string | null;
  hasAnalysis: boolean; hasChangeNotes: boolean; changeNotesStale?: boolean; createdAt: string; updatedAt: string; completedAt: string | null;
  labelIds: number[]; subTotal: number; subDone: number; waitingOn: number[];
  infoFromId: number | null; infoTagId?: number | null; infoQuestion: string; infoById: number | null;
  unreadComments: number; wasTested: boolean;
  analysisWaitReason?: AnalysisWaitReason | null;
};

export type ActivityPayload =
  | { kind: 'created' }
  | { kind: 'status'; from: string | null; to: string }
  | { kind: 'assignee'; from: string | null; to: string | null }
  | { kind: 'priority'; from: number; to: number }
  | { kind: 'labels'; added: string[]; removed: string[] }
  | { kind: 'field'; field: string }
  | { kind: 'analysis_requested'; deep?: boolean }
  | { kind: 'analysis_claimed'; device: string }
  | { kind: 'analysis_failed'; error: string }
  | { kind: 'decision'; question: string; answer: string | null }
  | { kind: 'sprint'; to: string | null }
  | { kind: 'parent'; to: number | null }
  | { kind: 'commit'; sha: string; message: string; url: string; author: string }
  | { kind: 'deploy'; sha: string; env?: string; prod?: true }
  | { kind: 'worklog'; session: string; repo: string; files: string[]; commits: { sha: string; message: string }[]; prompts: string[]; updatedAt: string }
  | { kind: 'question'; to: string; question: string }
  | { kind: 'answered'; by: string; backTo: string | null }
  | { kind: 'relation'; action: 'added' | 'removed'; relation: RelationKind; other: number };

export type RelationKind = 'waits_on' | 'blocks' | 'related' | 'duplicate_of' | 'duplicated_by';
export type RelatedIssue = { number: number; title: string; statusId: number; open: boolean };

/** Jak AnalysisData w src/server/analysis.ts. */
export type AnalysisData = {
  type: 'bug' | 'feature' | 'investigate';
  sections: Partial<Record<'verdict' | 'howToCheck' | 'current' | 'answer' | 'todo' | 'system' | 'after' | 'risk' | 'related', string>>;
  decisions: {
    question: string;
    options: { label: string; desc: string; recommended?: boolean }[];
    choice?: { option: number | null; other: string; by: string; at: string };
  }[];
};

export type AnalysisWaitReason = 'queue_off' | 'no_pc_online' | 'no_repo_pc' | 'awaiting_consent';

export type IssueDetail = {
  id: number; number: number; identifier: string; title: string; description: string; statusId: number;
  assigneeId: number | null; creatorId: number | null; priority: number; parentId: number | null; sprintId: number | null;
  analysis: string; analysisData: AnalysisData | null; analysisRequestedAt: string | null; analysisUpdatedAt: string | null; analysisDeep: boolean; analysisResultDeep: boolean; analysisClaimedAt: string | null; analysisClaimedDeviceName: string | null; analysisCanRun: boolean; analysisNoCapablePc: boolean; analysisFailedAt: string | null; analysisError: string; teamQueue: boolean; projectHasRepo: boolean; analysisWaitReason: AnalysisWaitReason | null; changeHuman: string; changeAi: string; changeNotesStale?: boolean;
  infoFromId: number | null; infoTagId?: number | null; infoQuestion: string; infoById: number | null;
  createdAt: string; updatedAt: string; completedAt: string | null; labelIds: number[];
  parent: { number: number; title: string } | null;
  children: { number: number; title: string; statusId: number; assigneeId: number | null; priority: number; hasChangeNotes: boolean; changeNotesStale?: boolean }[];
  comments: { id: number; authorId: number | null; body: string; createdAt: string; updatedAt: string; replyToId: number | null }[];
  infoCommentId: number | null;
  activity: { id: number; actorId: number | null; viaAi: boolean; payload: ActivityPayload; createdAt: string }[];
  relations: { waitingOn: RelatedIssue[]; blocking: RelatedIssue[]; related: RelatedIssue[]; duplicateOf: RelatedIssue[]; duplicates: RelatedIssue[] };
  lastSeenAt: string | null;
  commits: { sha: string; message: string; url: string; author: string; committedAt: string; deployedAt: string | null; envs: { name: string; at: string; isProduction: boolean }[] }[];
};

export type IssuePatch = Partial<{
  title: string; description: string; statusId: number; assigneeId: number | null; priority: number; labelIds: number[];
  parentNumber: number | null; sprintId: number | null; sortOrder: number; analysis: string; changeHuman: string; changeAi: string;
  infoFromId: number | null; infoTagId: number | null; infoQuestion: string;
}>;

export function markDemoSession() { try { sessionStorage.setItem('demoSession', '1'); } catch { /* prywatne okno */ } }
function demoWasLoggedIn() { try { return sessionStorage.getItem('demoSession') === '1'; } catch { return false; } }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: { 'X-Project': getProjectKey(), 'X-Requested-With': 'exponential', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // Demo: baza resetuje się co godzinę i sesja gościa wygasa. Wracający gość dostaje nową; nowy widzi Landing.
    if (res.status === 401 && queryClient.getQueryData<AppConfig>(['config'])?.demo && demoWasLoggedIn()) {
      try {
        const last = Number(sessionStorage.getItem('demoRelogin') ?? 0);
        if (Date.now() - last > 10_000) { sessionStorage.setItem('demoRelogin', String(Date.now())); location.assign('/auth/demo'); }
      } catch { /* prywatne okno */ }
    }
    // Demo: zablokowane akcje i limity mają jeden, zrozumiały komunikat w każdym miejscu aplikacji.
    const msg = data.code === 'demo' ? t('Disabled in the demo') : data.code === 'rate' ? t('Too many requests, slow down') : (data.error ? t(data.error) : res.statusText); // komunikat serwera po polsku, jeśli jest w pl.ts
    if (data.code === 'demo' || data.code === 'rate') toast(msg, 'warn');
    throw new ApiError(msg, res.status, data.code);
  }
  return res.json();
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: false },
    mutations: { onError: (e) => toast((e as Error).message, 'err') },
  },
});

/** Dane niezależne od projektu przeżywają przełączenie; reszta znika, a widoki pobierają ją od nowa. */
const GLOBAL_KEYS = new Set(['config', 'me', 'projects', 'online', 'tokens', 'notify-settings', 'inbox']);
onProjectChange(() => {
  void queryClient.cancelQueries();
  queryClient.removeQueries({ predicate: (q) => !GLOBAL_KEYS.has(String(q.queryKey[0])) });
});

// Co minutę: licznik pytań z innych projektów (ich zdarzeń ta karta nie dostaje).
export const useProjects = (enabled = true) => useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectSummary[]>('/api/projects'), staleTime: 60_000, refetchInterval: 60_000, enabled });
export const useMeetings = (since?: Date) => useQuery({
  queryKey: since ? ['meetings', since.toISOString()] : ['meetings'],
  queryFn: () => api<Meeting[]>(since ? `/api/meetings?since=${encodeURIComponent(since.toISOString())}` : '/api/meetings'),
  refetchInterval: 5 * 60_000, placeholderData: (prev) => prev,
});
// Skrzynka "Do ciebie": wzmianki, tagi i pytania ze wszystkich moich projektów; zdarzenia SSE ('inbox') odświeżają ją na bieżąco.
export const useInbox = () => useQuery({ queryKey: ['inbox'], queryFn: () => api<InboxItem[]>('/api/inbox'), staleTime: 30_000, refetchInterval: 60_000 });
export const useNotifySettings = () => useQuery({ queryKey: ['notify-settings'], queryFn: () => api<NotifySettings>('/api/notify-settings'), staleTime: Infinity });

/** Ankieta czeka na mój głos: trwa i nie zagłosowałem na żaden termin. */
/** Spotkanie całego zespołu (attendeeIds = null) albo osoba jest na liście; organizator zawsze. */
export function isInvited(m: Pick<Meeting, 'attendeeIds' | 'createdBy'>, userId: number | undefined) {
  return !m.attendeeIds || (userId != null && (m.attendeeIds.includes(userId) || m.createdBy === userId));
}

/** Czeka na mój głos, gdy choć jeden termin nie ma mojej odpowiedzi (np. ktoś dodał nowy po moim głosowaniu). */
export function awaitsMyVote(m: Meeting, meId: number | undefined) {
  const now = Date.now();
  return m.status === 'polling' && !!meId && isInvited(m, meId) && m.slots.some((s) => new Date(s.startsAt).getTime() > now && !s.votes.some((v) => v.userId === meId));
}

/** Klucz odrzuconego przypomnienia o ankiecie: z liczbą terminów, więc nowy termin przywraca przypomnienie. */
export const pollAlertKey = (m: Meeting) => `p${m.id}:${m.slots.length}`;

/** Zgłaszanie błędów i pomysłów: czy admin wybrał projekt (admin dostaje też jego id). */
export const useFeedbackInfo = () => useQuery({ queryKey: ['feedback'], queryFn: () => api<{ configured: boolean; projectId?: number | null }>('/api/feedback'), staleTime: 60_000 });

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/api/config'), staleTime: Infinity, retry: false });
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/api/me'), retry: false, staleTime: Infinity });
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api<Meta>('/api/meta') });
export const useIssues = () => useQuery({ queryKey: ['issues'], queryFn: () => api<IssueRow[]>('/api/issues') });
export const useIssue = (number: number) =>
  useQuery({
    queryKey: ['issue', number], queryFn: () => api<IssueDetail>(`/api/issues/${ident(number)}`),
    // Zlecenie czeka na PC: to, czy jakiś komputer jest online, nie przychodzi zdarzeniem, więc co 30 s pytamy ponownie.
    refetchInterval: (q) => (q.state.data?.analysisRequestedAt && !q.state.data.analysisClaimedAt ? 30_000 : false),
  });
export const useSprints = () => useQuery({ queryKey: ['sprints'], queryFn: () => api<{ sprints: Sprint[]; lengthDays: number }>('/api/sprints') });

/** Optymistyczna zmiana zadania: board i szczegóły zmieniają się od razu, błąd cofa zmianę. */
export function useUpdateIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ number, patch }: { number: number; patch: IssuePatch }) =>
      api(`/api/issues/${ident(number)}`, { method: 'PATCH', body: patch }),
    onMutate: async ({ number, patch }) => {
      const prevList = qc.getQueryData<IssueRow[]>(['issues']);
      // Ostrzeżenie (nie blokada): start pracy nad zadaniem, które na coś czeka.
      // Na stronie zadania listy może nie być w cache: wtedy dane bierzemy ze szczegółów.
      const detail = qc.getQueryData<IssueDetail>(['issue', number]);
      const listRow = prevList?.find((i) => i.number === number);
      const meta = qc.getQueryData<Meta>(['meta']);
      const testingNames = (meta?.statuses ?? []).filter((s) => s.role === 'testing').map((s) => s.name);
      const row = listRow ?? (detail ? {
        statusId: detail.statusId, waitingOn: detail.relations.waitingOn.filter((r) => r.open).map((r) => r.number),
        hasChangeNotes: !!detail.changeHuman.trim() && !!detail.changeAi.trim(),
        wasTested: detail.activity.some((a) => a.payload.kind === 'status' && testingNames.includes(a.payload.to)),
      } : undefined);
      const to = patch.statusId != null ? meta?.statuses.find((s) => s.id === patch.statusId) : undefined;
      // Braki przy Done obsługuje okno DoneGuard (przed wywołaniem mutacji).
      if (row?.waitingOn.length && to?.type === 'started') {
        toast(t('{id} is still waiting on {ids}', { id: ident(number), ids: row.waitingOn.map((n) => ident(n)).join(', ') }), 'warn');
      }
      const prevDetail = qc.getQueryData<IssueDetail>(['issue', number]);
      const { parentNumber: _p, ...rowPatch } = patch;
      // Zmiana od razu, przed jakimkolwiek await: inaczej po upuszczeniu karta na klatkę wraca do starej kolumny.
      const apply = () => {
        qc.setQueryData<IssueRow[]>(['issues'], (old) => old?.map((i) => (i.number === number ? { ...i, ...rowPatch } : i)));
        qc.setQueryData<IssueDetail>(['issue', number], (old) => (old ? { ...old, ...rowPatch } : old));
      };
      apply();
      // Przerwane pobieranie listy może przywrócić stare dane, więc po nim zmianę nakładamy jeszcze raz.
      await qc.cancelQueries({ queryKey: ['issues'] });
      apply();
      return { prevList, prevDetail };
    },
    onError: (e, { number }, ctx) => {
      if (ctx?.prevList) qc.setQueryData(['issues'], ctx.prevList);
      if (ctx?.prevDetail) qc.setQueryData(['issue', number], ctx.prevDetail);
      toast((e as Error).message, 'err');
    },
    onSettled: (_d, _e, { number, patch }) => {
      void qc.invalidateQueries({ queryKey: ['issues'] });
      // Zmiana rodzica dotyka też szczegółów starego i nowego rodzica (listy podzadań): odświeżamy wszystkie.
      void qc.invalidateQueries({ queryKey: patch.parentNumber !== undefined ? ['issue'] : ['issue', number] });
    },
  });
}

export function useCreateIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssuePatch & { title: string }) => api<{ number: number; projectKey: string }>('/api/issues', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['issues'] }),
  });
}

/** SSE: serwer mówi, co się zmieniło, a my odświeżamy dokładnie te zapytania. */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource('/api/events');
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = new Set<string>();
    const flush = () => {
      for (const key of pending) {
        if (key === 'issues') void qc.invalidateQueries({ queryKey: ['issues'] });
        else if (key === 'meta') void qc.invalidateQueries({ queryKey: ['meta'] });
        else if (key === 'inbox') void qc.invalidateQueries({ queryKey: ['inbox'] });
        else if (key === 'deploy') void qc.invalidateQueries({ queryKey: ['deploy'] });
        else if (key === 'view') void qc.invalidateQueries({ queryKey: ['view'] });
        else if (key === 'online') void qc.invalidateQueries({ queryKey: ['online'] });
        else if (key === 'agents') { void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['project-agents'] }); }
        else if (key === 'meetings' || key === 'meeting_reminder') void qc.invalidateQueries({ queryKey: ['meetings'] });
        else if (key === 'projects') { void qc.invalidateQueries({ queryKey: ['projects'] }); void qc.invalidateQueries({ queryKey: ['project'] }); }
        else if (key === 'sprints') { void qc.invalidateQueries({ queryKey: ['sprints'] }); void qc.invalidateQueries({ queryKey: ['issues'] }); }
        else void qc.invalidateQueries({ queryKey: ['issue', Number(key)] });
      }
      pending.clear();
      timer = null;
    };
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as { type: string; projectKey?: string; number?: number; userId?: number };
      // Zdarzenia innych projektów nie dotyczą tego, co widać (dane i tak chroni API).
      if (e.projectKey && e.projectKey !== getProjectKey()) return;
      // Podgląd przeciągania idzie prosto do magazynu obecności, bez odświeżania danych.
      if (e.type === 'presence') { if (e.userId !== qc.getQueryData<Me>(['me'])?.id) receivePresence(e as never); return; }
      if (e.type === 'issue') { pending.add('issues'); if (e.number) pending.add(String(e.number)); }
      else pending.add(e.type);
      timer ??= setTimeout(flush, 120);
    };
    // Po zerwaniu połączenia (np. uśpiony laptop) odświeżamy wszystko, bo mogliśmy coś przegapić.
    let dropped = false;
    // Krótkie zerwania (np. restart serwera) są normalne; użytkownik dostaje znać dopiero po 10 s.
    let downTimer: ReturnType<typeof setTimeout> | null = null;
    let warned = false;
    es.onerror = () => {
      dropped = true;
      downTimer ??= setTimeout(() => { warned = true; toast(t('Live updates paused. Reconnecting…'), 'warn'); }, 10_000);
    };
    es.onopen = () => {
      if (downTimer) { clearTimeout(downTimer); downTimer = null; }
      if (warned) { warned = false; toast(t('Live updates are back.')); }
      if (dropped) { dropped = false; void qc.invalidateQueries(); }
    };
    return () => { es.close(); if (timer) clearTimeout(timer); if (downTimer) clearTimeout(downTimer); };
  }, [enabled, qc]);
}

/** Pytanie z Need Info czeka na mnie: zadane mi wprost, mojemu #tagowi (trzeba podać tagi z meta) albo "do każdego" przez kogoś innego. */
export function isAskedTo(i: { infoFromId: number | null; infoTagId?: number | null; infoQuestion: string; infoById: number | null }, meId: number | undefined, tags?: Tag[]) {
  if (!meId || !i.infoQuestion) return false;
  if (i.infoTagId) return i.infoById !== meId && !!tags?.find((x) => x.id === i.infoTagId)?.memberIds.includes(meId);
  return i.infoFromId === meId || (i.infoFromId == null && i.infoById !== meId);
}
