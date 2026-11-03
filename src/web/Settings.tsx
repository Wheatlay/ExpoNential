import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TimeInput } from './DateTime.tsx';
import { askConfirm } from './Confirm.tsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useMe, useMeta, useSprints, type User } from './api.ts';
import { useProjectKey } from './project.ts';
import { ProjectBadge } from './ProjectSwitcher.tsx';
import { NotificationSettings } from './Notifications.tsx';
import { ProjectTags } from './ProjectTags.tsx';
import { PersonLink } from './PersonCard.tsx';
import { Avatar, Icon, StatusIcon, startedFraction } from './icons.tsx';
import { copyText, toast } from './toast.ts';
import { timeAgo } from './time.ts';
import { Tooltip } from './menu.tsx';
import { agentHere, agentInstallCommand } from './startWork.ts';
import { openSetupWizard } from './SetupWizard.tsx';
import { lang, setLang, t, type Lang } from './i18n.ts';
import { uploadImageFile } from './paste.ts';

export type Theme = 'dark' | 'light' | 'oled';

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch { /* prywatne okno */ }
}

/**
 * Ustawienia w trzech zakresach, żeby było jasne, co zmieniasz dla siebie, a co dla wszystkich:
 * Ty (wygląd, powiadomienia, Claude Code na tym komputerze), bieżący projekt, workspace (admin).
 * Widać jedną sekcję naraz; wybór w adresie (#sekcja), więc link "#project" dalej działa.
 */
type Section = { id: string; name: string; render: () => ReactNode };

function useHash() {
  const [hash, setHash] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1));
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return hash;
}

