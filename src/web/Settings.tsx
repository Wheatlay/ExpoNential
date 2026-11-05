import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TimeInput } from './DateTime.tsx';
import { askConfirm } from './Confirm.tsx';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useMe, useMeta, useProjects, useSprints, type Editor, type User } from './api.ts';
import { EDITOR_NAMES } from './startWork.ts';
import { useProjectKey } from './project.ts';
import { ProjectBadge } from './ProjectSwitcher.tsx';
import { NotificationSettings } from './Notifications.tsx';
import { ProjectTags } from './ProjectTags.tsx';
import { PersonLink } from './PersonCard.tsx';
import { Avatar, Icon, StatusIcon, startedFraction } from './icons.tsx';
import { copyText, toast } from './toast.ts';
import { fmtDate, timeAgo } from './time.ts';
import { Swatches, defaultSwatch } from './Swatches.tsx';
import { Tooltip, openMenu } from './menu.tsx';
import { openSetupWizard } from './setupWizardState.ts';
import { setTheme, type Theme } from './theme.ts';
import { useProjectDetail } from './projectDetail.ts';
import { lang, locale, setLang, t, type Lang } from './i18n.ts';
import { uploadImageFile } from './paste.ts';


/**
 * Ustawienia w trzech zakresach, żeby było jasne, co zmieniasz dla siebie, a co dla wszystkich:
 * Ty (wygląd, powiadomienia, Claude Code na tym komputerze), bieżący projekt, workspace (admin).
 * Widać jedną sekcję naraz; wybór w adresie (#sekcja), więc link "#project" dalej działa.
 */
type Section = { id: string; name: string; render: () => ReactNode; dot?: boolean; /** Powód, dla którego wpis w menu jest wyszarzony (nie ma tam nic do zmiany). */ locked?: string };

const PATH_ALIAS: Record<string, string> = { ai: 'claude' };

function useHash() {
  // /settings/ai otwiera sekcję AI (id 'claude'); hash ma pierwszeństwo.
  const fromPath = () => { const seg = location.pathname.split('/')[2] ?? ''; return PATH_ALIAS[seg] ?? seg; };
  const [hash, setHash] = useState(() => location.hash.slice(1) || fromPath());
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1) || fromPath());
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

export function Settings() {
  const me = useMe().data;
  const p = useProjectDetail().data;
  // Nie-admin projektu nic nie zmieni w ustawieniach projektu poza tagami (dołączanie, tworzenie): reszta wpisów wyszarzona z powodem.
  const lockedReason = p && !p.canEdit ? t('Only project admins can change this') : undefined;
  const groups: { name: ReactNode; items: Section[] }[] = [
    { name: t('You'), items: [
      { id: 'profile', name: t('Profile'), render: () => <ProfileSettings /> },
      { id: 'appearance', name: t('Appearance'), render: () => <Appearance /> },
      { id: 'notifications', name: t('Notifications'), render: () => <NotificationSettings /> },
      { id: 'claude', name: t('My AI'), render: () => <ClaudeConnect />, dot: !me?.demo && (me?.aiStatus?.attention?.length ?? 0) > 0 },
      { id: 'password', name: t('Password'), render: () => <PasswordSettings /> },
    ] },
    { name: p ? <span className="settings-nav-project"><ProjectBadge project={p} size={14} /> {p.name}</span> : t('Project'), items: [
      { id: 'project', name: t('General'), render: () => <ProjectGeneral />, locked: lockedReason },
      { id: 'people', name: t('People'), render: () => <ProjectPeople />, locked: lockedReason },
      { id: 'tags', name: t('Tags'), render: () => <ProjectTags /> },
      { id: 'labels', name: t('Labels and statuses'), render: () => <ProjectLabelsStatuses />, locked: lockedReason },
      { id: 'integrations', name: t('Integrations'), render: () => <ProjectIntegrations />, locked: lockedReason },
      { id: 'prompts', name: t('AI agent'), render: () => <ProjectPrompts />, locked: lockedReason },
    ] },
    ...(me?.isAdmin ? [{ name: t('Workspace'), items: [{ id: 'accounts', name: t('Accounts'), render: () => <Accounts /> }] }] : []),
  ];
  const all = groups.flatMap((g) => g.items);
  const hash = useHash();
  const current = all.find((s) => s.id === hash) ?? all[0];
  const [query, setQuery] = useState('');
  return (
    <div className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('Settings')}>
          <h2>{t('Settings')}</h2>
          <SettingsSearch groups={groups} isAdmin={!!me?.isAdmin} query={query} setQuery={setQuery} />
          {!query.trim() && groups.map((g, i) => (
            <div key={i}>
              <div className="nav-section">{g.name}</div>
              {g.items.map((s) => {
                const link = (
                  <a key={s.id} href={`#${s.id}`} className={`nav-item${s === current ? ' active' : ''}${s.locked ? ' locked' : ''}`} aria-disabled={s.locked ? 'true' : undefined}
                    onClick={(e) => { e.preventDefault(); if (s.locked) return; history.replaceState(null, '', `#${s.id}`); dispatchEvent(new HashChangeEvent('hashchange')); }}>
                    {s.name}
                    {s.dot && <span className="nav-dot" role="img" aria-label={t('Needs attention')} />}
                  </a>
                );
                return s.locked ? <div key={s.id}><Tooltip text={s.locked}>{link}</Tooltip></div> : link;
              })}
            </div>
          ))}
        </nav>
        <div className="settings-inner">
          <h3 className="settings-title">{current.name}</h3>
          {current.render()}
          {!query.trim() && <SettingsHints current={current.id} groups={groups} isAdmin={!!me?.isAdmin} />}
        </div>
      </div>
    </div>
  );
}

/**
 * "Szukasz może?" (jak w Androidzie): ustawienia dzielą się na moje i projektowe, więc łatwo szukać w złym miejscu.
 * Na dole sekcji linki do powiązanych ustawień gdzie indziej; klik przenosi i na chwilę podświetla kartę (target = id karty).
 */
type Hint = { label: string; to: string; target?: string; adminOnly?: boolean };
const HINTS: Record<string, Hint[]> = {
  claude: [
    { label: t('Team queue'), to: 'prompts', target: 'team-queue' },
    { label: t('Analysis models'), to: 'prompts', target: 'agent-prompts' },
  ],
  prompts: [
    { label: t('Connect this PC'), to: 'claude', target: 'claude-connect' },
    { label: t('Your PCs'), to: 'claude', target: 'your-computers' },
  ],
  profile: [{ label: t('Your notifications'), to: 'notifications' }],
  notifications: [
    { label: t('Project Discord channel'), to: 'integrations', target: 'discord' },
    { label: t('Tags'), to: 'tags', target: 'project-tags' },
  ],
  tags: [
    { label: t('People'), to: 'people' },
    { label: t('Your notifications'), to: 'notifications' },
  ],
  integrations: [{ label: t('Your notifications'), to: 'notifications' }],
  people: [
    { label: t('Tags'), to: 'tags' },
    { label: t('Who can log in to the workspace'), to: 'accounts', adminOnly: true },
  ],
};

type Groups = { name: ReactNode; items: Section[] }[];

// Ścieżka "Ty › Powiadomienia": grupa projektu ma w menu nazwę projektu, tu wystarczy "Projekt".
function whereIs(groups: Groups, id: string) {
  const gi = groups.findIndex((g) => g.items.some((s) => s.id === id));
  const sec = groups[gi]?.items.find((s) => s.id === id);
  const group = gi === 0 ? t('You') : gi === 1 ? t('Project') : t('Workspace');
  return sec ? `${group} › ${sec.name}` : null;
}

function goToSetting(h: Hint) {
  history.replaceState(null, '', `#${h.to}`);
  dispatchEvent(new HashChangeEvent('hashchange'));
  if (!h.target) return;
  // Po przełączeniu sekcji karta jest w DOM w następnej klatce.
  setTimeout(() => {
    // Wiersz bywa niewyrenderowany (np. Środowiska bez źródła deployów): wtedy podświetlamy pierwszą kartę sekcji.
    const el = document.getElementById(h.target!) ?? document.querySelector<HTMLElement>('.settings-inner .s-card');
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }, 50);
}

