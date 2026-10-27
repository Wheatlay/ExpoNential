import { useEffect, useState, type ReactNode } from 'react';
import { TimeInput } from './DateTime.tsx';
import { askConfirm } from './Confirm.tsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, useMe, useMeta, useSprints, type User } from './api.ts';
import { useProjectKey } from './project.ts';
import { ProjectBadge } from './ProjectSwitcher.tsx';
import { NotificationSettings } from './Notifications.tsx';
import { Avatar, Icon, StatusIcon, startedFraction } from './icons.tsx';
import { toast } from './toast.ts';
import { timeAgo } from './time.ts';
import { Tooltip } from './menu.tsx';
import { agentHere, agentInstallCommand } from './startWork.ts';
import { lang, setLang, t, type Lang } from './i18n.ts';

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
      { id: 'appearance', name: t('Appearance'), render: () => <Appearance /> },
      { id: 'notifications', name: t('Notifications'), render: () => <NotificationSettings /> },
      { id: 'claude', name: 'Claude Code', render: () => <ClaudeConnect /> },
    ] },
    { name: p ? <span className="settings-nav-project"><ProjectBadge project={p} size={14} /> {p.name}</span> : t('Project'), items: [
      { id: 'project', name: t('General'), render: () => <ProjectGeneral /> },
      { id: 'people', name: t('People'), render: () => <ProjectPeople /> },
      { id: 'labels', name: t('Labels and statuses'), render: () => <ProjectLabelsStatuses /> },
      { id: 'integrations', name: t('Integrations'), render: () => <ProjectIntegrations /> },
      { id: 'prompts', name: t('AI prompts'), render: () => <ProjectPrompts /> },
    ] },
    ...(me?.isAdmin ? [{ name: t('Workspace'), items: [{ id: 'accounts', name: t('Accounts'), render: () => <Accounts /> }] }] : []),
  ];
  const all = groups.flatMap((g) => g.items);
  const hash = useHash();
  const current = all.find((s) => s.id === hash) ?? all[0];
  return (
    <div className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('Settings')}>
          <h2>{t('Settings')}</h2>
          {groups.map((g, i) => (
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
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const [theme, setT] = useState<Theme>((document.documentElement.dataset.theme as Theme) ?? 'oled');
  return (
    <div className="s-card">
      <div className="s-row">
        <span className="grow">{t('Theme')}</span>
        <div className="seg">
          {(['dark', 'oled', 'light'] as Theme[]).map((th) => (
            <button key={th} className={theme === th ? 'on' : ''} onClick={() => { setTheme(th); setT(th); }}>
              {{ dark: t('Dark'), oled: t('OLED black'), light: t('Light') }[th]}
            </button>
          ))}
        </div>
      </div>
      <div className="s-row">
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
function ClaudeConnect() {
  const qc = useQueryClient();
  const me = useMe().data;
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<{ id: number; name: string; createdAt: string; lastUsedAt: string | null }[]>('/api/tokens'), enabled: !!me && !me.demo });
  const agentList = useQuery({ queryKey: ['agents'], queryFn: () => api<{ id: string; name: string; lastSeenAt: string | null; busy: boolean; online: boolean }[]>('/api/agents'), enabled: !!me && !me.demo && !!me.localAgentAt });
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
  const copy = (c: string) => void navigator.clipboard.writeText(c).then(() => toast(t('Copied. Paste it into PowerShell.')));
  const createCmd = async () => {
    const r = await api<{ token: string }>('/api/tokens', { method: 'POST', body: { name: t('Claude Code, {date}', { date: new Date().toLocaleDateString() }) } });
    const c = agentInstallCommand(r.token);
    setCmd(c);
    copy(c);
    void qc.invalidateQueries({ queryKey: ['tokens'] });
  };
  const demo = !!me?.demo;
  const installed = !!me?.localAgentAt;
  const update = agentInstallCommand();
  return (
    <>
      <p className="hint settings-lead">{t('One PowerShell command connects this computer to the tracker, for every Claude Code account: AI skills, work log in issues and Analyze in the background.')}</p>
      <div className="s-card">
        <div className="s-row">
          <span className={`step-dot${installed ? ' done' : ''}`}>{installed ? <Icon.check size={12} /> : <Icon.sparkle size={12} />}</span>
          <span className="grow">
            <b>{installed ? t('Connected') : t('Not connected')}</b>{' '}
            <span className="hint">{installed ? t('Installed {when}.', { when: timeAgo(me!.localAgentAt!) }) : t('Analyze only marks issues until this computer is connected.')}</span>
          </span>
          {installed
            ? <button className="btn" disabled={demo} onClick={() => void createCmd()} title={demo ? t('Disabled in the demo') : t('A new computer, or Claude Code without the tracker connection')}>{t('Connect another computer')}</button>
            : <button className="btn primary" disabled={demo} title={demo ? t('Disabled in the demo') : undefined} onClick={() => void createCmd()}>{t('Create install command')}</button>}
        </div>
        {cmd && (
          <div className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <span className="hint">{t("Copied. Paste it into PowerShell and press Enter. It contains a new token, so it won't be shown again.")}</span>
            <div className="token-box">{cmd}</div>
          </div>
        )}
        {installed && (
          <div className="s-row">
            <span className="hint grow">{t('Update or new project/clone: run this again.')}</span>
            <code className="input" style={{ display: 'flex', alignItems: 'center', height: 30, overflowX: 'auto', whiteSpace: 'nowrap', maxWidth: '100%' }}>{update}</code>
            <button className="btn" onClick={() => copy(update)}><Icon.copy size={13} /> {t('Copy')}</button>
            <button className="btn" title={t('Removes it from this computer')} onClick={() => void navigator.clipboard.writeText(update.replace('install.ps1', 'uninstall.ps1')).then(() => toast(t('Uninstall command copied. Paste it into PowerShell.')))}>{t('Uninstall')}</button>
          </div>
        )}
      </div>
      {installed && !demo && (
        <div className="s-card" style={{ marginTop: 12 }}>
          <div className="s-row s-row-head"><b>{t('Your computers')}</b><span className="hint">{t('A computer with the agent picks up analyses requested from your phone.')}</span></div>
          {(agentList.data ?? []).map((a) => (
            <div key={a.id} className="s-row">
              <span className="grow">{a.name || t('Unnamed computer')}</span>
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
        <div className="s-card" style={{ marginTop: 12 }}>
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
  id: number; key: string; name: string; color: string; discordWebhookUrl: string | null; meetingLocationUrl: string;
  sprintLengthDays: number; reviewTime: string; reviewMinutes: number;
  promptStart: string; promptAnalyze: string; promptClose: string; promptDeep: string; analyzeModel: string; deepModel: string;
  githubRepo: string; deployBranch: string; deploySource: '' | 'webhook' | 'github' | 'coolify'; deploySourceRef: string;
  defaultPrompts: { start: string; analyze: string; close: string; deep: string };
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

function ProjectGeneral() {
  const c = useProject();
  const sprintData = useSprints().data;
  const [days, setDays] = useState<number | null>(null);
  if (!c) return null;
  const { p, ro, patch, qc } = c;
  return (
    <div className="s-card">
      <div className="s-row">
        <span className="s-label">{t('Name')}</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.name} defaultValue={p.name} disabled={!!ro}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.name && void patch({ name: e.target.value.trim() })} />
        </Tooltip>
        <Tooltip text={ro}>
          <input type="color" key={p.color} defaultValue={toHex(p.color)} disabled={!!ro} aria-label={t('Project color')}
            onBlur={(e) => e.target.value !== toHex(p.color) && void patch({ color: e.target.value })} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
        </Tooltip>
      </div>
      <div className="s-row">
        <span className="s-label">{t('Sprint length')}</span>
        {/* Zapis po wyjściu z pola, jak pozostałe pola Ustawień. */}
        <Tooltip text={ro}>
          <input className="input" type="number" min={1} max={90} style={{ width: 80 }} disabled={!!ro} value={days ?? sprintData?.lengthDays ?? p.sprintLengthDays}
            onChange={(e) => setDays(Number(e.target.value))}
            onBlur={() => days != null && days >= 1 && days !== p.sprintLengthDays && void patch({ sprintLengthDays: days }, t('Saved. Applies to the next sprint.')).then(() => { void qc.invalidateQueries({ queryKey: ['sprints'] }); setDays(null); })} />
        </Tooltip>
        <span className="hint grow">{t('days. A new sprint starts by itself when the current one ends.')}</span>
      </div>
      <div className="s-row">
        <span className="s-label">{t('Sprint review')}</span>
        <span className="hint">{t('last working day at')}</span>
        <Tooltip text={ro}>
          <TimeInput value={p.reviewTime} disabled={!!ro} aria-label={t('Sprint review time')} onChange={(v) => void patch({ reviewTime: v })} />
        </Tooltip>
        <span className="hint">{t('for')}</span>
        <Tooltip text={ro}>
          <input className="input" type="number" min={5} max={480} step={5} key={p.reviewMinutes} defaultValue={p.reviewMinutes} disabled={!!ro} style={{ width: 80 }}
            onBlur={(e) => Number(e.target.value) !== p.reviewMinutes && void patch({ reviewMinutes: Number(e.target.value) })} />
        </Tooltip>
        <span className="hint">min</span>
      </div>
    </div>
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
      <div className="s-row">
        <span className="s-label">{t('GitHub repo')}</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.githubRepo} disabled={!!ro} placeholder="owner/name" defaultValue={p.githubRepo}
            onBlur={(e) => e.target.value.trim() !== p.githubRepo && void patch({ githubRepo: e.target.value.trim() })} />
        </Tooltip>
        <span className="hint s-hint">{t('Analyze runs Claude in this repo, and only its commits are linked to {key} issues. After a change, reinstall local analysis.', { key: p.key })}</span>
      </div>
      <div className="s-row">
        <span className="s-label">{t('Deploys')}</span>
        <Tooltip text={ro}>
          <input className="input" style={{ width: 130 }} key={p.deployBranch} disabled={!!ro} placeholder={t('branch')} defaultValue={p.deployBranch} aria-label={t('Deploy branch')}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== p.deployBranch && void patch({ deployBranch: e.target.value.trim() })} />
        </Tooltip>
        <Tooltip text={ro}>
          <select className="input" value={p.deploySource} disabled={!!ro} aria-label={t('Deploy status source')}
            onChange={(e) => void patch({ deploySource: e.target.value as ProjectDetail['deploySource'], deploySourceRef: '' })}>
            <option value="">{t('None')}</option>
            <option value="webhook">{t('Webhook')}</option>
            <option value="github">{t('GitHub Deployments')}</option>
            <option value="coolify">{t('Coolify')}</option>
          </select>
        </Tooltip>
        {p.deploySource === 'github' && (
          <Tooltip text={ro}>
            <input className="input grow" key={p.deploySourceRef} disabled={!!ro} placeholder={t('Environment (optional)')} defaultValue={p.deploySourceRef} aria-label={t('Environment (optional)')}
              onBlur={(e) => e.target.value.trim() !== p.deploySourceRef && void patch({ deploySourceRef: e.target.value.trim() })} />
          </Tooltip>
        )}
        {p.deploySource === 'coolify' && (
          <Tooltip text={ro}>
            <input className="input grow" key={p.deploySourceRef} disabled={!!ro} placeholder={t('Coolify application UUID')} defaultValue={p.deploySourceRef} aria-label={t('Coolify application UUID')}
              onBlur={(e) => e.target.value.trim() !== p.deploySourceRef && void patch({ deploySourceRef: e.target.value.trim() })} />
          </Tooltip>
        )}
        <span className="hint s-hint">
          {p.deploySource === 'webhook'
            ? <>{t('After each deploy, send the deployed commit:')} <code>{`curl -X POST ${location.origin}/hooks/deploy -H "X-Webhook-Secret: …" -d '{"project":"${p.key}","sha":"…"}'`}</code></>
            : p.deploySource === 'github' ? t('GitHub deployment_status events (webhook /hooks/github) mark commits as deployed and show the status in the sidebar.')
            : p.deploySource === 'coolify' ? t('Successful deploys of this Coolify app mark commits as deployed and show the status in the sidebar.')
            : t('Pick where deploys are reported from. None: no deploy tracking.')}
        </span>
      </div>
      <div className="s-row">
        <span className="s-label">Discord webhook</span>
        <Tooltip text={ro}>
          <input className="input grow" key={p.discordWebhookUrl ?? ''} disabled={!!ro} placeholder={ro ? t('Set by a project admin') : 'https://discord.com/api/webhooks/…'}
            defaultValue={p.discordWebhookUrl ?? ''}
            onBlur={(e) => e.target.value.trim() !== (p.discordWebhookUrl ?? '') && void patch({ discordWebhookUrl: e.target.value.trim() || null })} />
        </Tooltip>
        <span className="hint s-hint">{t('Meeting polls, picked times and reminders are posted to this channel with @here.')}</span>
      </div>
      <div className="s-row">
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
    <div className="s-card">
      <div className="s-row">
        <input className="input grow" placeholder={t('GitHub login to add')} value={login} disabled={!!ro} onChange={(e) => setLogin(e.target.value)} />
        <Tooltip text={ro}>
          <button className="btn" disabled={!!ro || !login.trim()} onClick={() => void api(`/api/projects/${p.key}/members`, { method: 'POST', body: { login: login.trim() } }).then(() => { setLogin(''); toast(t('Added. They can log in with GitHub.')); refresh(); })}><Icon.plus size={13} /> {t('Add')}</button>
        </Tooltip>
      </div>
      {p.members.map((u) => {
        const lastAdmin = u.role === 'admin' && admins === 1;
        return (
          <div key={u.id} className="s-row" style={u.active ? undefined : { opacity: 0.5 }}>
            <Avatar user={u} size={22} />
            <span className="grow">{u.name} <span className="hint">@{u.login}</span></span>
            <Tooltip text={ro ?? (lastAdmin ? t('A project needs at least one admin') : null)}>
              <div className="seg">
                {(['member', 'admin'] as const).map((r) => (
                  <button key={r} className={u.role === r ? 'on' : ''} disabled={!!ro || lastAdmin}
                    onClick={() => u.role !== r && void api(`/api/projects/${p.key}/members`, { method: 'POST', body: { login: u.login, role: r } }).then(refresh)}>
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
      <div className="s-card">
        <div className="s-row s-row-head"><b>{t('Labels')}</b></div>
        <div className="s-row">
          <input type="color" value={label.color} disabled={!!ro} onChange={(e) => setLabel((l) => ({ ...l, color: e.target.value }))} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
          <input className="input grow" placeholder={t('New label')} value={label.name} disabled={!!ro} onChange={(e) => setLabel((l) => ({ ...l, name: e.target.value }))} />
          <Tooltip text={ro}>
            <button className="btn" disabled={!!ro || !label.name.trim()} onClick={() => void api('/api/admin/labels', { method: 'POST', body: label }).then(() => { setLabel({ name: '', color: label.color }); refresh(); })}><Icon.plus size={13} /> {t('Add')}</button>
          </Tooltip>
        </div>
        {meta.labels.map((l) => (
          <div key={l.id} className="s-row">
            <input type="color" defaultValue={toHex(l.color)} disabled={!!ro} onBlur={(e) => e.target.value !== toHex(l.color) && void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: l.name, color: e.target.value } }).then(refresh)} style={{ width: 30, height: 30, border: 0, background: 'none' }} />
            <input className="input grow" defaultValue={l.name} disabled={!!ro} onBlur={(e) => e.target.value.trim() && e.target.value !== l.name && void api('/api/admin/labels', { method: 'POST', body: { id: l.id, name: e.target.value.trim(), color: l.color } }).then(refresh)} />
            {AI_LABELS.includes(l.name.toLowerCase()) && <span className="badge ai" title={t('AI analysis sets this label from the issue type. Renamed or deleted, it is created again.')}>{t('set by AI')}</span>}
            <Tooltip text={ro}>
              <button className="btn sm danger" disabled={!!ro} onClick={() => void askConfirm({ title: t('Delete label "{name}"?', { name: l.name }), body: t('It will be removed from all issues.') }).then((ok) => { if (ok) void api(`/api/admin/labels/${l.id}`, { method: 'DELETE' }).then(refresh); })}>{t('Delete')}</button>
            </Tooltip>
          </div>
        ))}
      </div>
      <div className="s-card" style={{ marginTop: 12 }}>
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

const PROMPTS = [
  { kind: 'start', field: 'promptStart', name: t('Start work'), hint: t('Opens a new Claude Code tab in VS Code with this text typed in.') },
  { kind: 'analyze', field: 'promptAnalyze', name: t('Analyze'), hint: t('Runs in the background on the computer of whoever clicks it (local runner), read-only.'), model: 'analyzeModel' },
  { kind: 'deep', field: 'promptDeep', name: t('Deep'), hint: t('Added to the end of Analyze when someone clicks Deep.'), model: 'deepModel' },
  { kind: 'close', field: 'promptClose', name: t('Close'), hint: t('"Close in Claude" in the Move to Done dialog.') },
] as const;

/** Polecenia dla Claude Code z guzików trackera: szablony projektu, edytuje admin projektu. */
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
      <p className="hint settings-lead">{t('What the tracker buttons type into Claude Code for this project. The agent fetches the full issue (description, analysis, decisions) by itself. What it may do is fixed in the local script, not here.')}</p>
      <div className="s-card">
        {PROMPTS.map((x) => {
          const value = p[x.field];
          const def = p.defaultPrompts[x.kind];
          return (
            <div key={x.kind} className="s-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <b>{x.name}</b><span className="hint grow">{x.hint}</span>
                {'model' in x && (
                  // Aliasy Claude Code: zawsze najnowsza wersja danego modelu. Wybór równy domyślnemu zapisujemy jako pusty.
                  <Tooltip text={ro ?? t('Model for this analysis')}>
                    <div className="seg" aria-label={t('Model')}>
                      {MODELS.map((m) => (
                        <button key={m} disabled={!!ro} className={(p[x.model] || p.defaultModels[x.kind]) === m ? 'on' : ''}
                          onClick={() => { const v = m === p.defaultModels[x.kind] ? '' : m; if (v !== p[x.model]) void save(x.model, v); }}>{m[0].toUpperCase() + m.slice(1)}</button>
                      ))}
                    </div>
                  </Tooltip>
                )}
                {value && <Tooltip text={ro}><button className="btn sm" disabled={!!ro} onClick={() => void save(x.field, '')}>{t('Reset to default')}</button></Tooltip>}
              </div>
              <Tooltip text={ro}>
                <textarea className="input" key={value} disabled={!!ro} rows={Math.min(12, (value || def).split('\n').length + 1)}
                  defaultValue={value || def} style={{ width: '100%', height: 'auto', padding: '8px 10px', lineHeight: 1.45, fontFamily: 'var(--font-mono, monospace)', fontSize: 12, resize: 'vertical' }}
                  onBlur={(e) => { const v = e.target.value.trim() === def.trim() ? '' : e.target.value; if (v !== value) void save(x.field, v); }} />
              </Tooltip>
            </div>
          );
        })}
        {/* {description} {analysis} {comments} dalej działają w starych szablonach, ale nie podpowiadamy ich: agent pobiera zgłoszenie sam. */}
        <div className="s-row"><span className="hint">{t('Placeholders:')} <code>{'{id}'}</code> <code>{'{title}'}</code></span></div>
      </div>
    </>
  );
}

/** Konta w całym trackerze (kto może się zalogować przez GitHub, kto jest adminem globalnym). */
function Accounts() {
  const me = useMe().data;
  const demo = !!me?.demo;
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['admin-users'], queryFn: () => api<User[]>('/api/admin/users') });
  const [login, setLogin] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['admin-users'] }); void qc.invalidateQueries({ queryKey: ['meta'] }); void qc.invalidateQueries({ queryKey: ['project'] }); };
  const saveUser = (body: object) => api('/api/admin/users', { method: 'POST', body }).then(refresh);

  return (
    <div className="s-card">
      <div className="s-row">
        <input className="input grow" disabled={demo} title={demo ? t('Disabled in the demo') : undefined} placeholder={t('GitHub login to allow (joins the current project)')} value={login} onChange={(e) => setLogin(e.target.value)} />
        <button className="btn" disabled={demo || !login.trim()} title={demo ? t('Disabled in the demo') : undefined} onClick={() => void saveUser({ login: login.trim() }).then(() => setLogin(''))}><Icon.plus size={13} /> {t('Allow')}</button>
      </div>
      {accounts.data?.map((u) => (
        <div key={u.id} className="s-row" style={u.active ? undefined : { opacity: 0.5 }}>
          <Avatar user={u} size={22} />
          <span className="grow">{u.name}</span>
          {/* Login GitHub jest edytowalny, żeby poprawić mapowanie z importu bez dublowania osoby. */}
          <input className="input" style={{ width: 150 }} defaultValue={u.login} disabled={demo} title={demo ? t('Disabled in the demo') : t('GitHub login')}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== u.login && void saveUser({ id: u.id, login: e.target.value.trim() })} />
          <Tooltip text={demo ? t('Disabled in the demo') : u.id === me?.id ? t('You cannot remove your own admin role') : t('Workspace admins can create projects and manage accounts')}>
            <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={u.isAdmin} disabled={demo || u.id === me?.id} onChange={(e) => void saveUser({ id: u.id, login: u.login, isAdmin: e.target.checked })} /> {t('Admin')}
            </label>
          </Tooltip>
          <Tooltip text={demo ? t('Disabled in the demo') : u.id === me?.id ? t('You cannot deactivate yourself') : null}>
            <button className="btn sm" disabled={demo || u.id === me?.id} onClick={() => void saveUser({ id: u.id, login: u.login, active: !u.active })}>{u.active ? t('Deactivate') : t('Activate')}</button>
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
