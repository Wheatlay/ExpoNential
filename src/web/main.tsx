import { StrictMode, Suspense, lazy, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { About } from './About.tsx';
import { Landing } from './Landing.tsx';
import { DemoBanner } from './DemoBanner.tsx';
import { ApiError, api, awaitsMyVote, markDemoSession, queryClient, useConfig, useMeetings, useIssue, useIssues, useLiveUpdates, useMe, useMeta, useProjects, useSprints } from './api.ts';
import { Board } from './Board.tsx';
import { IssuePage } from './IssuePage.tsx';
import { CommandMenu } from './CommandMenu.tsx';
import { MenuHost } from './menu.tsx';
import { PersonCardHost, PersonLink } from './PersonCard.tsx';
import { InboxBell } from './Inbox.tsx';
import { NewIssueHost, openNewIssue } from './NewIssue.tsx';
import { AskHost } from './AskModal.tsx';
import { LightboxHost } from './ImageBlock.tsx';
import { DoneGuardHost } from './DoneGuard.tsx';
import { ConfirmHost } from './Confirm.tsx';
import { useWizardActive } from './setupWizardState.ts';
import { DeployStatus, RecentIssues } from './SidebarExtras.tsx';
import { Avatar, Icon } from './icons.tsx';
import { linkProps, usePath } from './router.ts';
import { onToast, toast } from './toast.ts';
import { InlineCode } from './InlineCode.tsx';
import { ident, setProjectKey, useProjectKey } from './project.ts';
import { ProjectBadge, ProjectSwitcher, useCurrentProject } from './ProjectSwitcher.tsx';
import { NewProjectHost } from './NewProject.tsx';
import { MeetingHost } from './Meetings.tsx';
import { MeetingBanner, NotifyPrompt } from './Notifications.tsx';
import { t } from './i18n.ts';
import { Invite, Login, Reset } from './AuthScreens.tsx';
import { ErrorState, LoadingState } from './states.tsx';

// Ciężkie widoki ładują się dopiero przy wejściu (osobne paczki).
const Settings = lazy(() => import('./Settings.tsx').then((m) => ({ default: m.Settings })));
const SprintReview = lazy(() => import('./SprintReview.tsx').then((m) => ({ default: m.SprintReview })));
const Calendar = lazy(() => import('./Calendar.tsx').then((m) => ({ default: m.Calendar })));
const DemoTour = lazy(() => import('./DemoTour.tsx').then((m) => ({ default: m.DemoTour })));
const SetupWizardHost = lazy(() => import('./SetupWizard.tsx').then((m) => ({ default: m.SetupWizardHost })));

/** Kreator AI ładuje się dopiero, gdy okno albo podpowiedź jest otwarte. */
function SetupWizardGate() {
  return useWizardActive() ? <Suspense fallback={null}><SetupWizardHost /></Suspense> : null;
}

/** Tytuł karty przeglądarki: nazwa projektu przed nazwą aplikacji (kilka projektów w kartach = widać który). */
let baseTitle = 'Exponential';
/** Lokalny serwer deweloperski (vite dev): "LOCAL" na początku tytułu, żeby karta nie myliła się z produkcją. */
const LOCAL = import.meta.env.DEV ? 'LOCAL · ' : '';

function App() {
  const me = useMe();
  const path = usePath();
  const projectKey = useProjectKey();
  const projects = useProjects(!!me.data);
  const config = useConfig();
  const demoMode = !!config.data?.demo;
  useLiveUpdates(!!me.data);
  useEffect(() => { if (me.data?.demo) markDemoSession(); }, [me.data?.demo]);
  const projectName = projects.data?.find((p) => p.key === projectKey)?.name;
  useEffect(() => {
    baseTitle = projectName ? `${projectName} · Exponential` : 'Exponential';
    // Strona zgłoszenia ustawia własny tytuł (IssueCrumb), z nazwą projektu na końcu.
    if (!/^\/issue\//.test(location.pathname)) document.title = LOCAL + baseTitle;
  }, [projectName, path]);

  const issueMatch = /^\/issue\/([a-z]{2,6})-(\d+)/i.exec(path);
  // Projekt z linku: /issue/WEB-3 albo ?project=WEB (linki z powiadomień o spotkaniach).
  const urlKey = issueMatch?.[1].toUpperCase() ?? new URLSearchParams(location.search).get('project')?.toUpperCase();
  const mine = me.data ? projects.data : undefined;
  // Link do zadania innego projektu przełącza projekt; zapamiętany projekt, do którego już nie należymy, też.
  const wanted = urlKey && mine?.some((p) => p.key === urlKey) ? urlKey
    : mine?.length && !mine.some((p) => p.key === projectKey) ? mine[0].key : projectKey;
  useEffect(() => {
    if (wanted !== projectKey) setProjectKey(wanted);
    // ?project= działa raz (link z powiadomienia); zostawiony w adresie cofałby późniejsze przełączenia.
    const u = new URL(location.href);
    if (mine && u.searchParams.has('project')) { u.searchParams.delete('project'); history.replaceState(null, '', u.pathname + u.search); }
  }, [wanted, projectKey, mine]);

  if (me.isLoading || config.isLoading) return null;
  if (path === '/about') return <About loggedIn={!!me.data} />;
  const reset = /^\/reset\/([\w-]+)\/?$/.exec(path);
  if (reset) return <Reset token={reset[1]} />;
  const invite = /^\/invite\/([\w-]+)\/?$/.exec(path);
  if (invite) return <Invite token={invite[1]} loggedIn={!!me.data} />;
  // Login tylko po 401; inny błąd (sieć, 5xx) nie jest wylogowaniem, więc pokazujemy błąd z ponowieniem.
  if (me.isError && !(me.error instanceof ApiError && me.error.status === 401)) {
    return <div className="login"><div className="login-card"><ErrorState error={me.error} onRetry={() => void me.refetch()} /></div></div>;
  }
  if (!me.data && demoMode && path !== '/login') return <Landing />;
  // Lokalny serwer z DEV_LOGIN=1: od razu do środka (/login zostaje do zmiany konta).
  if (!me.data && config.data?.devLogin && path !== '/login') { location.replace('/auth/dev'); return null; }
  if (!me.data || path === '/login') return <Login />;
  if (projects.isLoading || wanted !== projectKey) return null;
  if (mine && !mine.length) return <NoProjects />;

  const page = issueMatch ? 'issue' : path.startsWith('/review') ? 'review' : path.startsWith('/settings') ? 'settings' : path.startsWith('/calendar') ? 'calendar' : 'board';

  const demo = !!me.data.demo;
  const shell = (children: React.ReactNode) => (demo ? <div className="demo-shell"><DemoBanner />{children}<Suspense fallback={null}><DemoTour /></Suspense></div> : children);
  return shell(
    // Zmiana projektu przemontowuje widoki (cache tego projektu i tak został wyczyszczony).
    <div className="app" key={projectKey}>
      <Sidebar page={page} />
      <main className="main">
        <Header page={page} number={issueMatch && urlKey === projectKey ? Number(issueMatch[2]) : undefined} />
        {page !== 'settings' && <MeetingBanner />}
        <Suspense fallback={<LoadingState />}>
        {page === 'board' && <Board />}
        {page === 'calendar' && <Calendar />}
        {/* Zadanie projektu, do którego nie należymy: nie pokazujemy w zamian zadania o tym numerze z bieżącego. */}
        {page === 'issue' && urlKey !== projectKey && <div className="issue-page"><div className="issue-content"><h2>{t('{id} not found', { id: `${urlKey}-${issueMatch![2]}` })}</h2><a className="btn" {...linkProps('/')}>{t('Back to board')}</a></div></div>}
        {page === 'issue' && urlKey === projectKey && <IssuePage key={issueMatch![2]} number={Number(issueMatch![2])} />}
        {page === 'review' && <SprintReview />}
        {page === 'settings' && <Settings />}
        </Suspense>
      </main>
      <MenuHost />
      <PersonCardHost />
      <NewIssueHost />
      <NewProjectHost />
      <MeetingHost />
      <NotifyPrompt />
      <LightboxHost />
      <DoneGuardHost />
      <SetupWizardGate />
      <ConfirmHost />
      <AskHost />
      <CommandMenu />
      <Toasts />
    </div>,
  );
}

let toggleSidebar = () => {};

function Sidebar({ page }: { page: string }) {
  const me = useMe().data!;
  const issues = useIssues().data ?? [];
  const sprints = useSprints().data?.sprints ?? [];
  const [open, setOpen] = useState(false);
  toggleSidebar = () => setOpen((o) => !o);
  const toReview = sprints.some((s) => s.status === 'ended');
  const votes = (useMeetings().data ?? []).filter((m) => awaitsMyVote(m, me.id)).length;
  const item = (to: string, key: string, icon: React.ReactNode, label: string, extra?: React.ReactNode) => (
    <a className={`nav-item ${page === key ? 'active' : ''}`} {...linkProps(to)} onClickCapture={() => setOpen(false)} title={label}>{icon}<span className="nav-label">{label}</span>{extra}</a>
  );
  return (
    <>
      {open && <div className="backdrop mobile-only sidebar-backdrop" onClick={() => setOpen(false)} />}
      <nav className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-top">
          <button className="icon-btn rail-only" onClick={() => toggleSidebar()} title={open ? t('Collapse menu') : t('Expand menu')} aria-label={t('Menu')}><Icon.menu size={16} /></button>
          <ProjectSwitcher />
          <button className="icon-btn round" title={t('New issue (C)')} aria-label={t('New issue (C)')} onClick={() => { setOpen(false); openNewIssue(); }}><Icon.edit size={14} /></button>
        </div>
        {item('/', 'board', <Icon.board size={15} />, t('Issues'), <span className="count">{issues.filter((i) => !i.completedAt).length || ''}</span>)}
        {item('/calendar', 'calendar', <Icon.calendar size={15} />, t('Calendar'), votes ? <span className="count orange" title={t('Polls waiting for your vote')}>{votes}</span> : null)}
        {item('/review', 'review', <Icon.sprint size={15} />, t('Sprint review'), toReview ? <span className="count" style={{ color: 'var(--warning-text)' }}>●</span> : null)}
        {/* Pytania do mnie: dzwonek (wszystkie projekty) i filtr "Asked to me" na tablicy, bez trzeciej pozycji tutaj. */}
        <RecentIssues onNavigate={() => setOpen(false)} />
        <div className="nav-section">{t('Project & account')}</div>
        {item('/settings', 'settings', <Icon.settings size={15} />, t('Settings'), !me.demo && me.aiStatus?.attention?.length ? <span className="nav-dot" role="img" aria-label={t('Needs attention')} title={t('Needs attention')} /> : undefined)}
        <div style={{ marginTop: 'auto' }}><DeployStatus /></div>
        <div className="sidebar-bottom" style={{ marginTop: 0 }}>
          {/* Ja jak każda osoba w aplikacji: klik otwiera moją kartę (tagi, nad czym pracuję, moje issues). */}
          <PersonLink userId={me.id} className="me-link">
            <Avatar user={useMeta().data?.users.find((u) => u.id === me.id) ?? { id: me.id, name: me.name, avatarUrl: null }} size={22} />
            <span className="me-name">{me.name}</span>
          </PersonLink>
          <button className="icon-btn" title={t('Log out')} aria-label={t('Log out')} onClick={() => void api('/auth/logout', { method: 'POST' }).then(() => location.assign('/login'))}><Icon.logout size={15} /></button>
        </div>
      </nav>
    </>
  );
}

function Header({ page, number }: { page: string; number?: number }) {
  const project = useCurrentProject();
  return (
    <div className="header">
      <button className="icon-btn mobile-only" onClick={() => toggleSidebar()} aria-label={t('Menu')}><Icon.menu size={16} /></button>
      <div className="crumb">
        <ProjectBadge project={project} size={18} />
        <a {...linkProps('/')}>{project?.name}</a>
        <span className="sep"><Icon.chevronRight size={12} /></span>
        {page === 'board' && <span>{t('Issues')}</span>}
        {page === 'review' && <span>{t('Sprint review')}</span>}
        {page === 'settings' && <span>{t('Settings')}</span>}
        {page === 'calendar' && <span>{t('Calendar')}</span>}
        {page === 'issue' && number && <IssueCrumb number={number} />}
      </div>
      <button className="header-search" title={t('Search (Ctrl+K)')} onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}>
        <Icon.search size={14} /><span className="grow">{t('Search issues…')}</span><kbd>Ctrl K</kbd>
      </button>
      <span className="header-end" />
      <InboxBell />
    </div>
  );
}

function IssueCrumb({ number }: { number: number }) {
  const issue = useIssue(number).data;
  useEffect(() => { document.title = LOCAL + (issue ? `${ident(number)} ${issue.title} · ${baseTitle}` : baseTitle); return () => { document.title = LOCAL + baseTitle; }; }, [issue, number]);
  return <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ident(number)} {issue && <span style={{ color: 'var(--text-secondary)' }}><InlineCode text={issue.title} /></span>}</span>;
}