function SettingsHints({ current, groups, isAdmin }: { current: string; groups: Groups; isAdmin: boolean }) {
  const hints = HINTS[current];
  if (!hints?.length) return null;
  return (
    <div className="settings-hints">
      <div className="hint">{t('Looking for something else?')}</div>
      {hints.map((h) => {
        const path = whereIs(groups, h.to) ?? (h.adminOnly ? `${t('Workspace')} › ${t('Accounts')}` : '');
        const locked = h.adminOnly && !isAdmin;
        return (
          <Tooltip key={h.label} text={locked ? t('Only workspace admins can open this') : null}>
            <button className="settings-hint" disabled={locked} onClick={() => goToSetting(h)}>
              <span>→ {h.label}</span><span className="hint">{path}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// Nowe ustawienie = nowy wpis w SEARCH (tests/settings-search.test.ts to sprawdza).
/**
 * Wyszukiwarka ustawień (nad menu): lista wszystkich kart i wierszy z sekcjami. Wynik przenosi do sekcji i podświetla cel
 * tak jak "Szukasz może?". Nowe ustawienie = nowy wpis tutaj (cel to id karty/wiersza w kodzie).
 */
type SearchEntry = Hint & { keywords?: string[] };
const SEARCH: SearchEntry[] = [
  // Ty › Profil
  { label: t('Photo'), to: 'profile', target: 'profile-photo', keywords: ['avatar', 'zdjecie', 'logo', 'picture', 'image', 'obrazek', 'github', 'google'] },
  { label: t('Your name'), to: 'profile', target: 'profile-name', keywords: ['imie', 'nazwisko', 'name', 'profil', 'profile', 'rename'] },
  { label: t('Delete account'), to: 'profile', target: 'profile-danger', keywords: ['usun', 'konto', 'delete', 'account', 'remove', 'anonymize'] },
  // Ty › Wygląd
  { label: t('Theme'), to: 'appearance', target: 'theme', keywords: ['dark', 'light', 'oled', 'motyw', 'ciemny', 'jasny', 'wyglad', 'appearance'] },
  { label: t('Language'), to: 'appearance', target: 'language', keywords: ['polski', 'english', 'jezyk', 'pl', 'en'] },
  // Ty › Powiadomienia
  { label: t('In Exponential'), to: 'notifications', target: 'notif-app', keywords: ['bell', 'banner', 'dzwonek', 'powiadomienia', 'notifications', 'inbox', 'skrzynka'] },
  { label: t('Browser notifications'), to: 'notifications', target: 'notif-push', keywords: ['push', 'powiadomienia', 'notifications', 'przegladarka'] },
  { label: 'Discord', to: 'notifications', target: 'notif-discord', keywords: ['channel', 'kanal', 'powiadomienia', 'notifications'] },
  { label: t('Only mentions and questions to me'), to: 'notifications', target: 'notif-important', keywords: ['mute', 'quiet', 'wycisz', 'wzmianki', 'mentions', 'pytania', 'questions', 'powiadomienia'] },
  { label: t('Keep the analysis toast until it is done'), to: 'notifications', target: 'notif-analysis', keywords: ['toast', 'analiza', 'analysis', 'sticky', 'powiadomienia'] },
  // Ty › AI
  { label: t('Editor'), to: 'claude', target: 'editor', keywords: ['vscode', 'vs code', 'cursor', 'windsurf', 'terminal', 'edytor', 'start work'] },
  { label: t('Connect AI'), to: 'claude', target: 'claude-connect', keywords: ['claude code', 'claude', 'codex', 'mcp', 'wizard', 'ai', 'polacz'] },
  { label: t('Your PCs'), to: 'claude', target: 'your-computers', keywords: ['agent', 'pc', 'komputer', 'computer', 'runner'] },
  { label: t('API keys'), to: 'claude', target: 'tokens', keywords: ['api', 'key', 'klucz', 'token', 'tokens'] },
  // Ty › Hasło
  { label: t('Password'), to: 'password', target: 'password-card', keywords: ['login', 'haslo', 'e-mail', 'email', 'konto', 'account'] },
  // Projekt › Ogólne
  { label: t('Name'), to: 'project', target: 'project-name', keywords: ['project', 'projekt', 'nazwa', 'rename'] },
  { label: t('Project color'), to: 'project', target: 'project-name', keywords: ['kolor', 'color', 'project', 'projekt'] },
  { label: t('Logo'), to: 'project', target: 'project-name', keywords: ['logo projektu', 'project logo', 'ikona', 'icon', 'obrazek', 'image', 'badge', 'plakietka'] },
  { label: t('Sprint length'), to: 'project', target: 'sprint-length', keywords: ['days', 'dni', 'sprint', 'dlugosc', 'length'] },
  { label: t('Sprint review'), to: 'project', target: 'sprint-review', keywords: ['meeting', 'spotkanie', 'przeglad', 'review', 'kalendarz', 'calendar'] },
  { label: t('Sprint review time'), to: 'project', target: 'sprint-review', keywords: ['godzina', 'hour', 'time', 'meeting', 'spotkanie', 'minuty', 'minutes'] },
  // Projekt › Ludzie
  { label: t('GitHub login or e-mail to add'), to: 'people', target: 'add-member', keywords: ['member', 'members', 'invite', 'czlonek', 'czlonkowie', 'dodaj', 'add', 'ludzie', 'people', 'remove', 'usun'] },
  { label: t('Role'), to: 'people', target: 'add-member', keywords: ['admin', 'member', 'rola', 'czlonek', 'uprawnienia', 'permissions'] },
  { label: t('Invite link'), to: 'people', target: 'invites', keywords: ['zaproszenie', 'invite', 'link', 'join', 'dolacz'] },
  // Projekt › Tagi
  { label: t('Tags'), to: 'tags', target: 'project-tags', keywords: ['tag', '#', 'team', 'group', 'zespol', 'grupa', 'mention', 'wzmianka', 'join', 'dolacz', 'leave', 'opusc'] },
  { label: t('New tag'), to: 'tags', target: 'project-tags', keywords: ['create', 'utworz', 'tag', 'nowy', 'color', 'kolor'] },
  // Projekt › Etykiety i statusy
  { label: t('Labels'), to: 'labels', target: 'labels', keywords: ['etykiety', 'label', 'labels', 'kolor', 'color'] },
  { label: t('Statuses'), to: 'labels', target: 'statuses', keywords: ['columns', 'kolumny', 'status', 'board', 'tablica', 'workflow'] },
  // Projekt › Integracje
  { label: t('GitHub repo'), to: 'integrations', target: 'github-repo', keywords: ['commit', 'repo', 'github', 'repozytorium'] },
  { label: t('Deploys'), to: 'integrations', target: 'deploys', keywords: ['wdrozenia', 'deploy', 'source', 'zrodlo', 'webhook', 'coolify', 'github deployments', 'prod', 'stage', 'production', 'produkcja', 'staging', 'qa', 'srodowisko', 'środowisko', 'ci'] },
  { label: 'Discord webhook', to: 'integrations', target: 'discord', keywords: ['channel', 'kanal', 'webhook', 'powiadomienia', 'notifications'] },
  { label: t('Meeting place'), to: 'integrations', target: 'meeting-place', keywords: ['teams', 'meet', 'link', 'spotkanie', 'meeting', 'miejsce'] },
  // Projekt › Agent AI
  { label: t('Analyze'), to: 'prompts', target: 'agent-analyze', keywords: ['model', 'claude', 'sonnet', 'opus', 'haiku', 'analiza', 'analysis', 'prompt'] },
  { label: t('Deep'), to: 'prompts', target: 'agent-deep', keywords: ['model', 'claude', 'sonnet', 'opus', 'haiku', 'analiza', 'analysis', 'prompt', 'gleboka'] },
  { label: t('Analysis models'), to: 'prompts', target: 'agent-prompts', keywords: ['prompt', 'model', 'claude', 'agent', 'ai'] },
  { label: t('Team queue'), to: 'prompts', target: 'team-queue', keywords: ['analysis', 'analiza', 'kolejka', 'queue', 'zespol', 'team', 'agent'] },
  // Workspace › Konta
  { label: t('Who can log in to the workspace'), to: 'accounts', target: 'accounts-card', adminOnly: true, keywords: ['accounts', 'konta', 'admin', 'login', 'github', 'google', 'allow', 'zezwol'] },
];

// Bez wielkości liter i polskich znaków, znak po znaku (długość się nie zmienia, więc indeksy pasują do oryginału).
const fold = (s: string) => Array.from(s).map((c) => c.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/gi, 'l').toLowerCase()).join('');

function Highlight({ text, tokens }: { text: string; tokens: string[] }) {
  const f = fold(text);
  const marks: [number, number][] = [];
  for (const tk of tokens) { const i = f.indexOf(tk); if (i >= 0) marks.push([i, i + tk.length]); }
  marks.sort((x, y) => x[0] - y[0]);
  const out: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from < at) continue;
    out.push(text.slice(at, from), <mark key={from}>{text.slice(from, to)}</mark>);
    at = to;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

function SettingsSearch({ groups, isAdmin, query, setQuery }: { groups: Groups; isAdmin: boolean; query: string; setQuery: (q: string) => void }) {
  const [sel, setSel] = useState(0);
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  const results = tokens.length
    ? SEARCH.filter((e) => (!e.adminOnly || isAdmin) && whereIs(groups, e.to) != null).filter((e) => {
      const hay = fold(`${e.label} ${whereIs(groups, e.to)} ${(e.keywords ?? []).join(' ')}`);
      return tokens.every((tk) => hay.includes(tk));
    })
    : [];
  const pick = (e: SearchEntry) => { goToSetting(e); setQuery(''); setSel(0); };
  const cur = Math.min(sel, Math.max(0, results.length - 1));
  return (
    <div className="settings-search">
      <input className="input" type="search" placeholder={t('Search settings')} aria-label={t('Search settings')} value={query}
        onChange={(e) => { setQuery(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(results.length - 1, cur + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, cur - 1)); }
          else if (e.key === 'Enter' && results[cur]) { e.preventDefault(); pick(results[cur]); }
        }} />
      {tokens.length > 0 && (
        <div className="settings-results" role="listbox">
          {results.map((e, i) => (
            <button key={e.label + e.to} role="option" aria-selected={i === cur} className={`nav-item search-result${i === cur ? ' active' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={() => pick(e)}>
              <span><Highlight text={e.label} tokens={tokens} /></span>
              <span className="hint">{whereIs(groups, e.to)}</span>
            </button>
          ))}
          {!results.length && <div className="hint search-none">{t('Nothing matches. Try another word.')}</div>}
        </div>
      )}
    </div>
  );
}

/** Profil: zdjęcie i nazwa (widoczne dla wszystkich w projektach) oraz usunięcie konta. */
function ProfileSettings() {
  const me = useMe().data;
  const qc = useQueryClient();
  const pickFile = useRef<HTMLInputElement>(null);
  const [rev, setRev] = useState(0);
  if (!me) return null;
  const demo = !!me.demo;
  const reason = demo ? t('Disabled in the demo') : null;
  const refresh = () => { for (const k of ['me', 'meta', 'projects']) void qc.invalidateQueries({ queryKey: [k] }); };
  const save = (body: { name?: string; avatar?: string | null }) => api('/api/me', { method: 'PUT', body }).then(() => { toast(t('Saved')); refresh(); });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const url = await uploadImageFile(file, 2 * 1024 * 1024);
    if (url) await save({ avatar: url });
  };
  const providerName = me.provider === 'github' ? 'GitHub' : me.provider === 'google' ? 'Google' : null;
  const rename = (v: string) => {
    const name = v.trim();
    // Pusta albo bez zmian: pole wraca do zapisanej nazwy.
    if (!name || name === me.name) { setRev((r) => r + 1); return; }
    save({ name }).catch(() => setRev((r) => r + 1));
  };
  const signOutAll = () => void askConfirm({ title: t('Sign out everywhere?'), body: t('You will be signed out on every device and have to sign in again.'), action: t('Sign out'), danger: false })
    .then((ok) => { if (ok) return api('/auth/logout-all', { method: 'POST' }).then(() => location.assign('/login')); });
  const remove = () => void askConfirm({ title: t('Delete your account?'), action: t('Delete account'), type: me.login })
    .then((ok) => { if (ok) return api('/api/me', { method: 'DELETE', body: { confirm: me.login } }).then(() => location.assign('/login')); });
  return (
    <>
      <div className="s-card">
        <div id="profile-photo" className="s-row">
          <span className="s-label">{t('Photo')}</span>
          <Tooltip text={reason}>
            <button className="avatar-slot" aria-label={t('Change')} disabled={demo} onClick={() => pickFile.current?.click()}><Avatar user={me} size={40} /></button>
          </Tooltip>
          <input ref={pickFile} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }} />
          <span className="spacer" />
          <Tooltip text={reason}>
            <button className="btn sm" disabled={demo} onClick={() => pickFile.current?.click()}>{t('Change')}</button>
          </Tooltip>
          {me.avatarCustom && (
            <button className="btn sm" onClick={() => void save({ avatar: null })}>{providerName ? t('Use {provider} photo', { provider: providerName }) : t('Remove photo')}</button>
          )}
        </div>
        <div id="profile-name" className="s-row">
          <span className="s-label">{t('Your name')}</span>
          <Tooltip text={reason}><input className="input grow" key={`${me.name}-${rev}`} defaultValue={me.name} maxLength={60} aria-label={t('Your name')} disabled={demo}
            onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></Tooltip>
        </div>
      </div>
      <div id="profile-danger" className="s-card">
        <div className="s-row">
          <Tooltip text={t('Ends your sessions on every device.')}><span className="grow">{t('Sign out everywhere')}</span></Tooltip>
          <Tooltip text={reason}>
            <button className="btn sm" disabled={demo} onClick={signOutAll}>{t('Sign out everywhere')}</button>
          </Tooltip>
        </div>
        <div className="s-row">
          <Tooltip text={t('Your issues and comments stay, signed as "Deleted user". You lose access to every project.')}><span className="grow">{t('Delete account')}</span></Tooltip>
          <Tooltip text={reason}>
            <button className="btn sm danger" disabled={demo} onClick={remove}>{t('Delete account…')}</button>
          </Tooltip>
        </div>
      </div>
    </>
  );
}

function Appearance() {
  const [theme, setT] = useState<Theme>((document.documentElement.dataset.theme as Theme) ?? 'oled');
  return (
    <div className="s-card">
      <div id="theme" className="s-row">
        <span className="grow">{t('Theme')}</span>
        <div className="seg">
          {(['dark', 'oled', 'light'] as Theme[]).map((th) => (
            <button key={th} className={theme === th ? 'on' : ''} onClick={() => { setTheme(th); setT(th); }}>
              {{ dark: t('Dark'), oled: t('OLED black'), light: t('Light') }[th]}
            </button>
          ))}
        </div>
      </div>
      <div id="language" className="s-row">
        <span className="grow">{t('Language')}</span>
        <select className="input" value={lang} aria-label={t('Language')} onChange={(e) => {
          const v = e.target.value;
          if (v === '__help') { window.open('https://github.com/Wheatlay/ExpoNential/blob/main/docs/translating.md', '_blank', 'noopener'); e.target.value = lang; return; }
          if (v !== lang) void setLang(v as Lang);
        }}>
          <option value="en">English</option>
          <option value="pl">Polski</option>
          <option value="__help">{t('Help translate…')}</option>
        </select>
      </div>
    </div>
  );
}

/**
 * Podłączenie Claude Code na tym komputerze jednym poleceniem: przycisk tworzy token i daje polecenie, które
 * dodaje serwer MCP każdemu kontu Claude Code, instaluje plugin (skille, ślad pracy) i analizę w tle.
 * Po instalacji to samo polecenie bez tokenu tylko aktualizuje. Tokeny niżej, żeby dało się je unieważnić.
 */
type UsageInfo = { runs: number; forOthers: number; costUsd: number; tokens: number; byRequester: { name: string; runs: number; costUsd: number; tokens: number }[] };
/** Tokeny w zapisie skróconym języka użytkownika (np. "1,2 mln", po polsku "tys."/"mln"). */
const tok = (n: number) => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const byRequesterText = (u: UsageInfo) => u.byRequester.map((b) => `${b.name} ${b.runs} · ${t('{n} tokens', { n: tok(b.tokens) })}`).join(' · ') || null;
const LIMITS = [1e5, 5e5, 1e6, 5e6];

function ClaudeConnect() {
  const qc = useQueryClient();
  const me = useMe().data;
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<{ id: number; name: string; createdAt: string; lastUsedAt: string | null }[]>('/api/tokens'), enabled: !!me && !me.demo });
  const agentList = useQuery({ queryKey: ['agents'], queryFn: () => api<{ id: string; name: string; version?: string | null; computerName: string; label: string; lastSeenAt: string | null; busy: boolean; online: boolean; outdated: boolean; legacy: boolean; inactive?: boolean; lastError: string; lastErrorAt: string | null; maxOthersTokensPerDay: number | null; limitReached24h: boolean; forOthers24h: number; forOthersTokens24h: number; claudeLimit: string; usage30d: UsageInfo; teamMode: TeamMode; setup?: { claude: { name: string; mcp: boolean; plugin: boolean }[]; codex: boolean; cursor: boolean } | null; repos?: { project: string; status: string }[] }[]>('/api/agents'), enabled: !!me && !me.demo });
  const projects = useProjects(!!me && !me.demo).data;
  const projectOf = (k: string) => projects?.find((p) => p.key === k);
  const refreshTeam = () => { void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['project-agents'] }); };
  const grants = useQuery({ queryKey: ['connections'], queryFn: () => api<{ id: number; client: string; agent?: boolean; computerName?: string | null; createdAt: string; lastUsedAt: string | null; firstMcpAt: string | null }[]>('/api/connections'), enabled: !!me && !me.demo });
  // Instalacja dzieje się w terminalu: po powrocie do karty odświeżamy status bez przeładowania.
  useEffect(() => {
    const f = () => { void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['tokens'] }); void qc.invalidateQueries({ queryKey: ['agents'] }); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [qc]);
  const demo = !!me?.demo;
  const anyClient = (grants.data?.length ?? 0) + (tokens.data?.length ?? 0) > 0;
  return (
    <>
      <div className="s-card" id="editor">
        <div className="s-row">
          <span className="grow">{t('Editor')}</span>
          <select className="input" value={me?.editor ?? 'vscode'} aria-label={t('Editor')}
            onChange={(e) => void api('/api/me', { method: 'PUT', body: { editor: e.target.value as Editor } }).then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['me'] }); })}>
            {(Object.keys(EDITOR_NAMES) as Editor[]).map((k) => <option key={k} value={k}>{EDITOR_NAMES[k]}</option>)}
          </select>
        </div>
      </div>
      <div className="s-card" id="claude-connect">
        <div className="s-row s-row-head">
          <b className="grow">{t('AI clients')}</b>
          {anyClient && <button className="btn" onClick={() => openSetupWizard()}>{t('Connect another')}</button>}
        </div>
        {!anyClient && (
          <div className="s-row"><span className="hint grow">{t('No AI client connected')}</span><button className="btn primary" onClick={() => openSetupWizard()}>{t('Connect AI')}</button></div>
        )}
        {(grants.data ?? []).map((g) => (
          <div key={g.id} className="s-row">
            <span className="grow">{g.client}</span>
            <span className="hint">{g.lastUsedAt ? t('since {date}, last used {when}', { date: fmtDate(g.createdAt), when: timeAgo(g.lastUsedAt) }) : t('since {date}, never used', { date: fmtDate(g.createdAt) })}</span>
            <button className="btn sm danger" onClick={() => void askConfirm({
              title: t('Revoke "{name}"?', { name: g.client }), body: t('This client loses access to Exponential until you sign in with it again.'), action: t('Revoke'), danger: true,
            }).then((ok) => { if (ok) void api(`/api/connections/${g.id}`, { method: 'DELETE' }).then(() => { void qc.invalidateQueries({ queryKey: ['connections'] }); void qc.invalidateQueries({ queryKey: ['me'] }); }); })}>{t('Revoke')}</button>
          </div>
        ))}
        {(tokens.data ?? []).map((tk) => (
          <div key={`k${tk.id}`} className="s-row" id={tk === tokens.data![0] ? 'tokens' : undefined}>
            <span className="grow">{tk.name} <Tooltip text={t('Connected with an API key')}><span className="pill">{t('API key')}</span></Tooltip></span>
            <span className="hint">{t('created {when}', { when: timeAgo(tk.createdAt) })} · {tk.lastUsedAt ? t('used {when}', { when: timeAgo(tk.lastUsedAt) }) : t('never used')}</span>
            <Tooltip text={demo ? t('Disabled in the demo') : null}><button className="btn sm danger" disabled={demo} onClick={() => void askConfirm({ title: t('Revoke "{name}"?', { name: tk.name }), body: t('Claude Code using this token stops working.'), action: t('Revoke'), danger: true }).then((ok) => { if (ok) void api(`/api/tokens/${tk.id}`, { method: 'DELETE' }).then(() => { void qc.invalidateQueries({ queryKey: ['tokens'] }); void qc.invalidateQueries({ queryKey: ['me'] }); }); })}>{t('Revoke')}</button></Tooltip>
          </div>
        ))}
      </div>
      {!demo && (
        <div className="s-card" id="your-computers">
          <div className="s-row s-row-head"><b>{t('Your PCs')}</b></div>
          {(agentList.data?.length ?? 0) === 0 && (
            <div className="s-row">
              <span className="hint grow">{t('No PC with the agent')}</span>
              <button type="button" className="wiz-link" onClick={() => openSetupWizard(3)}>{t('Connect this PC')}</button>
            </div>
          )}
          {(agentList.data ?? []).map((a) => {
            const teamOff = a.outdated ? t('Update the agent first') : null;
            return (
            <div key={a.id} className="my-pc">
              <div className="my-pc-line">
                {/* Własna nazwa (jak login GitHub w Kontach): zapis po wyjściu z pola, pusta wraca do nazwy z Windowsa. */}
                <input className="input s-input-name" key={a.label} defaultValue={a.label} placeholder={a.computerName || t('Unnamed PC')} aria-label={t('PC name')}
                  title={t('Your name for this PC. Empty: the Windows name.')}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v !== a.label) void api(`/api/agents/${a.id}`, { method: 'PATCH', body: { label: v } }).then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['agents'] }); }); }} />
                <span className="my-pc-pills">
                  <span className={`pill${a.online ? ' ok' : ''}`}>{a.online ? t('Online') : t('Offline')}</span>
                  {a.outdated && !a.legacy && <span className="pill stalled">{t('Update needed')}</span>}
                  {a.legacy && <button className="btn sm" onClick={() => openSetupWizard(3)}>{t('Switch to the new agent')}</button>}
                  {a.limitReached24h && <span className="pill stalled">{t('Limit reached')}</span>}
                  {a.setup && a.setup.claude.some((c) => !c.mcp || !c.plugin) && (
                    <Tooltip text={[t('Run the agent installer again to fix it.'), ...a.setup.claude.filter((c) => !c.mcp || !c.plugin).map((c) => `${c.name}: ${[!c.mcp && t('no expo'), !c.plugin && t('no work trace')].filter(Boolean).join(', ')}`)].join(' · ')}>
                      <span className="pill stalled" tabIndex={0}>{t('Claude Code: incomplete setup')}</span>
                    </Tooltip>
                  )}
                  {a.claudeLimit && <Tooltip text={t('Analyses will return automatically after the limit renews.')}><span className="pill">{a.claudeLimit}</span></Tooltip>}
                  {a.inactive && <Tooltip text={t('Not seen for over 3 days. Hidden after 14 days.')}><span className="pill">{t('Inactive')}</span></Tooltip>}
                  {a.lastError && <Tooltip text={t('Last error {when}: {error}', { when: a.lastErrorAt ? timeAgo(a.lastErrorAt) : '', error: a.lastError.slice(0, 300) })}><span className="pill stalled">{t('Error')}</span></Tooltip>}
                  {(a.limitReached24h || a.lastError || a.legacy || (a.maxOthersTokensPerDay == null && a.forOthersTokens24h >= 2_000_000)) && <span className="nav-dot" role="img" aria-label={t('Needs attention')} />}
                </span>
              </div>
              <div className="my-pc-line">
                <span className="grow my-pc-meta">
                  <span className="hint">{a.online && a.busy ? t('running an analysis') : a.lastSeenAt ? t('last seen {when}', { when: timeAgo(a.lastSeenAt) }) : t('never seen')}{a.version ? ` · ${t('version {v}', { v: a.version })}` : ''}</span>
                  {a.label && a.computerName && <span className="hint">{t('Windows name: {name}', { name: a.computerName })}</span>}
                  {a.usage30d.runs > 0 && (
                    <Tooltip text={byRequesterText(a.usage30d)}>
                      <span className="hint">{t('30 days: {runs} analyses · {tokens}', { runs: a.usage30d.runs, tokens: t('{n} tokens', { n: tok(a.usage30d.tokens) }) })}</span>
                    </Tooltip>
                  )}
                </span>
                <button className="btn sm danger" onClick={() => void askConfirm({
                  title: t('Remove "{name}"?', { name: a.name || t('Unnamed PC') }), body: t('This PC stops taking requests until the agent is installed on it again.'), action: t('Remove'), danger: true,
                }).then((ok) => { if (ok) void api(`/api/agents/${a.id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['agents'] })); })}>{t('Remove')}</button>
              </div>
              <div className="my-pc-line">
                <Tooltip text={teamOff ?? t('Requests from other people in projects with a team queue.')}><span className="hint" tabIndex={teamOff ? 0 : undefined}>{t('Team requests')}</span></Tooltip>
                <Tooltip text={teamOff}>
                  <div className="seg" role="group" aria-label={t('Team requests')}>
                    {TEAM_MODES.map((m) => {
                      const localOnly = m === 'auto' && a.teamMode !== 'auto';
                      const btn = (
                        <button key={m} className={a.teamMode === m ? 'on' : ''} aria-pressed={a.teamMode === m} disabled={!!teamOff || localOnly}
                          onClick={() => { if (a.teamMode !== m) void api(`/api/agents/${a.id}`, { method: 'PATCH', body: { teamMode: m } }).then(refreshTeam); }}>{TEAM_MODE_LABEL[m]()}</button>
                      );
                      return localOnly && !teamOff ? <Tooltip key={m} text={t('For safety, turn this on in the agent window on this PC.')}>{btn}</Tooltip> : btn;
                    })}
                  </div>
                </Tooltip>
                <Tooltip text={teamOff ?? t('Runs for other people on this PC in 24 hours. Your own are never limited.')}>
                  <select className="input" value={a.maxOthersTokensPerDay ?? ''} aria-label={t('Limit for others per day')} disabled={!!teamOff}
                    onChange={(e) => void api(`/api/agents/${a.id}`, { method: 'PATCH', body: { maxOthersTokensPerDay: e.target.value === '' ? null : Number(e.target.value) } }).then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['agents'] }); void qc.invalidateQueries({ queryKey: ['me'] }); })}>
                    <option value="">{t('No limit for others')}</option>
                    {[...new Set([...LIMITS, ...(a.maxOthersTokensPerDay != null ? [a.maxOthersTokensPerDay] : [])])].sort((x, y) => x - y).map((n) => <option key={n} value={n}>{t('{n} / day', { n: tok(n) })}</option>)}
                  </select>
                </Tooltip>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export type ProjectDetail = {
  id: number; key: string; name: string; color: string; logoUrl: string; discordWebhookUrl: string | null; discordLastError: string; discordLastErrorAt: string | null; meetingLocationUrl: string;
  sprintLengthDays: number; reviewMeeting: boolean; reviewTime: string; reviewMinutes: number;
  promptStart: string; promptAnalyze: string; promptClose: string; promptDeep: string; analyzeModel: string; deepModel: string;
  githubRepo: string; deploySource: '' | 'webhook' | 'github' | 'coolify'; agentTeamQueue: boolean;
  defaultModels: { analyze: string; deep: string };
  role: 'admin' | 'member'; canEdit: boolean;
  members: { id: number; login: string; name: string; avatarUrl: string | null; active: boolean; role: 'admin' | 'member' }[];
};

/** Wspólne dla sekcji projektu: dane, "tylko do odczytu" dla nie-adminów i zapis. */
function useProject() {
  const p = useProjectDetail().data;
  const meta = useMeta().data;
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['meta'] });
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  if (!p || !meta) return null;
  const ro = p.canEdit ? null : t('Only project admins can change this');
  const patch = (body: object, msg = t('Saved')) => api(`/api/projects/${p.key}`, { method: 'PATCH', body }).then(() => { toast(msg); refresh(); });
  return { p, meta, ro, patch, refresh, qc };
}

/** Plakietka projektu w wierszu Nazwa: klik wgrywa logo; z logo pojawia się ×, bez logo obok jest wybór koloru. */
function ProjectLogo({ p, ro, patch }: { p: ProjectDetail; ro: string | null; patch: (body: object, msg?: string) => Promise<void> }) {
  const pickFile = useRef<HTMLInputElement>(null);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const url = await uploadImageFile(file, 2 * 1024 * 1024);
    if (url) await patch({ logoUrl: url });
  };
  return (
    <>
      <Tooltip text={ro ?? t('Click to upload a logo. Without a logo the badge uses the colour.')}>
        <button className="avatar-slot" aria-label={t('Logo')} disabled={!!ro} onClick={() => pickFile.current?.click()}><ProjectBadge project={p} size={30} /></button>
      </Tooltip>
      <input ref={pickFile} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void upload(f); }} />
      {p.logoUrl && (
        <Tooltip text={ro ?? t('Remove logo')}>
          <button className="icon-btn" aria-label={t('Remove logo')} disabled={!!ro} onClick={() => void patch({ logoUrl: '' })}><Icon.close size={12} /></button>
        </Tooltip>
      )}
    </>
  );
}