export function Settings() {
  const me = useMe().data;
  const p = useProjectDetail().data;
  const groups: { name: ReactNode; items: Section[] }[] = [
    { name: t('You'), items: [
      { id: 'profile', name: t('Profile'), render: () => <ProfileSettings /> },
      { id: 'appearance', name: t('Appearance'), render: () => <Appearance /> },
      { id: 'notifications', name: t('Notifications'), render: () => <NotificationSettings /> },
      { id: 'claude', name: 'Claude Code', render: () => <ClaudeConnect /> },
      { id: 'password', name: t('Password'), render: () => <PasswordSettings /> },
    ] },
    { name: p ? <span className="settings-nav-project"><ProjectBadge project={p} size={14} /> {p.name}</span> : t('Project'), items: [
      { id: 'project', name: t('General'), render: () => <ProjectGeneral /> },
      { id: 'people', name: t('People'), render: () => <ProjectPeople /> },
      { id: 'tags', name: t('Tags'), render: () => <ProjectTags /> },
      { id: 'labels', name: t('Labels and statuses'), render: () => <ProjectLabelsStatuses /> },
      { id: 'integrations', name: t('Integrations'), render: () => <ProjectIntegrations /> },
      { id: 'prompts', name: t('AI agent'), render: () => <ProjectPrompts /> },
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
              {g.items.map((s) => (
                <a key={s.id} href={`#${s.id}`} className={`nav-item${s === current ? ' active' : ''}`}
                  onClick={(e) => { e.preventDefault(); history.replaceState(null, '', `#${s.id}`); dispatchEvent(new HashChangeEvent('hashchange')); }}>
                  {s.name}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-inner">
          <h3 className="settings-title">{current.name}</h3>
          {current.render()}
          <SettingsHints current={current.id} groups={groups} isAdmin={!!me?.isAdmin} />
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
    { label: t('Connect this computer'), to: 'claude', target: 'claude-connect' },
    { label: t('Your computers'), to: 'claude', target: 'your-computers' },
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
  // Ty › Claude Code
  { label: t('Connect AI'), to: 'claude', target: 'claude-connect', keywords: ['claude code', 'codex', 'mcp', 'wizard', 'ai', 'polacz'] },
  { label: t('Connected AI clients'), to: 'claude', target: 'ai-clients', keywords: ['mcp', 'oauth', 'grants', 'dostep'] },
  { label: t('Your computers'), to: 'claude', target: 'your-computers', keywords: ['agent', 'pc', 'komputer', 'computer', 'runner'] },
  { label: t('Tokens'), to: 'claude', target: 'tokens', keywords: ['api', 'key', 'klucz', 'token'] },
  { label: t('Legacy installer (Windows script)'), to: 'claude', target: 'legacy-installer', keywords: ['install', 'powershell', 'instalator', 'windows'] },
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
  { label: t('Deploys'), to: 'integrations', target: 'deploys', keywords: ['wdrozenia', 'deploy', 'source', 'zrodlo', 'webhook', 'coolify', 'github deployments'] },
  { label: t('Environments'), to: 'integrations', target: 'deploy-envs', keywords: ['prod', 'stage', 'production', 'produkcja', 'staging', 'qa', 'coolify', 'deploy', 'srodowisko', 'środowisko'] },
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
          <input className="input grow" key={`${me.name}-${rev}`} defaultValue={me.name} maxLength={60} aria-label={t('Your name')}
            onBlur={(e) => rename(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </div>
      </div>
      <div id="profile-danger" className="s-card" style={{ marginTop: 24 }}>
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
        <div className="seg">
          {(['pl', 'en'] as Lang[]).map((l) => (
            <button key={l} className={lang === l ? 'on' : ''} onClick={() => { if (l !== lang) setLang(l); }}>{l === 'pl' ? 'Polski' : 'English'}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Podłączenie Claude Code na tym komputerze jednym poleceniem: przycisk tworzy token i daje polecenie, które
 * dodaje serwer MCP każdemu kontu Claude Code, instaluje plugin (skille, ślad pracy) i analizę w tle.
 * Po instalacji to samo polecenie bez tokenu tylko aktualizuje. Tokeny niżej, żeby dało się je unieważnić.
 */
const dmy = (iso: string) => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`; };

function ClaudeConnect() {
  const qc = useQueryClient();
  const me = useMe().data;
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<{ id: number; name: string; createdAt: string; lastUsedAt: string | null }[]>('/api/tokens'), enabled: !!me && !me.demo });
  const agentList = useQuery({ queryKey: ['agents'], queryFn: () => api<{ id: string; name: string; computerName: string; label: string; lastSeenAt: string | null; busy: boolean; online: boolean; outdated: boolean; lastError: string; lastErrorAt: string | null }[]>('/api/agents'), enabled: !!me && !me.demo && !!me.localAgentAt });
  const grants = useQuery({ queryKey: ['connections'], queryFn: () => api<{ id: number; client: string; createdAt: string; lastUsedAt: string | null; firstMcpAt: string | null }[]>('/api/connections'), enabled: !!me && !me.demo });
  // Przełącznik "ten komputer ma agenta": tylko ta przeglądarka (localStorage), dla laptopów z dotykiem, gdzie wykrycie telefonu myli.
  const [, setTick] = useState(0);
  const here = agentHere(me);
  const toggleHere = () => { try { localStorage.setItem('tracker.agentHere', here ? '0' : '1'); } catch { /* prywatne okno */ } setTick((n) => n + 1); };
  const [cmd, setCmd] = useState<string | null>(null);
  // Instalacja dzieje się w terminalu: po powrocie do karty odświeżamy status bez przeładowania.
  useEffect(() => {
    const f = () => { void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['tokens'] }); void qc.invalidateQueries({ queryKey: ['agents'] }); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [qc]);
  const copy = (c: string) => copyText(c, t('Copied. Paste it into PowerShell.'));
  const [token, setToken] = useState<string | null>(null);
  // Do schowka idzie sam token, nie polecenie "irm … | iex": to drugie blokują filtry anty-ClickFix (np. uBlock Origin).
  const createCmd = async () => {
    const r = await api<{ token: string }>('/api/tokens', { method: 'POST', body: { name: t('Claude Code, {date}', { date: new Date().toLocaleDateString() }) } });
    setToken(r.token);
    setCmd(agentInstallCommand(r.token));
    copyText(r.token, t('Token copied. Run the downloaded installer and paste it when asked.'));
    void qc.invalidateQueries({ queryKey: ['tokens'] });
  };
  const download = (file: string) => (
    <a className="btn" href={`/agent/${file}`} download>{file.startsWith('exponential-install') ? t('Download installer') : t('Download uninstaller')}</a>
  );
  const demo = !!me?.demo;
  const installed = !!me?.localAgentAt;
  const update = agentInstallCommand();
  return (
    <>
      <p className="hint settings-lead">{t('Connect Claude Code or Codex to Exponential: issue access, work log in issues and Analyze in the background.')}</p>
      <div className="s-card" id="claude-connect">
        <div className="s-row">
          <span className="grow">{t('AI clients')}<div className="hint">{t('The wizard connects Claude Code or Codex, in VS Code, Cursor or the terminal.')}</div></span>
          <button className="btn primary" onClick={() => openSetupWizard()}>{t('Connect AI')}</button>
        </div>
      </div>
      {(grants.data?.length ?? 0) > 0 && (
        <div className="s-card" id="ai-clients" style={{ marginTop: 12 }}>
          <div className="s-row s-row-head"><b>{t('Connected AI clients')}</b></div>
          {grants.data!.map((g) => (
            <div key={g.id} className="s-row">
              <span className="grow">{g.client}</span>
              <span className="hint">{g.lastUsedAt ? t('since {date}, last used {when}', { date: dmy(g.createdAt), when: timeAgo(g.lastUsedAt) }) : t('since {date}, never used', { date: dmy(g.createdAt) })}</span>
              <button className="btn sm danger" onClick={() => void askConfirm({
                title: t('Revoke "{name}"?', { name: g.client }), body: t('This client loses access to Exponential until you sign in with it again.'), action: t('Revoke'), danger: true,
              }).then((ok) => { if (ok) void api(`/api/connections/${g.id}`, { method: 'DELETE' }).then(() => { void qc.invalidateQueries({ queryKey: ['connections'] }); void qc.invalidateQueries({ queryKey: ['me'] }); }); })}>{t('Revoke')}</button>
            </div>
          ))}
        </div>
      )}
      <details id="legacy-installer" className="s-card settings-legacy">
        <summary className="s-row">{t('Legacy installer (Windows script)')}</summary>
        <div className="s-row">
          <span className={`step-dot${installed ? ' done' : ''}`}>{installed ? <Icon.check size={12} /> : <Icon.sparkle size={12} />}</span>
          <span className="grow">
            <b>{installed ? t('Connected') : t('Not connected')}</b>{' '}
            <span className="hint">{installed ? t('Installed {when}.', { when: timeAgo(me!.localAgentAt!) }) : t('Analyze only marks issues until this computer is connected.')}</span>
          </span>
          {installed
            ? <button className="btn" disabled={demo} onClick={() => void createCmd()} title={demo ? t('Disabled in the demo') : t('A new computer, or Claude Code without the Exponential connection')}>{t('Connect another computer')}</button>
            : <button className="btn primary" disabled={demo} title={demo ? t('Disabled in the demo') : undefined} onClick={() => void createCmd()}>{t('Create install command')}</button>}
        </div>
        {cmd && token && (
          <div className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' }}>
            <span className="hint">{t("1. Download the installer and run it (double-click). 2. Paste this token when it asks; it is already in your clipboard. The token won't be shown again.")}</span>
            <div className="token-box">{token}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {download('exponential-install.cmd?first=1')}
              <button className="btn" onClick={() => copyText(token, t('Token copied'))}><Icon.copy size={13} /> {t('Copy token')}</button>
            </div>
            <span className="hint">{t('Or paste this into PowerShell (select and copy it by hand if a blocker such as uBlock refuses the copy):')}</span>
            <div className="token-box">{cmd}</div>
          </div>
        )}
        {installed && (
          <div className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch', flexWrap: 'nowrap' }}>
            {/* Skrypty na PC nie aktualizują się same (kod z serwera nie podmienia się po cichu): mówimy wprost, że trzeba. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              {/* Na wąskim ekranie opis zajmuje własną linię, a oba przyciski zawijają się razem (bez wychodzenia poza ekran). */}
              <span className="hint" style={{ flex: '1 1 240px', minWidth: 0 }}>{me?.agentOutdated
                ? <><span className="pill stalled">{t('Update needed')}</span> {t('Exponential has newer PC scripts. Run this on your computer.')}</>
                : t('Update or new project/clone: run this again.')}</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {download('exponential-install.cmd')}
                <span title={t('Removes it from this computer')} style={{ display: 'inline-flex' }}>{download('exponential-uninstall.cmd')}</span>
              </div>
            </div>
            {/* Alternatywa dla terminala; kopiowanie może zablokować filtr anty-ClickFix, wtedy zaznacza się ręcznie. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
              <span className="hint">{t('Or in PowerShell:')}</span>
              {/* Polecenie się nie łamie, tylko przewija w poziomie wewnątrz pola: flex 1 1 200px i minWidth 0, żeby pole kurczyło się do ekranu. */}
              <code className="input" title={t('Or paste this into PowerShell (select and copy it by hand if a blocker such as uBlock refuses the copy):')} style={{ display: 'flex', alignItems: 'center', height: 30, overflowX: 'auto', whiteSpace: 'nowrap', flex: '1 1 200px', minWidth: 0 }}>{update}</code>
              <button className="btn" onClick={() => copy(update)}><Icon.copy size={13} /> {t('Copy')}</button>
            </div>
          </div>
        )}
      </details>
      {installed && !demo && (
        <div className="s-card" id="your-computers" style={{ marginTop: 12 }}>
          <div className="s-row s-row-head"><b>{t('Your computers')}</b><span className="hint">{t('A computer with the agent picks up analyses requested from your phone.')}</span></div>
          {(agentList.data ?? []).map((a) => (
            <div key={a.id} className="s-row">
              <span className="grow">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {/* Własna nazwa (jak login GitHub w Kontach): zapis po wyjściu z pola, pusta wraca do nazwy z Windowsa. */}
                  <input className="input" style={{ width: 180 }} key={a.label} defaultValue={a.label} placeholder={a.computerName || t('Unnamed computer')} aria-label={t('Computer name')}
                    title={t('Your name for this computer. Empty: the Windows name.')}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v !== a.label) void api(`/api/agents/${a.id}`, { method: 'PATCH', body: { label: v } }).then(() => { toast(t('Saved')); void qc.invalidateQueries({ queryKey: ['agents'] }); }); }} />
                  {a.outdated && <span className="pill stalled" title={t('Old version of the PC scripts. Run the update command above on this computer.')}>{t('Update needed')}</span>}
                </span>
                {a.label && a.computerName && <div className="hint">{t('Windows name: {name}', { name: a.computerName })}</div>}
                {a.lastError && <div className="hint">{t('Last error {when}: {error}', { when: a.lastErrorAt ? timeAgo(a.lastErrorAt) : '', error: a.lastError })}</div>}</span>
              <span className="hint">{a.online ? (a.busy ? t('running an analysis') : t('online')) : a.lastSeenAt ? t('last seen {when}', { when: timeAgo(a.lastSeenAt) }) : t('never seen')}</span>
              <button className="btn sm danger" onClick={() => void askConfirm({
                title: t('Remove "{name}"?', { name: a.name || t('Unnamed computer') }), body: t('This computer stops picking up work until the install command is run on it again.'), action: t('Remove'), danger: true,
              }).then((ok) => { if (ok) void api(`/api/agents/${a.id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['agents'] })); })}>{t('Remove')}</button>
            </div>
          ))}
          <div className="s-row">
            <span className="grow">{t('This computer has the agent')}<div className="hint">{t('For laptops with a touch screen. Off: Analyze here only queues the request.')}</div></span>
            <button className={`switch ${here ? 'on' : ''}`} role="switch" aria-checked={here} aria-label={t('This computer has the agent')} onClick={toggleHere} />
          </div>
        </div>
      )}
      {(tokens.data?.length ?? 0) > 0 && (
        <div id="tokens" className="s-card" style={{ marginTop: 12 }}>
          <div className="s-row s-row-head"><b>{t('Tokens')}</b><span className="hint">{t('One per connected computer. Revoke the one from a computer you no longer use.')}</span></div>
          {tokens.data!.map((tk) => (
            <div key={tk.id} className="s-row">
              <span className="grow">{tk.name}</span>
              <span className="hint">{t('created {when}', { when: timeAgo(tk.createdAt) })} · {tk.lastUsedAt ? t('used {when}', { when: timeAgo(tk.lastUsedAt) }) : t('never used')}</span>
              <button className="btn sm danger" disabled={demo} title={demo ? t('Disabled in the demo') : undefined} onClick={() => void askConfirm({ title: t('Revoke "{name}"?', { name: tk.name }), body: t('Claude Code using this token stops working.'), action: t('Revoke') }).then((ok) => { if (ok) void api(`/api/tokens/${tk.id}`, { method: 'DELETE' }).then(() => qc.invalidateQueries({ queryKey: ['tokens'] })); })}>{t('Revoke')}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

type ProjectDetail = {
  id: number; key: string; name: string; color: string; logoUrl: string; discordWebhookUrl: string | null; discordLastError: string; discordLastErrorAt: string | null; meetingLocationUrl: string;
  sprintLengthDays: number; reviewMeeting: boolean; reviewTime: string; reviewMinutes: number;
  promptStart: string; promptAnalyze: string; promptClose: string; promptDeep: string; analyzeModel: string; deepModel: string;
  githubRepo: string; deploySource: '' | 'webhook' | 'github' | 'coolify'; agentTeamQueue: boolean;
  defaultModels: { analyze: string; deep: string };
  role: 'admin' | 'member'; canEdit: boolean;
  members: { id: number; login: string; name: string; avatarUrl: string | null; active: boolean; role: 'admin' | 'member' }[];
};

export const useProjectDetail = () => {
  const key = useProjectKey();
  return useQuery({ queryKey: ['project', key], queryFn: () => api<ProjectDetail>(`/api/projects/${key}`) });
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
        <ProjectLogo p={p} ro={ro} patch={patch} />
        {!p.logoUrl && <Tooltip text={ro}>
          <input type="color" key={p.color} defaultValue={toHex(p.color)} disabled={!!ro} aria-label={t('Project color')}
            onBlur={(e) => e.target.value !== toHex(p.color) && void patch({ color: e.target.value })} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
        </Tooltip>}
      </div>
      <div id="sprint-length" className="s-row">
        <span className="s-label">{t('Sprint length')}</span>
        {/* Zapis po wyjściu z pola, jak pozostałe pola Ustawień. */}
        <Tooltip text={ro}>
          <input className="input" type="number" min={1} max={90} style={{ width: 80 }} disabled={!!ro} value={days ?? sprintData?.lengthDays ?? p.sprintLengthDays}
            onChange={(e) => setDays(Number(e.target.value))}
            onBlur={() => days != null && days >= 1 && days !== p.sprintLengthDays && void patch({ sprintLengthDays: days }, t('Saved. Applies to the next sprint.')).then(() => { void qc.invalidateQueries({ queryKey: ['sprints'] }); setDays(null); })} />
        </Tooltip>
        <span className="hint grow">{t('days. A new sprint starts by itself when the current one ends.')}</span>
      </div>
      <div id="sprint-review" className="s-row">
        <span className="s-label">{t('Sprint review')}</span>
        <Tooltip text={ro}>
          <button className={`switch ${p.reviewMeeting ? 'on' : ''}`} role="switch" aria-checked={p.reviewMeeting} aria-label={t('Plan a sprint review meeting')} disabled={!!ro}
            onClick={() => void askConfirm(p.reviewMeeting
              ? { title: t('Turn off the sprint review?'), body: t('Planned review meetings disappear from the calendar for everyone.'), action: t('Turn off') }
              : { title: t('Turn on the sprint review?'), body: t('Every sprint gets a review meeting in the calendar for the whole team.'), action: t('Turn on'), danger: false })
              .then((ok) => { if (ok) void patch({ reviewMeeting: !p.reviewMeeting }).then(() => qc.invalidateQueries({ queryKey: ['meetings'] })); })} />
        </Tooltip>
        <span className="hint">{t('meeting in the calendar on the last working day at')}</span>
        <Tooltip text={ro ?? off}>
          <TimeInput value={p.reviewTime} disabled={!!(ro ?? off)} aria-label={t('Sprint review time')} onChange={(v) => void patch({ reviewTime: v })} />
        </Tooltip>
        <span className="hint">{t('for')}</span>
        <Tooltip text={ro ?? off}>
          <input className="input" type="number" min={5} max={480} step={5} key={p.reviewMinutes} defaultValue={p.reviewMinutes} disabled={!!(ro ?? off)} style={{ width: 80 }}
            onBlur={(e) => Number(e.target.value) !== p.reviewMinutes && void patch({ reviewMinutes: Number(e.target.value) })} />
        </Tooltip>
        <span className="hint">min</span>
      </div>
    </div>
  );
}

type DeployEnvRow = { id?: number; name: string; sourceRef: string; isProduction: boolean };

/** Środowiska deployu: każda zmiana wysyła całą listę (PUT), kolejność wierszy = kolejność w pasku bocznym. */
function DeployEnvs({ source, projectKey, ro }: { source: ProjectDetail['deploySource']; projectKey: string; ro: string | null }) {
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
    return save([...envs, { name, sourceRef: '', isProduction: false }]);
  };
  const ph = source === 'coolify' ? t('Coolify app UUID') : t('GitHub environment');
  return (
    <>
      <div id="deploy-envs" className={`s-row ${envs.length ? 's-group-head' : ''}`}>
        <Tooltip text={t('Each environment shows its own box in the sidebar and its own rocket on commits.')}><span className="s-label">{t('Environments')}</span></Tooltip>
        {source === 'webhook'
          ? <code className="hint grow">{`curl -X POST ${location.origin}/hooks/deploy -H "X-Webhook-Secret: …" -d '{"project":"${projectKey}","sha":"…","env":"${envs[0]?.name ?? 'Prod'}"}'`}</code>
          : <span className="grow" />}
        <Tooltip text={ro}><button className="btn sm" disabled={!!ro} onClick={() => void add()}><Icon.plus size={13} /> {t('Add environment')}</button></Tooltip>
      </div>
      {/* Środowiska wcięte pod nagłówkiem (kolumna pól), bez kresek między nimi: widać, że to jedna lista. */}
      {envs.map((e, i) => (
        <div key={e.id} className={`s-row s-sub ${i === envs.length - 1 ? 'last' : ''}`}>
          <input className="input" style={{ width: 140 }} key={`${e.name}-${rev}`} disabled={!!ro} maxLength={30} defaultValue={e.name} aria-label={t('Environment name')}
            onBlur={(ev) => ev.target.value.trim() && ev.target.value.trim() !== e.name && void edit(i, { name: ev.target.value.trim() })} />
          {source !== 'webhook' ? (
            <input className="input grow" key={`${e.sourceRef}-${rev}`} disabled={!!ro} placeholder={ph} defaultValue={e.sourceRef} aria-label={ph}
              onBlur={(ev) => ev.target.value.trim() !== e.sourceRef && void edit(i, { sourceRef: ev.target.value.trim() })} />
          ) : <span className="grow" />}
          <Tooltip text={ro}>
            <span className="hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <button className={`switch ${e.isProduction ? 'on' : ''}`} role="switch" aria-checked={e.isProduction} aria-label={t('Production')} disabled={!!ro}
                onClick={() => void edit(i, { isProduction: !e.isProduction })} />
              {t('Production')}
            </span>
          </Tooltip>
          <button className="icon-btn" disabled={!!ro} aria-label={t('Remove')} title={ro ?? t('Remove')} onClick={() => void askConfirm({
            title: t('Remove {name}?', { name: e.name }), body: t('Its deploy history stays, commits lose this marker.'), action: t('Remove'), danger: true,
          }).then((ok) => { if (ok) void save(envs.filter((_, j) => j !== i)); })}><Icon.trash size={14} /></button>
        </div>
      ))}
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
        <span className="s-label">{t('GitHub repo')}</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.githubRepo} disabled={!!ro} placeholder="owner/name" defaultValue={p.githubRepo}
            onBlur={(e) => e.target.value.trim() !== p.githubRepo && void patch({ githubRepo: e.target.value.trim() })} />
        </Tooltip>
        <span className="hint s-hint">{t('Analyze runs Claude in this repo, and only its commits are linked to {key} issues. After a change, reinstall local analysis.', { key: p.key })}</span>
      </div>
      <div id="deploys" className="s-row">
        <span className="s-label">{t('Deploys')}</span>
        <Tooltip text={ro}>
          <select className="input" value={p.deploySource} disabled={!!ro} aria-label={t('Deploy status source')}
            onChange={(e) => void patch({ deploySource: e.target.value as ProjectDetail['deploySource'] })}>
            <option value="">{t('None')}</option>
            <option value="webhook">{t('Webhook')}</option>
            <option value="github">{t('GitHub Deployments')}</option>
            <option value="coolify">{t('Coolify')}</option>
          </select>
        </Tooltip>
        <span className="hint s-hint">
          {p.deploySource === 'github' ? t('GitHub deployment_status events (webhook /hooks/github) mark commits as deployed and show the status in the sidebar.')
            : p.deploySource === 'coolify' ? t('Successful deploys of this Coolify app mark commits as deployed and show the status in the sidebar.')
            : p.deploySource === 'webhook' ? t('After each deploy, send the deployed commit:')
            : t('Pick where deploys are reported from. None: no deploy tracking.')}
        </span>
      </div>
      {p.deploySource && <DeployEnvs source={p.deploySource} projectKey={p.key} ro={ro} />}
      <div className="s-row" id="discord">
        <span className="s-label">Discord webhook</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.discordWebhookUrl ?? ''} disabled={!!ro} placeholder={ro ? t('Set by a project admin') : 'https://discord.com/api/webhooks/…'}
            defaultValue={p.discordWebhookUrl ?? ''}
            onBlur={(e) => e.target.value.trim() !== (p.discordWebhookUrl ?? '') && void patch({ discordWebhookUrl: e.target.value.trim() || null })} />
        </Tooltip>
        <span className="hint s-hint">{t('Meeting polls, picked times and reminders are posted to this channel with @here.')}</span>
        {p.discordLastError && <span className="hint s-hint">{t('Last Discord message failed {when}: {error}. Check the webhook URL.', { when: p.discordLastErrorAt ? timeAgo(p.discordLastErrorAt) : '', error: p.discordLastError })}</span>}
      </div>
      <div id="meeting-place" className="s-row">
        <span className="s-label">{t('Meeting place')}</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.meetingLocationUrl} disabled={!!ro} placeholder={t('Teams, Discord or Meet link')}
            defaultValue={p.meetingLocationUrl}
            onBlur={(e) => e.target.value.trim() !== p.meetingLocationUrl && void patch({ meetingLocationUrl: e.target.value.trim() })} />
        </Tooltip>
        <span className="hint s-hint">{t('Default meeting link (Teams, Discord, Meet…) for new meetings and sprint reviews.')}</span>
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
// Daty zawsze dd.mm.rrrr, niezależnie od języka przeglądarki.
const plDate = (iso: string) => new Date(iso).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });

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
    ? t('{name}, {date}', { name: i.usedByName ?? '', date: plDate(i.usedAt!) })
    : i.status === 'expired' ? t('by {name}, expired {date}', { name: i.createdByName ?? '', date: plDate(i.expiresAt) })
    : t('by {name}, expires {date}', { name: i.createdByName ?? '', date: plDate(i.expiresAt) });
  return (
    <div className="s-card" id="invites" style={{ marginTop: 12 }}>
      <div className="s-row s-row-head">
        <span className="grow"><b>{t('Invite link')}</b>
          <div className="hint">{t('One-time link, valid for 7 days. Whoever opens it creates an account and joins this project.')}</div>
        </span>
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
          <input className="input grow" type="password" autoComplete="current-password" disabled={demo} title={reason ?? undefined} placeholder={t('Current password')} aria-label={t('Current password')} value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
      )}
      <div className="s-row">
        <input className="input grow" type="password" autoComplete="new-password" disabled={demo} title={reason ?? undefined} placeholder={t('New password')} aria-label={t('New password')} value={password} onChange={(e) => setPassword(e.target.value)} />
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
  const [label, setLabel] = useState({ name: '', color: '#5e6ad2' });
  if (!c) return null;
  const { meta, ro, refresh } = c;
  return (
    <>
      <div id="labels" className="s-card">
        <div className="s-row s-row-head"><b>{t('Labels')}</b></div>
        <div className="s-row">
          <input type="color" value={label.color} disabled={!!ro} onChange={(e) => setLabel((l) => ({ ...l, color: e.target.value }))} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
          <input className="input grow" placeholder={t('New label')} value={label.name} disabled={!!ro} onChange={(e) => setLabel((l) => ({ ...l, name: e.target.value }))} />
          <Tooltip text={ro}>
            <button className="btn" disabled={!!ro || !label.name.trim()} onClick={() => void api('/api/admin/labels', { method: 'POST', body: label }).then(() => { setLabel({ name: '', color: label.color }); refresh(); })}><Icon.plus size={13} /> {t('Add')}</button>
          </Tooltip>
        </div>
        {meta.labels.map((l) => { const byAi = AI_LABELS.includes(l.name.toLowerCase()); const lock = ro || (byAi ? t('AI analysis finds this label by its name, so it cannot be renamed or deleted. You can change its color.') : null); return (
          <div key={l.id} className="s-row">
            <input type="color" defaultValue={toHex(l.color)} disabled={!!ro} onBlur={(e) => e.target.value !== toHex(l.color) && void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: l.name, color: e.target.value } }).then(refresh)} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
            <input className="input grow" defaultValue={l.name} disabled={!!lock} title={lock ?? undefined} onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: e.target.value.trim(), color: l.color } }).then(refresh)} />
            {byAi && <span className="badge ai" title={t('AI analysis sets this label from the issue type.')}>{t('set by AI')}</span>}
            <Tooltip text={lock}>
              <button className="btn sm danger" disabled={!!lock} onClick={() => void askConfirm({ title: t('Delete label "{name}"?', { name: l.name }), body: t('It will be removed from all issues.') }).then((ok) => { if (ok) void api(`/api/admin/labels/${l.id}`, { method: 'DELETE' }).then(refresh); })}>{t('Delete')}</button>
            </Tooltip>
          </div>
        ); })}
      </div>
      <div id="statuses" className="s-card" style={{ marginTop: 12 }}>
        <div className="s-row s-row-head"><b>{t('Statuses')}</b><span className="hint">{t('Order is the order of columns on the board.')}</span></div>
        {meta.statuses.map((s, idx) => (
          <div key={s.id} className="s-row">
            <Tooltip text={t(s.type)}><span style={{ display: 'inline-flex' }}><StatusIcon status={s} fraction={startedFraction(meta.statuses, s)} /></span></Tooltip>
            <input type="color" defaultValue={toHex(s.color)} disabled={!!ro} onBlur={(e) => e.target.value !== toHex(s.color) && void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, color: e.target.value } }).then(refresh)} style={{ width: 26, height: 26, border: 0, background: 'none' }} />
            <input className="input grow" defaultValue={s.name} disabled={!!ro} onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, name: e.target.value.trim() } }).then(refresh)} />
            <Tooltip text={ro}>
              <select className="input" value={s.role ?? ''} disabled={!!ro} aria-label={t('Status role')}
                onChange={(e) => void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, role: e.target.value || null } }).then(refresh)}>
                <option value="">{t('No special role')}</option>
                <option value="need_info">{t('Need Info (asks a question)')}</option>
                <option value="testing">{t('Testing')}</option>
              </select>
            </Tooltip>
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={!s.hiddenOnBoard} disabled={!!ro} onChange={(e) => void api('/api/admin/statuses', { method: 'PATCH', body: { id: s.id, hiddenOnBoard: !e.target.checked } }).then(refresh)} /> {t('On board')}
            </label>
            <button className="icon-btn" disabled={!!ro || idx === 0} title={ro ?? t('Move up')} onClick={() => void swap(meta.statuses, idx, idx - 1).then(refresh)}>↑</button>
            <button className="icon-btn" disabled={!!ro || idx === meta.statuses.length - 1} title={ro ?? t('Move down')} onClick={() => void swap(meta.statuses, idx, idx + 1).then(refresh)}>↓</button>
          </div>
        ))}
      </div>
    </>
  );
}

const MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;

// Polecenia dla Claude Code są stałe w kodzie (prompts.ts), treść i format analizy ustala skill; projekt wybiera tylko model.
const PROMPTS = [
  { kind: 'analyze', name: t('Analyze'), hint: t('Runs in the background on the computer of whoever clicks it (local runner), read-only.'), model: 'analyzeModel' },
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
  const accounts = useQuery({ queryKey: ['admin-users'], queryFn: () => api<(User & { hasGithub: boolean; hasGoogle: boolean; hasPassword: boolean })[]>('/api/admin/users') });
  const [login, setLogin] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); void qc.invalidateQueries({ queryKey: ['meta'] }); void qc.invalidateQueries({ queryKey: ['project'] }); };
  const saveUser = (body: object) => api('/api/admin/users', { method: 'POST', body }).then(refresh);

  return (
    <div id="accounts-card" className="s-card">
      <div className="s-row s-row-head">
        <input className="input grow" disabled={demo} title={demo ? t('Disabled in the demo') : undefined} placeholder={t('GitHub login or e-mail to allow')} value={login} onChange={(e) => setLogin(e.target.value)} />
        <button className="btn" disabled={demo || !login.trim()} title={demo ? t('Disabled in the demo') : undefined} onClick={() => void saveUser({ login: login.trim() }).then(() => setLogin(''))}><Icon.plus size={13} /> {t('Allow')}</button>
      </div>
      {accounts.data?.map((u) => (
        <div key={u.id} className="s-row" style={u.active ? undefined : { opacity: 0.5 }}>
          <PersonLink userId={u.id}><Avatar user={u} size={22} /></PersonLink>
          <span className="grow"><PersonLink userId={u.id}>{u.name}</PersonLink> {u.id === me?.id && <span className="badge me">{t('You')}</span>}
            <div className="s-meta">
              {[u.hasGithub && 'GitHub', u.hasGoogle && 'Google', u.hasPassword && t('Password')].filter(Boolean).map((m) => <span key={m as string} className="pill ok">{m}</span>)}
              {!u.hasGithub && !u.hasGoogle && !u.hasPassword && <span className="pill waiting">{t('Not logged in yet')}</span>}
            </div>
          </span>
          {/* Login GitHub jest edytowalny, żeby poprawić mapowanie z importu bez dublowania osoby. */}
          <input className="input" style={{ width: 150 }} defaultValue={u.login} disabled={demo} title={demo ? t('Disabled in the demo') : t('GitHub login')}
            onBlur={(e) => {
              const el = e.target, login = el.value.trim();
              if (!login || login === u.login) return;
              void askConfirm({ title: t('Change the login of {name} to {login}?', { name: u.name, login }), body: t('From now on they sign in with this GitHub account.'), action: t('Change login'), danger: false })
                .then((ok) => { if (ok) void saveUser({ id: u.id, login }); else el.value = u.login; });
            }} />
          <Tooltip text={demo ? t('Disabled in the demo') : u.id === me?.id ? t('You cannot remove your own admin role') : t('Workspace admins manage accounts and every project')}>
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={u.isAdmin} disabled={demo || u.id === me?.id} onChange={(e) => {
                const isAdmin = e.target.checked;
                void askConfirm(isAdmin
                  ? { title: t('Make {name} a workspace admin?', { name: u.name }), body: t('They get admin rights in every project and can manage accounts.'), action: t('Make admin'), danger: false }
                  : { title: t('Remove workspace admin from {name}?', { name: u.name }), body: t('They keep access only to the projects they are a member of.'), action: t('Remove admin') })
                  .then((ok) => { if (ok) void saveUser({ id: u.id, login: u.login, isAdmin }); });
              }} /> {t('Admin')}
            </label>
          </Tooltip>
          {/* Zawsze w tym samym miejscu (wyszarzony bez hasła), żeby wiersze się nie rozjeżdżały. */}
          <Tooltip text={demo ? t('Disabled in the demo') : u.hasPassword ? t('Creates a one-time link (24 h) to set a new password and copies it') : t('This account logs in without a password')}>
            <button className="btn sm" disabled={demo || !u.hasPassword} onClick={() => void api<{ url: string }>(`/api/admin/users/${u.id}/reset-link`, { method: 'POST' }).then((r) => copyText(r.url, t('Password link copied')))}>{t('Reset password')}</button>
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

function toHex(c: string) {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : '#888888';
}

/** Kolejka zespołu projektu: online komputer któregokolwiek członka bierze analizy wszystkich (na limitach jego Claude). */
function TeamQueue() {
  const c = useProject();
  const demo = !!useMe().data?.demo;
  const key = useProjectKey();
  const online = useQuery({ queryKey: ['project-agents', key], queryFn: () => api<{ name: string; owner: string; busy: boolean }[]>(`/api/projects/${key}/agents`), enabled: !!c && !demo, refetchInterval: 30_000 });
  if (!c) return null;
  const { p, ro: roBase, patch } = c;
  const ro = roBase ?? (demo ? t('Disabled in the demo') : null);
  return (
    <div className="s-card" id="team-queue" style={{ marginTop: 12 }}>
      <div className="s-row">
        <span className="grow">{t('Team queue')} · {p.name}
          <div className="hint">{t("An online teammate's PC runs analyses for everyone in this project, on that person's Claude subscription limits. The prompt comes from the project template.")}</div>
        </span>
        <Tooltip text={ro}>
          <button className={`switch ${p.agentTeamQueue ? 'on' : ''}`} role="switch" aria-checked={p.agentTeamQueue} aria-label={t('Team queue')}
            disabled={!!ro} style={ro ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} onClick={() => void patch({ agentTeamQueue: !p.agentTeamQueue })} />
        </Tooltip>
      </div>
      {(online.data ?? []).map((a, i) => (
        <div key={i} className="s-row">
          <span className="grow">{a.name || t('Unnamed computer')} · {a.owner}</span>
          {a.busy && <span className="hint">{t('running an analysis')}</span>}
        </div>
      ))}
      {!demo && !(online.data ?? []).length && <div className="s-row"><span className="hint">{t('No computer is online right now.')}</span></div>}
    </div>
  );
}