/** Konto bez żadnego projektu: admin projektu musi dodać tę osobę w Settings › People albo wysłać link zaproszenia. */
function NoProjects() {
  const me = useMe().data;
  return (
    <div className="login">
      <div className="login-card">
        <h1>{t('No projects yet')}</h1>
        <div className="hint" style={{ maxWidth: 360, textAlign: 'center' }}>
          {t('You ({login}) are not a member of any project. Ask a project admin to add you in Settings › People or to send you an invite link.', { login: me?.login })}
        </div>
        <button className="btn" onClick={() => void api('/auth/logout', { method: 'POST' }).then(() => location.assign('/login'))}>{t('Log out')}</button>
      </div>
    </div>
  );
}

function Toasts() {
  const [t, setT] = useState<{ id: number; text: string; kind: 'ok' | 'err' | 'warn' } | null>(null);
  useEffect(() => onToast(setT), []);
  // Kontener live istnieje zawsze, bo czytnik ekranu ogłasza tylko zmiany w już obecnym regionie.
  return <div aria-live={t?.kind === 'err' ? 'assertive' : 'polite'} role={t?.kind === 'err' ? 'alert' : 'status'}>{t && <div className={`toast ${t.kind === 'ok' ? '' : t.kind}`}>{t.kind === 'ok' ? <Icon.check size={14} /> : null}{t.text}</div>}</div>;
}

// Wiele miejsc woła `void api(...)` bez .catch (zapis widoku tablicy, usuwanie, etykiety/statusy, głosy, Analyze z menu);
// to robi z ich porażek widoczny komunikat zamiast ciszy. 'demo' i 'rate' toastuje już sam api().
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r instanceof ApiError) {
    e.preventDefault();
    if (r.code !== 'demo' && r.code !== 'rate') toast(r.message ? t(r.message) : t('Something went wrong'), 'err');
  } else if (r instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(r.message)) {
    e.preventDefault();
    toast(t('No connection to Exponential. The change was not saved.'), 'err');
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