function ProjectGeneral() {
  const c = useProject();
  const sprintData = useSprints().data;
  const [days, setDays] = useState<number | null>(null);
  const demo = !!useMe().data?.demo;
  if (!c) return null;
  const { p, ro, patch, qc } = c;
  const off = p.reviewMeeting ? null : t('Turn on the sprint review meeting first');
  return (
    <div className="s-card">
      <div id="project-name" className="s-row">
        <span className="s-label">{t('Name')}</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.name} defaultValue={p.name} disabled={!!ro}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.name && void patch({ name: e.target.value.trim() })} />
        </Tooltip>
        <ProjectLogo p={p} ro={ro ?? (demo ? t('Disabled in the demo') : null)} patch={patch} />
        {!p.logoUrl && <Tooltip text={ro}>
          <Swatches value={p.color} disabled={!!ro} label={t('Project color')} onChange={(c) => void patch({ color: c })} />
        </Tooltip>}
      </div>
      <div id="sprint-length" className="s-row">
        <span className="s-label">{t('Sprint length')}</span>
        {/* Zapis po wyjściu z pola, jak pozostałe pola Ustawień. */}
        <Tooltip text={ro}>
          <input className="input s-input-num" type="number" min={1} max={90} disabled={!!ro} value={days ?? sprintData?.lengthDays ?? p.sprintLengthDays}
            onChange={(e) => setDays(Number(e.target.value))}
            onBlur={() => days != null && days >= 1 && days !== p.sprintLengthDays && void patch({ sprintLengthDays: days }, t('Saved. Applies to the next sprint.')).then(() => { void qc.invalidateQueries({ queryKey: ['sprints'] }); setDays(null); })} />
        </Tooltip>
        <Tooltip text={t('A new sprint starts by itself when the current one ends.')}><span className="hint grow">{t('days')}</span></Tooltip>
      </div>
      <div id="sprint-review" className="s-row">
        <Tooltip text={t('Meeting in the calendar on the last working day of the sprint.')}><span className="s-label">{t('Sprint review')}</span></Tooltip>
        <Tooltip text={ro}>
          <button className={`switch ${p.reviewMeeting ? 'on' : ''}`} role="switch" aria-checked={p.reviewMeeting} aria-label={t('Plan a sprint review meeting')} disabled={!!ro}
            onClick={() => void askConfirm(p.reviewMeeting
              ? { title: t('Turn off the sprint review?'), body: t('Planned review meetings disappear from the calendar for everyone.'), action: t('Turn off') }
              : { title: t('Turn on the sprint review?'), body: t('Every sprint gets a review meeting in the calendar for the whole team.'), action: t('Turn on'), danger: false })
              .then((ok) => { if (ok) void patch({ reviewMeeting: !p.reviewMeeting }).then(() => qc.invalidateQueries({ queryKey: ['meetings'] })); })} />
        </Tooltip>
        <span className="hint">{t('at')}</span>
        <Tooltip text={ro ?? off}>
          <TimeInput value={p.reviewTime} disabled={!!(ro ?? off)} aria-label={t('Sprint review time')} onChange={(v) => void patch({ reviewTime: v })} />
        </Tooltip>
        <span className="hint">{t('for')}</span>
        <Tooltip text={ro ?? off}>
          <input className="input s-input-num" type="number" min={5} max={480} step={5} key={p.reviewMinutes} defaultValue={p.reviewMinutes} disabled={!!(ro ?? off)}
            onBlur={(e) => Number(e.target.value) !== p.reviewMinutes && void patch({ reviewMinutes: Number(e.target.value) })} />
        </Tooltip>
        <span className="hint">min</span>
      </div>
    </div>
  );
}

