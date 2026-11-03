import { useEffect, useState, useSyncExternalStore } from 'react';
import { DateInput, TimeInput } from './DateTime.tsx';
import { askConfirm } from './Confirm.tsx';
import { useQueryClient } from '@tanstack/react-query';
import { api, isInvited, useMe, useMeetings, useMeta, type Meeting, type MeetingSlot, type Vote } from './api.ts';
import { Avatar, Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { linkProps } from './router.ts';
import { toast } from './toast.ts';
import { CurrentProjectBadge, useCurrentProject } from './ProjectSwitcher.tsx';
import { getProjectKey } from './project.ts';
import { PersonLink } from './PersonCard.tsx';
import { useProjectDetail } from './Settings.tsx';
import { locale, t, tn } from './i18n.ts';

// ---------- czas (przeglądarka zespołu jest w czasie polskim) ----------

// Kolor = które spotkanie (stały, z id), obramowanie = rodzaj (pełne, przerywane opcje ankiety, podwójne review).
export const meetingColor = (m: Pick<Meeting, 'id'>) => `var(--project-${(m.id % 7) + 1})`;
const VOTE_COLOR: Record<Vote, string> = { yes: 'var(--success-text)', maybe: 'var(--progress-text)', no: 'var(--danger-text)' };
const VOTE_LABEL: Record<Vote, string> = { yes: t('Yes'), maybe: t('Maybe'), no: t('No') };

export const fmtTime = (iso: string | Date) => new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
/** "Mon 19" / "pon 19": bez przecinka i kropki z polskiego locale, żeby nagłówek kolumny się nie zawijał. */
export const fmtDay = (d: Date | string) => { const x = new Date(d); return `${x.toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '')} ${x.getDate()}`; };
export const fmtDayLong = (d: Date | string) => new Date(d).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
/** Nazwa przycisku dołączania z adresu spotkania (Teams, Discord, Meet, Zoom), bez zgadywania "Discord". */
export function joinLabel(url: string | null | undefined) {
  const host = (() => { try { return new URL(url ?? '').hostname; } catch { return ''; } })();
  if (/teams\.(microsoft|live)\.com$/.test(host)) return t('Join on {app}', { app: 'Teams' });
  if (/discord(app)?\.com$/.test(host)) return t('Join on {app}', { app: 'Discord' });
  if (/meet\.google\.com$/.test(host)) return t('Join on {app}', { app: 'Google Meet' });
  if (/zoom\.us$/.test(host)) return t('Join on {app}', { app: 'Zoom' });
  return t('Join meeting');
}

export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const pad = (n: number) => String(n).padStart(2, '0');
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fromInputs = (date: string, time: string) => new Date(`${date}T${time}`);

/** "Today 16:00 · starts in 45 min" */
export function whenLabel(m: Pick<Meeting, 'startsAt' | 'endsAt'>, now = new Date()) {
  if (!m.startsAt || !m.endsAt) return '';
  const s = new Date(m.startsAt);
  const e = new Date(m.endsAt);
  const day = sameDay(s, now) ? t('Today') : sameDay(s, new Date(now.getTime() + 864e5)) ? t('Tomorrow') : fmtDayLong(s);
  const mins = Math.round((s.getTime() - now.getTime()) / 60000);
  const rel = now >= s && now < e ? t('in progress')
    : mins > 0 && mins < 120 ? t('starts in {n} min', { n: mins })
    : mins >= 120 && mins < 24 * 60 ? t('starts in {n} h', { n: Math.round(mins / 60) }) : '';
  return `${day} ${fmtTime(s)}${rel ? ` · ${rel}` : ''}`;
}

/** Najlepszy termin: yes = 2 pkt, maybe = 1; przy remisie wcześniejszy. Brak głosów = brak wyróżnienia. */
export function bestSlot(slots: MeetingSlot[]) {
  let best: MeetingSlot | null = null;
  let bestScore = 0;
  for (const s of slots) {
    const score = s.votes.reduce((n, v) => n + (v.vote === 'yes' ? 2 : v.vote === 'maybe' ? 1 : 0), 0);
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

export function useCanManageMeeting() {
  const me = useMe().data;
  const project = useCurrentProject();
  return (m: Pick<Meeting, 'createdBy' | 'kind'>) => !!me && (me.isAdmin || project?.role === 'admin' || m.createdBy === me.id || m.kind === 'sprint_review');
}

// ---------- okna ----------

type Dialog = { kind: 'new'; date?: Date } | { kind: 'meeting'; id: number } | null;
let dialog: Dialog = null;
let subs: (() => void)[] = [];
const emit = () => subs.forEach((s) => s());

export function openNewMeeting(date?: Date) { dialog = { kind: 'new', date }; emit(); }
export function openMeeting(id: number) { dialog = { kind: 'meeting', id }; emit(); }
function closeDialog() {
  dialog = null;
  emit();
  // Link z powiadomienia (?meeting=ID) nie otwiera okna drugi raz po odświeżeniu.
  const u = new URL(location.href);
  if (u.searchParams.has('meeting')) { u.searchParams.delete('meeting'); history.replaceState(null, '', u.pathname + u.search); }
}

export function MeetingHost() {
  const d = useSyncExternalStore((fn) => { subs.push(fn); return () => { subs = subs.filter((s) => s !== fn); }; }, () => dialog);
  if (!d) return null;
  return d.kind === 'new' ? <NewMeeting date={d.date} /> : <MeetingDialog id={d.id} />;
}

function Backdrop({ children, width }: { children: React.ReactNode; width: number }) {
  // Esc zamyka okno także wtedy, gdy fokus nie jest w środku (np. po kliknięciu w kartę).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
      <div className="modal meeting-modal" style={{ width }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') closeDialog(); }}>
        {children}
      </div>
    </div>
  );
}

const REMINDERS: { v: number; label: string }[] = [
  { v: 1440, label: t('Day before') }, { v: 60, label: t('1 h before') }, { v: 15, label: t('15 min before') }, { v: 0, label: t('At start') },
];

function ReminderChips({ value, onChange, disabled }: { value: number[]; onChange: (v: number[]) => void; disabled?: string | null }) {
  return (
    <Tooltip text={disabled}>
      <div className="prop-chips">
        {REMINDERS.map((r) => (
          <button key={r.v} className={`prop-chip ${value.includes(r.v) ? 'on' : ''}`} disabled={!!disabled}
            onClick={() => onChange(value.includes(r.v) ? value.filter((x) => x !== r.v) : [...value, r.v])}>{r.label}</button>
        ))}
      </div>
    </Tooltip>
  );
}

/**
 * Kogo zaprosić: domyślnie cały zespół (null). Lista osób pokazuje się dopiero po "Choose people",
 * żeby zwykłe spotkanie nie miało rzędu awatarów. Organizator jest zawsze zaproszony.
 */
function InviteePicker({ value, onChange, organizer, disabled }: {
  value: number[] | null; onChange: (v: number[] | null) => void; organizer: number | null | undefined; disabled?: string | null;
}) {
  const people = (useMeta().data?.users ?? []).filter((u) => u.active && u.id !== organizer);
  const [open, setOpen] = useState(value !== null);
  const toggle = (id: number) => {
    const cur = value ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange(next.length ? next : null);
  };
  return (
    <Tooltip text={disabled}>
      <div className="prop-chips">
        <button className={`prop-chip ${value === null ? 'on' : ''}`} disabled={!!disabled} onClick={() => { onChange(null); setOpen(false); }}>{t('Whole team')}</button>
        {open
          ? people.map((u) => (
            <button key={u.id} className={`prop-chip ${value?.includes(u.id) ? 'on' : ''}`} disabled={!!disabled} onClick={() => toggle(u.id)}>{u.name}</button>
          ))
          : <button className="prop-chip" disabled={!!disabled} onClick={() => setOpen(true)}>{t('Choose people…')}</button>}
      </div>
    </Tooltip>
  );
}

const LOCATION_KEY = () => `meetingLocation:${getProjectKey()}`;

function NewMeeting({ date }: { date?: Date }) {
  const qc = useQueryClient();
  const project = useCurrentProject();
  const start = date ?? (() => { const d = new Date(Date.now() + 864e5); d.setHours(10, 0, 0, 0); return d; })();
  if (date && date.getHours() === 0) start.setHours(10, 0, 0, 0);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'poll' | 'fixed'>('poll');
  const [slots, setSlots] = useState([{ date: dateInput(start), time: timeInput(start), end: timeInput(new Date(start.getTime() + 60 * 60000)) }]);
  // Koniec idzie za początkiem: przesunięcie startu zachowuje długość terminu.
  const length = (s: { date: string; time: string; end: string }) => fromInputs(s.date, s.end).getTime() - fromInputs(s.date, s.time).getTime();
  const setStart = (i: number, v: string) => setSlots((all) => all.map((x, j) => {
    if (j !== i) return x;
    const d = fromInputs(x.date, v);
    const ms = length(x) > 0 ? length(x) : 60 * 60000;
    return { ...x, time: v, end: Number.isNaN(d.getTime()) ? x.end : timeInput(new Date(d.getTime() + ms)) };
  }));
  const defaultPlace = useProjectDetail().data?.meetingLocationUrl ?? '';
  const [typed, setLocation] = useState<string | null>(() => { try { return localStorage.getItem(LOCATION_KEY()); } catch { return null; } });
  // Ostatnio wpisane miejsce wygrywa, inaczej domyślny kanał projektu (Settings › Project).
  const location = typed ?? defaultPlace;
  const [reminders, setReminders] = useState([60, 15, 0]);
  const [invitees, setInvitees] = useState<number[] | null>(null);
  const me = useMe().data;
  const [busy, setBusy] = useState(false);

  const times = slots.map((s) => fromInputs(s.date, s.time)).filter((d) => !Number.isNaN(d.getTime()));
  const missing = !title.trim() ? t('Enter a title') : !times.length || times.length !== slots.length ? t('Fill in the date and time')
    : slots.some((s) => !(length(s) > 0)) ? t('The end must be after the start') : null;
  const submit = async () => {
    if (missing || busy) return;
    setBusy(true);
    try {
      const range = (i: number) => ({ startsAt: times[i].toISOString(), endsAt: new Date(times[i].getTime() + length(slots[i])).toISOString() });
      const body = mode === 'poll'
        ? { title, kind: 'poll', slots: times.map((_, i) => range(i)), locationUrl: location, reminders, attendeeIds: invitees }
        : { title, kind: 'fixed', ...range(0), locationUrl: location, reminders, attendeeIds: invitees };
      await api('/api/meetings', { method: 'POST', body });
      try { localStorage.setItem(LOCATION_KEY(), location); } catch { /* prywatne okno */ }
      await qc.invalidateQueries({ queryKey: ['meetings'] });
      toast(mode === 'poll' ? t('Poll sent') : t('Meeting added'));
      closeDialog();
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Backdrop width={760}>
      <div className="crumbs"><CurrentProjectBadge /> {project?.name} <Icon.chevronRight size={12} /> {t('New meeting')}</div>
      <input className="title" autoFocus placeholder={t('Meeting title')} value={title} onChange={(e) => setTitle(e.target.value)} aria-label={t('Meeting title')}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      <div style={{ display: 'flex', gap: 6, margin: '12px 0 16px' }}>
        <button className={`chip ${mode === 'poll' ? 'on' : ''}`} onClick={() => { setMode('poll'); }}>{t('Poll for a time')}</button>
        <button className={`chip ${mode === 'fixed' ? 'on' : ''}`} onClick={() => { setMode('fixed'); setSlots((s) => s.slice(0, 1)); }}>{t('Fixed time')}</button>
      </div>

      <div className="meeting-form">
        <div className="meeting-label">{mode === 'poll' ? <>{t('Proposed times')} <span className="hint">· {invitees ? t('invited people vote') : t('everyone in {name} votes', { name: project?.name })}</span></> : t('When')}</div>
        <div className="slot-grid">
          {slots.map((s, i) => (
            <div key={i} className="slot-edit">
              <DateInput value={s.date} aria-label={t('Day')} onChange={(v) => setSlots((all) => all.map((x, j) => (j === i ? { ...x, date: v } : x)))} />
              <TimeInput value={s.time} aria-label={t('Start')} onChange={(v) => setStart(i, v)} />
              <span className="hint">–</span>
              <TimeInput value={s.end} aria-label={t('End')} onChange={(v) => setSlots((all) => all.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
              {slots.length > 1 && <button className="icon-btn" aria-label={t('Remove this time')} title={t('Remove')} onClick={() => setSlots((all) => all.filter((_, j) => j !== i))}><Icon.close size={13} /></button>}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {mode === 'poll' && (
            <button className="btn sm" onClick={() => setSlots((all) => {
              const last = all.at(-1)!;
              const next = fromInputs(last.date, last.time);
              next.setDate(next.getDate() + 1);
              return [...all, { date: dateInput(next), time: last.time, end: last.end }];
            })}><Icon.plus size={12} /> {t('Add time')}</button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14, padding: '16px 0' }}>
        <div className="meeting-form">
          <label className="meeting-label" htmlFor="meeting-where">{t('Where')}</label>
          <input id="meeting-where" className="input" placeholder={t('Meeting link (Teams, Discord, Meet…)')} value={location} onChange={(e) => setLocation(e.target.value)} />
        </div>
        <div className="meeting-form">
          <div className="meeting-label">{t('Reminders')}</div>
          <ReminderChips value={reminders} onChange={setReminders} />
        </div>
      </div>

      <div className="meeting-form" style={{ paddingBottom: 16 }}>
        <div className="meeting-label">{t('Who')}</div>
        <InviteePicker value={invitees} onChange={setInvitees} organizer={me?.id} />
      </div>

      <div className="foot">
        <span className="hint">
          {mode === 'poll' && !invitees ? `${t('Everyone in {name} gets the poll.', { name: project?.name })} ` : ''}
          {invitees ? `${t('Only invited people get notified; the rest of the team still sees it in the calendar.')} ` : ''}{t('Reminders go through the channels each person turned on in their settings.')}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>{t('Cancel')}</button>
        <Tooltip text={missing}>
          <button className="btn primary" disabled={!!missing || busy} onClick={() => void submit()}>{mode === 'poll' ? t('Send poll') : t('Add meeting')}</button>
        </Tooltip>
      </div>
    </Backdrop>
  );
}

function MeetingDialog({ id }: { id: number }) {
  const m = useMeetings().data?.find((x) => x.id === id);
  const meetings = useMeetings();
  if (meetings.isLoading) return null;
  if (!m) {
    return (
      <Backdrop width={420}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>{t('Meeting not found')}</div>
        <div className="hint">{t('It may have been cancelled.')}</div>
        <div className="foot" style={{ marginTop: 16 }}><span className="spacer" /><button className="btn" onClick={closeDialog}>{t('Close')}</button></div>
      </Backdrop>
    );
  }
  return m.status === 'polling' ? <PollDialog m={m} /> : <ScheduledDialog m={m} />;
}

function PollDialog({ m }: { m: Meeting }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const meta = useMeta().data;
  const canManage = useCanManageMeeting();
  const best = bestSlot(m.slots);
  const [picked, setPicked] = useState<number | null>(null);
  const first = m.slots[0] ? new Date(m.slots[0].startsAt) : new Date();
  const [suggest, setSuggest] = useState({ date: dateInput(first), time: '', reason: '' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['meetings'] });
  const people = (meta?.users ?? []).filter((u) => u.active && isInvited(m, u.id));
  const others = people.filter((u) => u.id !== me?.id);
  const notInvited = isInvited(m, me?.id) ? null : t('You are not invited to this meeting');
  const name = (uid: number | null) => (uid === me?.id ? t('you') : meta?.users.find((u) => u.id === uid)?.name ?? t('someone'));
  const organizer = name(m.createdBy);
  const isOrganizer = !!me && m.createdBy === me.id;
  const canPick = !!me && (isOrganizer ||canManage({ createdBy: -1, kind: 'poll' }));
  const target = m.slots.find((s) => s.id === picked) ?? best ?? m.slots[0];
  const voters = new Set(m.slots.flatMap((s) => s.votes.map((v) => v.userId))).size;

  const myVote = (s: MeetingSlot) => s.votes.find((v) => v.userId === me?.id)?.vote;
  const myNote = (s: MeetingSlot) => s.votes.find((v) => v.userId === me?.id)?.note ?? '';
  const saveNote = (s: MeetingSlot, note: string) => {
    if (note.trim() !== myNote(s)) void api(`/api/meeting-slots/${s.id}/vote`, { method: 'PUT', body: { vote: 'maybe', note } }).then(refresh);
  };
  const setVote = (s: MeetingSlot, v: Vote) => void api(`/api/meeting-slots/${s.id}/vote`, { method: 'PUT', body: { vote: myVote(s) === v ? null : v } }).then(refresh);
  const addTime = async () => {
    if (!suggest.date || !suggest.time) return;
    await api(`/api/meetings/${m.id}/slots`, { method: 'POST', body: { startsAt: fromInputs(suggest.date, suggest.time).toISOString(), reason: suggest.reason || undefined } });
    setSuggest((s) => ({ ...s, time: '', reason: '' }));
    toast(t('Time added. Everyone gets a ping to vote on it.'));
    await refresh();
  };
  const pick = async () => {
    if (!target) return;
    const when = `${fmtDayLong(target.startsAt)}, ${fmtTime(target.startsAt)}`;
    // Admin, który nie organizuje, wybiera za kogoś: skutek musi być jasny przed zamknięciem ankiety.
    const ok = await askConfirm({
      title: t('Pick {when}?', { when }), action: t('Pick time'), danger: false,
      body: isOrganizer ? t('The poll closes and everyone gets this time.') : t('{name} organizes this poll. It closes for everyone and this time becomes final.', { name: organizer }),
    });
    if (!ok) return;
    await api(`/api/meetings/${m.id}/pick`, { method: 'POST', body: { slotId: target.id } });
    toast(t('Picked {when}', { when: `${fmtDayLong(target.startsAt)}, ${fmtTime(target.startsAt)}` }));
    await refresh();
    closeDialog();
  };
  // Stałe szerokości: nagłówek i wiersze muszą mieć te same kolumny (tabela przewija się w poziomie).
  const cols = pollCols(m.slots.length);

  return (
    <Backdrop width={pollWidth(m.slots.length, 680)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{m.title}</div>
        <div className="hint">
          {organizer[0].toUpperCase() + organizer.slice(1)} {tn(m.slots.filter((s) => s.proposedBy === m.createdBy).length, 'proposed {n} time', 'proposed {n} times')} · {t('anyone can suggest another')}
          {m.locationUrl ? <> · <a href={m.locationUrl} target="_blank" rel="noreferrer">{m.locationUrl.replace(/^https?:\/\//, '')}</a></> : null}
        </div>
      </div>

      <div className="poll-table">
        <div className="poll-row poll-head" style={{ gridTemplateColumns: cols }}>
          <div className="hint">{t('{a} of {b} voted', { a: voters, b: people.length })}</div>
          {m.slots.map((s) => (
            <button key={s.id} className={`poll-cell poll-time ${s.id === best?.id ? 'best' : ''} ${canPick && s.id === target?.id ? 'target' : ''}`}
              disabled={!canPick} title={canPick ? t('Select this time to pick it') : undefined} onClick={() => setPicked(s.id)}>
              <div style={{ fontWeight: 600 }}>{fmtDayLong(s.startsAt)} · {fmtTime(s.startsAt)} {s.id === best?.id && <span className="best-tag">{t('best')}</span>}</div>
              <div className="hint">{s.proposedBy === m.createdBy ? t('proposed by {name}', { name: name(s.proposedBy) }) : t('suggested by {name}', { name: name(s.proposedBy) })}{s.reason ? ` · “${s.reason}”` : ''}</div>
            </button>
          ))}
        </div>
        <VoteRows slots={m.slots} people={others} cols={cols} />
        {me && (
          <div className="poll-row mine" style={{ gridTemplateColumns: cols }}>
            <div className="poll-person" style={{ fontWeight: 600 }}><Avatar user={people.find((u) => u.id === me.id) ?? { id: me.id, name: me.name, avatarUrl: null }} size={20} />{t('You')}</div>
            {m.slots.map((s) => (
              <Tooltip key={s.id} text={notInvited}>
                <div className="poll-cell" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['yes', 'maybe', 'no'] as Vote[]).map((v) => (
                      <button key={v} className={`chip ${myVote(s) === v ? 'on' : ''}`} style={myVote(s) === v ? { borderColor: VOTE_COLOR[v], color: VOTE_COLOR[v] } : undefined}
                        disabled={!!notInvited} onClick={() => setVote(s, v)}>{VOTE_LABEL[v]}</button>
                    ))}
                  </div>
                  {myVote(s) === 'maybe' && (
                    <input className="input" placeholder={t('Why? (optional)')} aria-label={t('Why maybe')} autoFocus={!myNote(s)} defaultValue={myNote(s)}
                      onBlur={(e) => saveNote(s, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                  )}
                </div>
              </Tooltip>
            ))}
          </div>
        )}
      </div>

      <div className="suggest-row">
        <span style={{ fontWeight: 600 }}>{t('Suggest another time')}</span>
        <DateInput aria-label={t('Day')} value={suggest.date} disabled={!!notInvited} onChange={(v) => setSuggest((s) => ({ ...s, date: v }))} />
        <TimeInput aria-label={t('Time')} value={suggest.time} disabled={!!notInvited} onChange={(v) => setSuggest((s) => ({ ...s, time: v }))} />
        <input className="input" placeholder={t('Why? (optional)')} aria-label={t('Reason')} value={suggest.reason} style={{ flex: 1, minWidth: 140 }} disabled={!!notInvited}
          onChange={(e) => setSuggest((s) => ({ ...s, reason: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') void addTime(); }} />
        <Tooltip text={notInvited ?? (suggest.time ? null : t('Pick a day and time'))}>
          <button className="btn sm" disabled={!!notInvited || !suggest.time} onClick={() => void addTime()}>{t('Add')}</button>
        </Tooltip>
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        <span className="hint">{m.attendeeIds ? t('A suggested time becomes a new column; invited people get a ping to vote on it.') : t('A suggested time becomes a new column; everyone gets a Discord ping to vote on it.')}</span>
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>{t('Close')}</button>
        <Tooltip text={canPick ? null : t('Only {name} or a project admin can pick the time', { name: organizer })}>
          <button className={isOrganizer ? 'btn primary' : 'btn'} disabled={!canPick || !target} onClick={() => void pick()}>
            {target ? t('Pick {when}', { when: `${fmtDayLong(target.startsAt)}, ${fmtTime(target.startsAt)}` }) : t('Pick a time')}
          </button>
        </Tooltip>
      </div>
    </Backdrop>
  );
}

/**
 * Jedna reguła dla obu tabel głosów (ankieta i podgląd po wyborze): stałe kolumny, żeby nagłówek i wiersze
 * się zgadzały, a okno rośnie z liczbą terminów do 1100 px; dalej tabela przewija się w poziomie.
 */
const pollCols = (n: number) => `180px repeat(${n}, 210px)`;
const pollWidth = (n: number, min: number) => Math.max(min, Math.min(1100, 230 + n * 212));

/** Głosy innych osób, tylko do odczytu (ankieta w toku i podgląd po wyborze terminu). */
function VoteRows({ slots, people, cols }: { slots: MeetingSlot[]; people: NonNullable<Parameters<typeof Avatar>[0]['user']>[]; cols: string }) {
  return people.map((u) => (
    <div key={u.id} className="poll-row" style={{ gridTemplateColumns: cols }}>
      <div className="poll-person"><PersonLink userId={u.id}><Avatar user={u} size={20} />{u.name}</PersonLink></div>
      {slots.map((s) => {
        const v = s.votes.find((x) => x.userId === u.id)?.vote;
        const note = s.votes.find((x) => x.userId === u.id)?.note;
        // Powód przy "Może" zastępuje samo słowo (ten sam kolor); długi ucinany do 2 linii, cały w dymku.
        return (
          <div key={s.id} className="poll-cell" style={{ color: v ? VOTE_COLOR[v] : 'var(--text-quaternary)', fontWeight: 600 }} title={v === 'maybe' && note ? note : undefined}>
            {v ? (v === 'maybe' && note ? <span className="poll-note">{note}</span> : VOTE_LABEL[v]) : '–'}
          </div>
        );
      })}
    </div>
  ));
}

/** Jak głosowano, zanim wybrano termin; wybrany termin oznaczony jak "target" w ankiecie. */
function PollVotes({ m }: { m: Meeting }) {
  const meta = useMeta().data;
  const voted = (id: number) => m.slots.some((s) => s.votes.some((v) => v.userId === id));
  const people = (meta?.users ?? []).filter((u) => u.active && (isInvited(m, u.id) || voted(u.id)));
  // W tabeli tylko ci, co głosowali; reszta jednym zdaniem pod spodem, żeby okno nie rosło o puste wiersze.
  const voters = people.filter((u) => voted(u.id));
  const silent = people.filter((u) => !voted(u.id));
  const cols = pollCols(m.slots.length);
  const picked = (s: MeetingSlot) => s.startsAt === m.startsAt;
  return (
    <div className="poll-votes" style={{ marginTop: 18 }}>
      <div className="hint" style={{ marginBottom: 8 }}>{t('Poll votes')}</div>
      <div className="poll-table">
        <div className="poll-row poll-head" style={{ gridTemplateColumns: cols }}>
          <div className="hint">{t('{a} of {b} voted', { a: voters.length, b: people.length })}</div>
          {m.slots.map((s) => (
            <div key={s.id} className={`poll-cell poll-time ${picked(s) ? 'target' : ''}`}>
              <div style={{ fontWeight: 600 }}>{fmtDayLong(s.startsAt)} · {fmtTime(s.startsAt)} {picked(s) && <span className="best-tag">{t('picked')}</span>}</div>
            </div>
          ))}
        </div>
        <VoteRows slots={m.slots} people={voters} cols={cols} />
      </div>
      {/* Telefon: zamiast szerokiej tabeli lista "termin -> kto jak", bez przewijania w bok (CSS wybiera wersję). */}
      <div className="poll-list">
        {m.slots.map((s) => (
          <div key={s.id} className={`poll-list-slot ${picked(s) ? 'target' : ''}`}>
            <div style={{ fontWeight: 600 }}>{fmtDayLong(s.startsAt)} · {fmtTime(s.startsAt)} {picked(s) && <span className="best-tag">{t('picked')}</span>}</div>
            {voters.map((u) => {
              const v = s.votes.find((x) => x.userId === u.id);
              return (
                <div key={u.id} className="poll-list-vote">
                  <PersonLink userId={u.id} className="grow"><Avatar user={u} size={18} />{u.name}</PersonLink>
                  <span style={{ color: v ? VOTE_COLOR[v.vote] : 'var(--text-quaternary)', fontWeight: 600 }}>{v ? (v.vote === 'maybe' && v.note ? v.note : VOTE_LABEL[v.vote]) : '–'}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {silent.length > 0 && <div className="hint" style={{ marginTop: 8 }}>{t('Did not vote: {names}', { names: silent.map((u) => u.name).join(', ') })}</div>}
    </div>
  );
}

function ScheduledDialog({ m }: { m: Meeting }) {
  const qc = useQueryClient();
  const meta = useMeta().data;
  const canManage = useCanManageMeeting();
  const ro = canManage(m) ? null : t('Only the organizer or a project admin can change this meeting');
  const roInvite = m.kind === 'sprint_review' ? t('Sprint review is for the whole team') : ro;
  const s = new Date(m.startsAt!);
  const [when, setWhen] = useState({ date: dateInput(s), time: timeInput(s) });
  const [location, setLocation] = useState(m.locationUrl);
  const refresh = () => qc.invalidateQueries({ queryKey: ['meetings'] });
  const patch = (body: object, msg = t('Saved')) => api(`/api/meetings/${m.id}`, { method: 'PATCH', body }).then(() => { toast(msg); return refresh(); });
  const moved = when.date !== dateInput(s) || when.time !== timeInput(s);
  const organizer = m.createdBy ? meta?.users.find((u) => u.id === m.createdBy)?.name : null;
  const me = useMe().data;
  // Admin na cudzym spotkaniu: zmiany trafiają do wszystkich zaproszonych, więc mówimy to wprost i pytamy przy przesunięciu.
  const asAdmin = !ro && m.kind !== 'sprint_review' && !!me && m.createdBy !== me.id && organizer ? organizer : null;
  const move = async () => {
    const to = fromInputs(when.date, when.time).toISOString();
    if (asAdmin && !(await askConfirm({ title: t('Move {name}\'s meeting?', { name: asAdmin }), body: t('Everyone invited sees the new time: {when}.', { when: `${fmtDayLong(to)}, ${fmtTime(to)}` }), action: t('Move'), danger: false }))) return;
    await patch({ startsAt: to }, t('Moved'));
  };

  return (
    <Backdrop width={m.kind === 'poll' && m.slots.length > 0 ? pollWidth(m.slots.length, 560) : 560}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: meetingColor(m) }} />
        <div style={{ fontSize: 18, fontWeight: 600 }}>{m.title}</div>
      </div>
      <div className="hint" style={{ marginBottom: 16 }}>
        {whenLabel(m)} – {fmtTime(m.endsAt!)} · {m.kind === 'sprint_review' ? t('automatic sprint review') : organizer ? t('organized by {name}', { name: organizer }) : t('meeting')}
      </div>
      {asAdmin && <div className="hint" style={{ color: 'var(--warning-text)', marginBottom: 12 }}>{t('This is {name}\'s meeting. You can change it as an admin; every change reaches everyone invited.', { name: asAdmin })}</div>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        <Tooltip text={m.locationUrl ? null : t('No meeting link set for this meeting')}>
          {m.locationUrl
            ? <a className="btn primary" href={m.locationUrl} target="_blank" rel="noreferrer">{joinLabel(m.locationUrl)}</a>
            : <button className="btn primary" disabled>{t('Join meeting')}</button>}
        </Tooltip>
        {m.kind === 'sprint_review' && <a className="btn" {...linkProps('/review')} onClickCapture={closeDialog}>{t('Open sprint review')}</a>}
      </div>

      <div className="meeting-grid">
        <span className="hint">{t('Time')}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <DateInput aria-label={t('Day')} value={when.date} disabled={!!ro} onChange={(v) => setWhen((w) => ({ ...w, date: v }))} />
          <TimeInput aria-label={t('Time')} value={when.time} disabled={!!ro} onChange={(v) => setWhen((w) => ({ ...w, time: v }))} />
          <Tooltip text={ro}>
            <button className="btn sm" disabled={!!ro || !moved} onClick={() => void move()}>{t('Move')}</button>
          </Tooltip>
        </div>
        <label className="hint" htmlFor="meeting-where-edit">{t('Where')}</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input id="meeting-where-edit" className="input" style={{ flex: 1 }} placeholder={t('Meeting link (Teams, Discord, Meet…)')} value={location} disabled={!!ro} onChange={(e) => setLocation(e.target.value)} />
          <Tooltip text={ro}>
            <button className="btn sm" disabled={!!ro || location === m.locationUrl} onClick={() => void patch({ locationUrl: location })}>{t('Save')}</button>
          </Tooltip>
        </div>
        <span className="hint">{t('Reminders')}</span>
        <ReminderChips value={m.reminders} disabled={ro} onChange={(r) => void patch({ reminders: r })} />
        <span className="hint">{t('Who')}</span>
        <InviteePicker value={m.attendeeIds} organizer={m.createdBy} disabled={roInvite} onChange={(v) => void patch({ attendeeIds: v })} />
      </div>
      {m.kind === 'poll' && m.slots.length > 0 && <PollVotes m={m} />}

      <div className="foot" style={{ marginTop: 18 }}>
        <Tooltip text={ro}>
          <button className="btn danger" disabled={!!ro} onClick={() => {
            void askConfirm({ title: t('Cancel "{name}"?', { name: m.title }), body: asAdmin ? t('{name} organizes it. Everyone sees it as cancelled.', { name: asAdmin }) : t('Everyone sees it as cancelled.'), action: t('Cancel meeting') })
              .then((ok) => { if (ok) void api(`/api/meetings/${m.id}`, { method: 'DELETE' }).then(refresh).then(() => { toast(t('Meeting cancelled')); closeDialog(); }); });
          }}>{t('Cancel meeting')}</button>
        </Tooltip>
        <span className="spacer" />
        <button className="btn" onClick={closeDialog}>{t('Close')}</button>
      </div>
    </Backdrop>
  );
}