type DeployEnvRow = { id?: number; name: string; sourceRef: string; isProduction: boolean; source?: string };

/** Środowiska deployu: każda zmiana wysyła całą listę (PUT), kolejność wierszy = kolejność w pasku bocznym. */
function WebhookSecret({ projectKey }: { projectKey: string }) {
  const q = useQuery({ queryKey: ['deploy-webhook-secret', projectKey], queryFn: () => api<{ secret: string }>(`/api/projects/${projectKey}/deploy-webhook-secret`), staleTime: Infinity });
  return (
    <div className="s-row">
      <span className="s-label">{t('Webhook secret')}</span>
      <input className="input grow" type="password" readOnly value={q.data?.secret ?? ''} aria-label={t('Webhook secret')} />
      <button className="btn sm" disabled={!q.data} onClick={() => q.data && copyText(q.data.secret, t('Secret copied'))}>{t('Copy')}</button>
    </div>
  );
}

const SOURCE_LABEL: Record<string, () => string> = { github: () => 'GitHub', coolify: () => 'Coolify', webhook: () => t('CI'), '': () => t('Manual') };

/** Wiersz "Deploys": środowiska wykrywane automatycznie z pierwszego zdarzenia; ręcznie można dodać własne. */
function DeployEnvs({ projectKey, ro }: { projectKey: string; ro: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deploy-envs', projectKey], queryFn: () => api<DeployEnvRow[]>('/api/deploy-envs') });
  const envs = q.data ?? [];
  const save = (next: DeployEnvRow[]) => api<DeployEnvRow[]>('/api/deploy-envs', { method: 'PUT', body: { envs: next } })
    .then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['deploy-envs', projectKey] }); void qc.invalidateQueries({ queryKey: ['deploy'] }); })
    // Odrzucony zapis: pola wracają do wartości z serwera (nowy key = świeże defaultValue).
    .catch((e: Error) => { toast(e.message, 'err'); setRev((r) => r + 1); void qc.invalidateQueries({ queryKey: ['deploy-envs', projectKey] }); });
  const [rev, setRev] = useState(0);
  const edit = (i: number, part: Partial<DeployEnvRow>) => save(envs.map((e, j) => (j === i ? { ...e, ...part } : e)));
  const add = () => {
    const name = envs.some((e) => e.name.toLowerCase() === 'stage') ? t('Env {n}', { n: envs.length + 1 }) : t('Stage');
    // Pierwsze środowisko to produkcja; potem dokładnie jedno środowisko jest produkcyjne.
    return save([...envs, { name, sourceRef: '', isProduction: envs.length === 0 }]);
  };
  return (
    <>
      <div id="deploys" className={`s-row ${envs.length ? 's-group-head' : ''}`}>
        <Tooltip text={t('Detected automatically: GitHub Deployments of this repo (repo webhook with Deployment statuses) and Coolify apps built from it.')}><span className="s-label">{t('Deploys')}</span></Tooltip>
        {envs.length ? <span className="grow" /> : <span className="hint grow">{t('No deploys yet')}</span>}
        <Tooltip text={ro}><button className="btn sm" disabled={!!ro} onClick={() => void add()}><Icon.plus size={13} /> {t('Add environment')}</button></Tooltip>
      </div>
      {/* Środowiska wcięte pod nagłówkiem (kolumna pól), bez kresek między nimi: widać, że to jedna lista. */}
      {envs.map((e, i) => (
        <div key={e.id} className={`s-row s-sub ${i === envs.length - 1 ? 'last' : ''}`}>
          <input className="input env-name" key={`${e.name}-${rev}`} disabled={!!ro} maxLength={30} defaultValue={e.name} aria-label={t('Environment name')}
            onBlur={(ev) => ev.target.value.trim() && ev.target.value.trim() !== e.name && void edit(i, { name: ev.target.value.trim() })} />
          <span className="grow"><span className="pill" title={e.sourceRef || undefined}>{(SOURCE_LABEL[e.source ?? ''] ?? SOURCE_LABEL[''])()}</span></span>
          <Tooltip text={ro}>
            <span className="hint s-inline">
              <button className={`switch ${e.isProduction ? 'on' : ''}`} role="switch" aria-checked={e.isProduction} aria-label={t('Production')} disabled={!!ro}
                onClick={() => { if (!e.isProduction) void save(envs.map((x, j) => ({ ...x, isProduction: j === i }))); }} />
              {t('Production')}
            </span>
          </Tooltip>
          <Tooltip text={ro ?? t('Remove')}><button className="icon-btn" disabled={!!ro} aria-label={t('Remove')} onClick={() => void askConfirm({
            title: t('Remove {name}?', { name: e.name }), body: e.source ? t('Its deploy history stays, commits lose this marker. Auto-detected environments will not come back.') : t('Its deploy history stays, commits lose this marker.'), action: t('Remove'), danger: true,
          }).then((ok) => { if (ok) void save(envs.filter((_, j) => j !== i)); })}><Icon.trash size={14} /></button></Tooltip>
        </div>
      ))}
      <details className="s-row s-details">
        <summary className="s-label"><Icon.chevronRight size={12} />{t('Other CI')}</summary>
        {!ro && <WebhookSecret projectKey={projectKey} />}
        <code className="hint">{`curl -X POST ${location.origin}/hooks/deploy -H "X-Webhook-Secret: …" -d '{"project":"${projectKey}","sha":"…","env":"${envs[0]?.name ?? 'Production'}"}'`}</code>
      </details>
    </>
  );
}

function ProjectIntegrations() {
  const c = useProject();
  const demo = !!useMe().data?.demo;
  if (!c) return null;
  const { p, patch } = c;
  const ro = c.ro ?? (demo ? t('Disabled in the demo') : null);
  return (
    <div className="s-card">
      <div id="github-repo" className="s-row">
        <Tooltip text={t('Analyze runs Claude in this repo, and only its commits are linked to {key} issues. After a change, reinstall local analysis.', { key: p.key })}><span className="s-label">{t('GitHub repo')}</span></Tooltip>
        <Tooltip text={ro}>
          <input className="input grow" key={p.githubRepo} disabled={!!ro} placeholder="owner/name" defaultValue={p.githubRepo}
            onBlur={(e) => e.target.value.trim() !== p.githubRepo && void patch({ githubRepo: e.target.value.trim() })} />
        </Tooltip>
      </div>
      <DeployEnvs projectKey={p.key} ro={ro} />
      <div className="s-row" id="discord">
        <Tooltip text={t('Meeting polls, picked times and reminders are posted to this channel with @here.')}><span className="s-label">Discord webhook</span></Tooltip>
        <Tooltip text={ro}>
          <input className="input grow" key={p.discordWebhookUrl ?? ''} disabled={!!ro} placeholder={ro ? t('Set by a project admin') : 'https://discord.com/api/webhooks/…'}
            defaultValue={p.discordWebhookUrl ?? ''}
            onBlur={(e) => e.target.value.trim() !== (p.discordWebhookUrl ?? '') && void patch({ discordWebhookUrl: e.target.value.trim() || null })} />
        </Tooltip>
        {p.discordLastError && <span className="hint s-hint">{t('Last Discord message failed {when}: {error}. Check the webhook URL.', { when: p.discordLastErrorAt ? timeAgo(p.discordLastErrorAt) : '', error: p.discordLastError })}</span>}
      </div>
      <div id="meeting-place" className="s-row">
        <Tooltip text={t('Default meeting link (Teams, Discord, Meet…) for new meetings and sprint reviews.')}><span className="s-label">{t('Meeting place')}</span></Tooltip>
        <Tooltip text={ro}>
          <input className="input grow" key={p.meetingLocationUrl} disabled={!!ro} placeholder={t('Teams, Discord or Meet link')}
            defaultValue={p.meetingLocationUrl}
            onBlur={(e) => e.target.value.trim() !== p.meetingLocationUrl && void patch({ meetingLocationUrl: e.target.value.trim() })} />
        </Tooltip>
      </div>
    </div>
  );
}

function ProjectPeople() {
  const c = useProject();
  const me = useMe().data;
  const [login, setLogin] = useState('');
  if (!c) return null;
  const { p, ro, refresh } = c;
  const admins = p.members.filter((m) => m.role === 'admin').length;
  return (
    <>
    <div id="add-member" className="s-card">
      <div className="s-row">
        <input className="input grow" placeholder={t('GitHub login or e-mail to add')} value={login} disabled={!!ro} onChange={(e) => setLogin(e.target.value)} />
        <Tooltip text={ro}>
          <button className="btn" disabled={!!ro || !login.trim()} onClick={() => void api(`/api/projects/${p.key}/members`, { method: 'POST', body: { login: login.trim() } }).then(() => { setLogin(''); toast(t('Added. They can log in with their account.')); refresh(); })}><Icon.plus size={13} /> {t('Add')}</button>
        </Tooltip>
      </div>
      {p.members.map((u) => {
        const lastAdmin = u.role === 'admin' && admins === 1;
        return (
          <div key={u.id} className="s-row" style={u.active ? undefined : { opacity: 0.5 }}>
            <PersonLink userId={u.id}><Avatar user={u} size={22} /></PersonLink>
            <span className="grow"><PersonLink userId={u.id}>{u.name}</PersonLink> {u.id === me?.id && <span className="badge me">{t('You')}</span>} <span className="hint">@{u.login}</span></span>
            <Tooltip text={ro ?? (lastAdmin ? t('A project needs at least one admin') : null)}>
              <div className="seg">
                {(['member', 'admin'] as const).map((r) => (
                  <button key={r} className={u.role === r ? 'on' : ''} disabled={!!ro || lastAdmin}
                    onClick={() => u.role !== r && void askConfirm(r === 'admin'
                      ? { title: t('Make {name} a project admin?', { name: u.name }), body: t('They can change settings and members of {project}.', { project: p.name }), action: t('Make admin'), danger: false }
                      : { title: t('Make {name} a member?', { name: u.name }), body: t('They lose admin rights in {project}.', { project: p.name }), action: t('Remove admin') })
                      .then((ok) => { if (ok) void api(`/api/projects/${p.key}/members`, { method: 'POST', body: { login: u.login, role: r } }).then(refresh); })}>
                    {r === 'admin' ? t('Admin') : t('Member')}
                  </button>
                ))}
              </div>
            </Tooltip>
            <Tooltip text={ro ?? (lastAdmin ? t('A project needs at least one admin') : null)}>
              <button className="btn sm danger" disabled={!!ro || lastAdmin}
                onClick={() => void askConfirm({ title: t('Remove {name} from {project}?', { name: u.name, project: p.name }), body: u.id === me?.id ? t('You will lose access to it.') : undefined, action: t('Remove') }).then((ok) => { if (ok) void api(`/api/projects/${p.key}/members/${u.id}`, { method: 'DELETE' }).then(refresh); })}>{t('Remove')}</button>
            </Tooltip>
          </div>
        );
      })}
    </div>
      <InviteLinks />
    </>
  );
}

type InviteRow = {
  id: number; role: 'admin' | 'member'; expiresAt: string; usedAt: string | null; createdByName: string | null; usedByName: string | null;
  status: 'pending' | 'expired' | 'accepted';
};

/** Jednorazowe linki zaproszeń do projektu: admin tworzy link z rolą i sam go wysyła; link widać tylko raz. */
function InviteLinks() {
  const c = useProject();
  const demo = !!useMe().data?.demo;
  const qc = useQueryClient();
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [link, setLink] = useState('');
  const key = c?.p.key;
  const ro = c?.ro ?? (demo ? t('Disabled in the demo') : null);
  const invites = useQuery({ queryKey: ['invites', key], queryFn: () => api<InviteRow[]>(`/api/projects/${key}/invites`), enabled: !!key && !ro });
  if (!c) return null;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['invites', key] });
  const renew = (id: number) => void api<{ url: string }>(`/api/projects/${key}/invites/${id}/renew`, { method: 'POST' }).then((r) => { setLink(r.url); refresh(); });
  const statusPill = { accepted: ['ok', t('Accepted')], pending: ['waiting', t('Pending')], expired: ['ended', t('Expired')] } as const;
  const statusText = (i: InviteRow) => i.status === 'accepted'
    ? t('{name}, {date}', { name: i.usedByName ?? '', date: fmtDate(i.usedAt!) })
    : i.status === 'expired' ? t('by {name}, expired {date}', { name: i.createdByName ?? '', date: fmtDate(i.expiresAt) })
    : t('by {name}, expires {date}', { name: i.createdByName ?? '', date: fmtDate(i.expiresAt) });
  return (
    <div className="s-card" id="invites">
      <div className="s-row s-row-head">
        <span className="grow"><Tooltip text={t('One-time link, valid for 7 days. Whoever opens it creates an account and joins this project.')}><b>{t('Invite link')}</b></Tooltip></span>
        <Tooltip text={ro}>
          <div className="seg" aria-label={t('Role')}>
            {(['member', 'admin'] as const).map((r) => (
              <button key={r} className={role === r ? 'on' : ''} disabled={!!ro} onClick={() => setRole(r)}>{r === 'admin' ? t('Admin') : t('Member')}</button>
            ))}
          </div>
        </Tooltip>
        <Tooltip text={ro}>
          <button className="btn" disabled={!!ro} onClick={() => void api<{ url: string }>(`/api/projects/${key}/invites`, { method: 'POST', body: { role } }).then((r) => { setLink(r.url); refresh(); })}>
            <Icon.plus size={13} /> {t('Create invite link')}
          </button>
        </Tooltip>
      </div>
      {link && (
        <div className="s-row">
          <input className="input grow" readOnly value={link} aria-label={t('Invite link')} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => copyText(link, t('Link copied'))}>{t('Copy')}</button>
          <span className="hint s-hint">{t('Shown only once. Copy it now and send it to the person.')}</span>
        </div>
      )}
      {(invites.data ?? []).map((i) => (
        <div key={i.id} className="s-row">
          <span className="grow">{i.role === 'admin' ? t('Admin') : t('Member')} <span className={`pill ${statusPill[i.status][0]}`}>{statusPill[i.status][1]}</span>
            <div className="hint">{statusText(i)}</div>
          </span>
          {/* Przyciski zawsze w tym samym miejscu, wyszarzone, gdy nie mają sensu (przyjęte, wygasłe). */}
          <Tooltip text={i.status === 'accepted' ? t('Already accepted') : t('Creates a new link with the same role; the old one stops working')}>
            <button className="btn sm" disabled={i.status === 'accepted'} onClick={() => renew(i.id)}>{t('New link')}</button>
          </Tooltip>
          <Tooltip text={i.status === 'pending' ? null : i.status === 'accepted' ? t('Already accepted') : t('Already expired')}>
            <button className="btn sm danger" disabled={i.status !== 'pending'} onClick={() => void askConfirm({ title: t('Revoke this invite link?'), body: i.createdByName ? t('Created by {name}. The link stops working.', { name: i.createdByName }) : t('The link stops working.'), action: t('Revoke') })
              .then((ok) => { if (ok) void api(`/api/projects/${key}/invites/${i.id}`, { method: 'DELETE' }).then(refresh); })}>{t('Revoke')}</button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

/** Hasło do logowania e-mailem. Konto z ustawionym hasłem musi podać obecne. */
function PasswordSettings() {
  const me = useMe().data;
  const qc = useQueryClient();
  const demo = !!me?.demo;
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const reason = demo ? t('Disabled in the demo') : null;
  const save = () => void api('/api/me/password', { method: 'POST', body: { current: current || undefined, password } })
    .then(() => { setCurrent(''); setPassword(''); toast(t('Password saved')); void qc.invalidateQueries({ queryKey: ['me'] }); });
  return (
    <div id="password-card" className="s-card">
      <div className="s-row">
        <span className="grow">{me?.hasPassword ? t('Change the password you use to log in with your e-mail.') : t('Set a password to log in with your e-mail. Google and GitHub keep working.')}
          <div className="hint">{t('At least 10 characters.')}</div>
        </span>
      </div>
      {me?.hasPassword && (
        <div className="s-row">
          <Tooltip text={reason}><input className="input grow" type="password" autoComplete="current-password" disabled={demo} placeholder={t('Current password')} aria-label={t('Current password')} value={current} onChange={(e) => setCurrent(e.target.value)} /></Tooltip>
        </div>
      )}
      <div className="s-row">
        <Tooltip text={reason}><input className="input grow" type="password" autoComplete="new-password" disabled={demo} placeholder={t('New password')} aria-label={t('New password')} value={password} onChange={(e) => setPassword(e.target.value)} /></Tooltip>
        <Tooltip text={reason}>
          <button className="btn primary" disabled={demo || password.length < 10 || (!!me?.hasPassword && !current)} onClick={save}>{t('Save password')}</button>
        </Tooltip>
      </div>
    </div>
  );
}

// Etykiety typu, które ustawia analiza AI (TYPE_LABEL_NAMES w src/server/analysis.ts).
const AI_LABELS = ['bug', 'feature', 'investigate'];

function ProjectLabelsStatuses() {
  const c = useProject();
  const [label, setLabel] = useState(() => ({ name: '', color: defaultSwatch() }));
  if (!c) return null;
  const { meta, ro, refresh } = c;
  return (
    <>
      <div id="labels" className="s-card">
        <div className="s-row s-row-head"><b>{t('Labels')}</b></div>
        <div className="s-row">
          <Tooltip text={ro}><Swatches value={label.color} disabled={!!ro} onChange={(c) => setLabel((l) => ({ ...l, color: c }))} /></Tooltip>
          <input className="input grow" placeholder={t('New label')} value={label.name} disabled={!!ro} onChange={(e) => setLabel((l) => ({ ...l, name: e.target.value }))} />
          <Tooltip text={ro}>
            <button className="btn" disabled={!!ro || !label.name.trim()} onClick={() => void api('/api/admin/labels', { method: 'POST', body: label }).then(() => { setLabel({ name: '', color: label.color }); refresh(); })}><Icon.plus size={13} /> {t('Add')}</button>
          </Tooltip>
        </div>
        {meta.labels.map((l) => { const byAi = AI_LABELS.includes(l.name.toLowerCase()); const lock = ro || (byAi ? t('AI analysis finds this label by its name, so it cannot be renamed or deleted. You can change its color.') : null); return (
          <div key={l.id} className="s-row">
            <Tooltip text={ro}><Swatches value={l.color} disabled={!!ro} onChange={(c) => void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: l.name, color: c } }).then(refresh)} /></Tooltip>
            <Tooltip text={lock}><input className="input grow" defaultValue={l.name} disabled={!!lock} onBlur={(e) => { const el = e.target; if (el.value.trim() && el.value !== l.name) void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: el.value.trim(), color: l.color } }).then(refresh).catch((err: Error) => { toast(err.message, 'err'); el.value = l.name; }); }} /></Tooltip>
            {byAi && <Tooltip text={t('AI analysis sets this label from the issue type.')}><span className="badge ai">{t('set by AI')}</span></Tooltip>}
            <Tooltip text={lock}>
              <button className="btn sm danger" disabled={!!lock} onClick={() => void askConfirm({ title: t('Delete label "{name}"?', { name: l.name }), body: t('It will be removed from all issues.') }).then((ok) => { if (ok) void api(`/api/admin/labels/${l.id}`, { method: 'DELETE' }).then(refresh); })}>{t('Delete')}</button>
            </Tooltip>
          </div>
        ); })}
      </div>
      <div id="statuses" className="s-card">
        <div className="s-row s-row-head"><Tooltip text={t('Order is the order of columns on the board.')}><b>{t('Statuses')}</b></Tooltip></div>
        {meta.statuses.map((s, idx) => (
          <div key={s.id} className="s-row">
            <Tooltip text={t(s.type)}><span className="s-inline"><StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} /></span></Tooltip>
            <Tooltip text={ro}><Swatches value={s.color} disabled={!!ro} onChange={(c) => void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, color: c } }).then(refresh)} /></Tooltip>
            <input className="input grow" defaultValue={s.name} disabled={!!ro} onBlur={(e) => { const el = e.target; if (el.value.trim() && el.value !== s.name) void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, name: el.value.trim() } }).then(refresh).catch((err: Error) => { toast(err.message, 'err'); el.value = s.name; }); }} />
            <Tooltip text={ro}>
              <select className="input" value={s.role ?? ''} disabled={!!ro} aria-label={t('Status role')}
                onChange={(e) => void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, role: e.target.value || null } }).then(refresh)}>
                <option value="">{t('No special role')}</option>
                <option value="need_info">{t('Need Info (asks a question)')}</option>
                <option value="testing">{t('Testing')}</option>
              </select>
            </Tooltip>
            <label className="hint s-check">
              <input type="checkbox" checked={!s.hiddenOnBoard} disabled={!!ro} onChange={(e) => void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, hiddenOnBoard: !e.target.checked } }).then(refresh)} /> {t('On board')}
            </label>
            <Tooltip text={ro ?? t('Move up')}><button className="icon-btn" disabled={!!ro || idx === 0} aria-label={t('Move up')} onClick={() => void swap(meta.statuses, idx, idx - 1).then(refresh)}>↑</button></Tooltip>
            <Tooltip text={ro ?? t('Move down')}><button className="icon-btn" disabled={!!ro || idx === meta.statuses.length - 1} aria-label={t('Move down')} onClick={() => void swap(meta.statuses, idx, idx + 1).then(refresh)}>↓</button></Tooltip>
          </div>
        ))}
      </div>
    </>
  );
}

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

// Polecenia dla Claude Code są stałe w kodzie (prompts.ts), treść i format analizy ustala skill; projekt wybiera tylko model.
const PROMPTS = [
  { kind: 'analyze', name: t('Analyze'), hint: t('Runs in the background on the PC of whoever clicks it (local runner), read-only.'), model: 'analyzeModel' },
  { kind: 'deep', name: t('Deep'), hint: t('Analyze with a deeper look at the code: checks more causes and lists risks.'), model: 'deepModel' },
] as const;

/** Modele analiz z guzików trackera, edytuje admin projektu. */
function ProjectPrompts() {
  const c = useProject();
  const demo = !!useMe().data?.demo;
  if (!c) return null;
  const { p, qc } = c;
  const ro = c.ro ?? (demo ? t('Disabled in the demo') : null);
  const save = (field: string, value: string) => api(`/api/projects/${p.key}`, { method: 'PATCH', body: { [field]: value } })
    .then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['project'] }); });
  return (
    <>
      <div className="s-card" id="agent-prompts">
        {PROMPTS.map((x) => (
          <div key={x.kind} id={x.kind === 'analyze' ? 'agent-analyze' : 'agent-deep'} className="s-row">
            <b>{x.name}</b><span className="hint grow">{x.hint}</span>
            {/* Aliasy Claude Code: zawsze najnowsza wersja danego modelu. Wybór równy domyślnemu zapisujemy jako pusty. */}
            <Tooltip text={ro ?? t('Model for this analysis')}>
              <div className="seg" aria-label={t('Model')}>
                {MODELS.map((m) => (
                  <button key={m} disabled={!!ro} className={(p[x.model] || p.defaultModels[x.kind]) === m ? 'on' : ''}
                    onClick={() => { const v = m === p.defaultModels[x.kind] ? '' : m; if (v !== p[x.model]) void save(x.model, v); }}>{m[0].toUpperCase() + m.slice(1)}</button>
                ))}
              </div>
            </Tooltip>
          </div>
        ))}
      </div>
      {/* Kolejka zespołu to ustawienie projektu (kto uruchamia analizy), więc tutaj, a nie w osobistej sekcji Claude Code. */}
      <TeamQueue />
    </>
  );
}

/** Konta w całym trackerze (kto może się zalogować przez GitHub, kto jest adminem globalnym). */
function Accounts() {
  const me = useMe().data;
  const demo = !!me?.demo;
  const qc = useQueryClient();
  // Projekty i role osób: z członków każdego projektu (konto samo nie niesie ról projektowych).
  const projectList = useProjects().data ?? [];
  const details = useQueries({ queries: projectList.map((pr) => ({ queryKey: ['project', pr.key], queryFn: () => api<ProjectDetail>(`/api/projects/${pr.key}`) })) });
  const memberships = new Map<number, { key: string; name: string; role: 'admin' | 'member' }[]>();
  for (const d of details) for (const m of d.data?.members ?? []) memberships.set(m.id, [...(memberships.get(m.id) ?? []), { key: d.data!.key, name: d.data!.name, role: m.role }]);
  const accounts = useQuery({ queryKey: ['admin-users'], queryFn: () => api<(User & { hasGithub: boolean; hasGoogle: boolean; hasPassword: boolean })[]>('/api/admin/users') });
  // Bez dodawania kont tutaj: nowe osoby dodaje projekt (People → Add albo link zaproszenia), żeby konto nie było bez projektu.
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); void qc.invalidateQueries({ queryKey: ['meta'] }); void qc.invalidateQueries({ queryKey: ['project'] }); };
  const saveUser = (body: object) => api('/api/admin/users', { method: 'POST', body }).then(refresh);

  return (
    <div id="accounts-card" className="s-card">
      {accounts.data?.map((u) => (
        <div key={u.id} className="s-row" style={u.active ? undefined : { opacity: 0.5 }}>
          <PersonLink userId={u.id}><Avatar user={u} size={22} /></PersonLink>
          <span className="grow"><PersonLink userId={u.id}>{u.name}</PersonLink> {u.id === me?.id && <span className="badge me">{t('You')}</span>}
            <div className="s-meta">
              {[u.hasGithub && 'GitHub', u.hasGoogle && 'Google', u.hasPassword && t('Password')].filter(Boolean).map((m) => <span key={m as string} className="pill ok">{m}</span>)}
              {!u.hasGithub && !u.hasGoogle && !u.hasPassword && <span className="pill waiting">{t('Not logged in yet')}</span>}
            </div>
            <div className="s-meta">
              {(memberships.get(u.id) ?? []).map((m) => <span key={m.key} className={`pill${m.role === 'admin' ? ' role-admin' : ''}`} title={m.name}>{m.key} · {m.role === 'admin' ? t('Admin') : t('Member')}</span>)}
              {details.every((d) => d.data) && !memberships.has(u.id) && <span className="hint">{t('No projects')}</span>}
            </div>
          </span>
          {/* Login GitHub jest edytowalny, żeby poprawić mapowanie z importu bez dublowania osoby. */}
          <Tooltip text={demo ? t('Disabled in the demo') : t('GitHub login')}><input className="input s-input-login" defaultValue={u.login} disabled={demo}
            onBlur={(e) => {
              const el = e.target, login = el.value.trim();
              if (!login || login === u.login) return;
              void askConfirm({ title: t('Change the login of {name} to {login}?', { name: u.name, login }), body: t('From now on they sign in with this GitHub account.'), action: t('Change login'), danger: false })
                .then((ok) => { if (ok) void saveUser({ id: u.id, login }); else el.value = u.login; });
            }} /></Tooltip>
          <Tooltip text={demo ? t('Disabled in the demo') : u.id === me?.id ? t('You cannot remove your own admin role') : t('Workspace admins manage accounts and every project')}>
            <label className="hint s-check">
              <input type="checkbox" checked={u.isAdmin} disabled={demo || u.id === me?.id} onChange={(e) => {
                const isAdmin = e.target.checked;
                void askConfirm(isAdmin
                  ? { title: t('Make {name} a workspace admin?', { name: u.name }), body: t('They get admin rights in every project and can manage accounts.'), action: t('Make admin'), danger: false }
                  : { title: t('Remove workspace admin from {name}?', { name: u.name }), body: t('They keep access only to the projects they are a member of.'), action: t('Remove admin') })
                  .then((ok) => { if (ok) void saveUser({ id: u.id, login: u.login, isAdmin }); });
              }} /> {t('Admin')}
            </label>
          </Tooltip>
          <Tooltip text={demo ? t('Disabled in the demo') : t('Creates a one-time link (24 h) to set a new password and copies it')}>
            <button className="btn sm" disabled={demo} onClick={() => void api<{ url: string }>(`/api/admin/users/${u.id}/reset-link`, { method: 'POST' }).then((r) => copyText(r.url, t('Password link copied')))}>{t('Reset password')}</button>
          </Tooltip>
          <Tooltip text={demo ? t('Disabled in the demo') : u.id === me?.id ? t('You cannot deactivate yourself') : null}>
            <button className="btn sm" disabled={demo || u.id === me?.id} onClick={() => void (u.active
              ? askConfirm({ title: t('Deactivate {name}?', { name: u.name }), body: t('They can no longer sign in. You can activate the account again later.'), action: t('Deactivate') })
              : Promise.resolve(true)).then((ok) => { if (ok) void saveUser({ id: u.id, login: u.login, active: !u.active }); })}>{u.active ? t('Deactivate') : t('Activate')}</button>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

async function swap(statuses: { id: number; position: number }[], a: number, b: number) {
  await api('/api/admin/statuses', { method: 'PATCH', body: { id: statuses[a].id, position: statuses[b].position } });
  await api('/api/admin/statuses', { method: 'PATCH', body: { id: statuses[b].id, position: statuses[a].position } });
}

/** Kolejka zespołu projektu: online komputer któregokolwiek członka bierze analizy wszystkich (na limitach jego Claude). */
type TeamMode = 'ask' | 'auto' | 'off';
const TEAM_MODES: TeamMode[] = ['ask', 'auto', 'off'];
const TEAM_MODE_LABEL: Record<TeamMode, () => string> = { ask: () => t('Ask first'), auto: () => t('Without asking'), off: () => t('Not taking') };
const TEAM_MODE_STATE: Record<TeamMode, () => string> = { ask: () => t('asks'), auto: () => t('without asking'), off: () => t('not taking') };

function TeamQueue() {
  const c = useProject();
  const demo = !!useMe().data?.demo;
  const key = useProjectKey();
  const online = useQuery({ queryKey: ['project-agents', key], queryFn: () => api<{ name: string; owner: string; busy: boolean; teamMode: TeamMode; usage30d: UsageInfo }[]>(`/api/projects/${key}/agents`), enabled: !!c && !demo, refetchInterval: 30_000 });
  if (!c) return null;
  const { p, ro: roBase, patch } = c;
  const ro = roBase ?? (demo ? t('Disabled in the demo') : null);
  // Queue off: nobody takes others' analyses in this project, whatever each PC is set to (rows grayed, reason on hover).
  const off = !p.agentTeamQueue;
  const offWhy = off ? t("Team queue is off: PCs only run their owners' analyses in this project.") : null;
  return (
    <div className="s-card" id="team-queue">
      <div className="s-row">
        <span className="grow"><Tooltip text={t('Lets members share their PCs. Each owner sets how their PC handles it.')}><span>{t('Team queue')} · {p.name}</span></Tooltip></span>
        <Tooltip text={ro}>
          <button className={`switch ${p.agentTeamQueue ? 'on' : ''}`} role="switch" aria-checked={p.agentTeamQueue} aria-label={t('Team queue')}
            disabled={!!ro} onClick={() => void patch({ agentTeamQueue: !p.agentTeamQueue })} />
        </Tooltip>
      </div>
      {(online.data ?? []).map((a, i) => (
        <div key={i} className={`s-row${off ? ' is-off' : ''}`}>
          <span className="grow">{a.name || t('Unnamed PC')} · {a.owner}</span>
          {a.busy && <span className="hint">{t('running an analysis')}</span>}
          <Tooltip text={offWhy}><span className={off || a.teamMode === 'off' ? 'pill ended' : 'pill ok'} tabIndex={off ? 0 : undefined}>{TEAM_MODE_STATE[a.teamMode]()}</span></Tooltip>
          <Tooltip text={byRequesterText(a.usage30d)}><span className="hint">{t('30 days: {runs} analyses · {tokens}', { runs: a.usage30d.runs, tokens: t('{n} tokens', { n: tok(a.usage30d.tokens) }) })}</span></Tooltip>
        </div>
      ))}
      {!demo && !(online.data ?? []).length && <div className="s-row"><span className="hint">{t('No PC is online right now.')}</span></div>}
    </div>
  );
}
