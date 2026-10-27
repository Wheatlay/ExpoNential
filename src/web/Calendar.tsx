import { useEffect, useState } from 'react';
import { api, awaitsMyVote, useMe, useMeetings, useMeta, type Meeting } from './api.ts';
import { Avatar, Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { linkProps } from './router.ts';
import { toast } from './toast.ts';
import {
  KIND_COLOR, POLL_COLOR, fmtDay, fmtTime, joinLabel, openMeeting, openNewMeeting, sameDay, whenLabel,
} from './Meetings.tsx';
import { locale, t, tn } from './i18n.ts';

/** Poniedziałek 00:00 tygodnia, w którym jest data. */
function weekStart(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** Odświeżanie "starts in X min" bez przeładowania danych. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

type Item = { key: string; meeting: Meeting; startsAt: Date; endsAt: Date; option: boolean };

/** Na dany dzień: zaplanowane spotkania i terminy z trwających ankiet ("option"). */
function itemsOn(meetings: Meeting[], day: Date): Item[] {
  const out: Item[] = [];
  for (const m of meetings) {
    if (m.status === 'scheduled' && m.startsAt && sameDay(new Date(m.startsAt), day)) {
      out.push({ key: `m${m.id}`, meeting: m, startsAt: new Date(m.startsAt), endsAt: new Date(m.endsAt!), option: false });
    }
    if (m.status === 'polling') {
      for (const s of m.slots) {
        if (sameDay(new Date(s.startsAt), day)) out.push({ key: `s${s.id}`, meeting: m, startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt), option: true });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Tydzień w kolumnach: pon–pt, kreska, pon i wt następnego tygodnia (zamiast weekendu).
 * Z prawej: najbliższe spotkanie, ankiety czekające na mój głos, lista tygodnia.
 */
export function Calendar() {
  const now = useNow();
  const meta = useMeta().data;
  const me = useMe().data;
  const [week, setWeek] = useState(() => weekStart(new Date()));
  const [view, setView] = useState<'week' | 'month'>(() => { try { return localStorage.getItem('calendar.view') === 'month' ? 'month' : 'week'; } catch { return 'week'; } });
  const [month, setMonth] = useState(() => monthStart(new Date()));
  // Starsze tygodnie/miesiące: API domyślnie oddaje 14 dni wstecz, więc dla przeszłości prosimy o więcej.
  const from = view === 'month' ? weekStart(month) : week;
  const meetings = useMeetings(from < addDays(new Date(), -13) ? from : undefined).data ?? [];
  const pickView = (v: 'week' | 'month') => {
    setView(v);
    // Przełączenie trzyma ten sam okres: miesiąc oglądanego tygodnia i odwrotnie.
    if (v === 'month') setMonth(monthStart(week));
    else if (!sameMonth(week, month)) setWeek(weekStart(month));
    try { localStorage.setItem('calendar.view', v); } catch { /* prywatne okno */ }
  };
  const openWeek = (day: Date) => { setWeek(weekStart(day)); pickView('week'); };

  // Link z powiadomienia: /calendar?meeting=12 otwiera to spotkanie (i skacze do jego tygodnia).
  const linked = Number(new URLSearchParams(location.search).get('meeting')) || null;
  const linkedMeeting = meetings.find((m) => m.id === linked);
  useEffect(() => {
    if (!linked || !meetings.length) return;
    const at = linkedMeeting?.startsAt ?? linkedMeeting?.slots[0]?.startsAt;
    if (at) { setWeek(weekStart(new Date(at))); setMonth(monthStart(new Date(at))); }
    openMeeting(linked);
  }, [linked, meetings.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = [0, 1, 2, 3, 4].map((i) => addDays(week, i));
  const nextDays = [7, 8].map((i) => addDays(week, i));

  const scheduled = meetings.filter((m) => m.status === 'scheduled' && m.startsAt);
  const next = scheduled.find((m) => new Date(m.endsAt!) > now);
  const waiting = meetings.filter((m) => awaitsMyVote(m, me?.id));
  const thisWeek = scheduled.filter((m) => new Date(m.startsAt!) >= weekStart(now) && new Date(m.startsAt!) < addDays(weekStart(now), 7));
  const range = `${days[0].getDate()} – ${days[4].toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;
  const isThisWeek = sameDay(week, weekStart(now));

  const copyIcs = async () => {
    const { url } = await api<{ url: string }>('/api/calendar-link');
    try { await navigator.clipboard.writeText(url); } catch { toast(t('Could not copy to the clipboard.'), 'err'); return; }
    toast(t('Calendar link copied. Add it in Google Calendar or Outlook as "From URL".'));
  };

  const column = (day: Date, nextWeek = false) => {
    const today = sameDay(day, now);
    return (
      <div key={day.toISOString()} className={`cal-day ${today ? 'today' : ''} ${nextWeek ? 'next' : ''}`}
        onDoubleClick={(e) => { if (e.target === e.currentTarget) openNewMeeting(day); }}>
        <div className="cal-day-head">{fmtDay(day)} {today ? <span className="hint">{t('today')}</span> : nextWeek ? <span className="hint">{t('next week')}</span> : null}</div>
        {itemsOn(meetings, day).map((it) => <CalendarCard key={it.key} item={it} users={meta?.users ?? []} />)}
      </div>
    );
  };

  return (
    <div className="calendar-page">
      <div className="calendar-main">
        <div className="toolbar">
          <div className="seg">
            <button className={view === 'week' ? 'on' : ''} onClick={() => pickView('week')}>{t('Week')}</button>
            <button className={view === 'month' ? 'on' : ''} onClick={() => pickView('month')}>{t('Month')}</button>
          </div>
          {view === 'week' ? (
            <>
              <button className="icon-btn" aria-label={t('Previous week')} onClick={() => setWeek((w) => addDays(w, -7))}><Icon.chevronRight size={13} className="flip" /></button>
              <button className="icon-btn" aria-label={t('Next week')} onClick={() => setWeek((w) => addDays(w, 7))}><Icon.chevronRight size={13} /></button>
              <span style={{ fontWeight: 600 }}>{range}</span><span className="hint">{t('+ start of next week')}</span>
              {!isThisWeek && <button className="btn sm" onClick={() => setWeek(weekStart(new Date()))}>{t('Today')}</button>}
            </>
          ) : (
            <>
              <button className="icon-btn" aria-label={t('Previous month')} onClick={() => setMonth((m) => addMonths(m, -1))}><Icon.chevronRight size={13} className="flip" /></button>
              <button className="icon-btn" aria-label={t('Next month')} onClick={() => setMonth((m) => addMonths(m, 1))}><Icon.chevronRight size={13} /></button>
              <span style={{ fontWeight: 600 }}>{month.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</span>
              {!sameMonth(month, now) && <button className="btn sm" onClick={() => setMonth(monthStart(new Date()))}>{t('Today')}</button>}
            </>
          )}
          <span className="spacer" />
          <button className="btn sm" onClick={() => void copyIcs()} title={t('Copy a private link to subscribe in Google Calendar or Outlook (read only)')}><Icon.link size={12} /> {t('Subscribe (.ics)')}</button>
          <button className="btn sm primary" onClick={() => openNewMeeting()}><Icon.plus size={12} /> {t('New meeting')}</button>
        </div>
        {view === 'week' ? (
          <div className="cal-grid">
            {days.map((d) => column(d))}
            <div className="cal-sep" />
            {nextDays.map((d) => column(d, true))}
          </div>
        ) : (
          <MonthGrid month={month} meetings={meetings} now={now} onOpenWeek={openWeek} />
        )}
      </div>

      <aside className="props-panel calendar-panel">
        {/* Tylko gdy ktoś czeka na mój głos: wtedy to jedyna rzecz w panelu do zrobienia, więc na samej górze. */}
        {waiting.length > 0 && (
          <div className="props-group">
            <h4>{t('Waiting for your vote')}</h4>
            {waiting.map((m) => {
              const voters = new Set(m.slots.flatMap((s) => s.votes.map((v) => v.userId))).size;
              return (
                <div key={m.id} className="vote-card">
                  <div style={{ fontWeight: 600 }}>{m.title}</div>
                  <div className="hint">{tn(m.slots.length, '{n} option', '{n} options')} · {t('{a} of {b} voted', { a: voters, b: meta?.users.filter((u) => u.active).length ?? '?' })}</div>
                  <button className="btn sm warn" style={{ alignSelf: 'flex-start' }} onClick={() => openMeeting(m.id)}>{t('Vote')}</button>
                </div>
              );
            })}
          </div>
        )}
        <div className="props-group">
          <h4>{t('Next meeting')}</h4>
          {next ? (
            <div className="next-meeting" style={{ '--kind': KIND_COLOR[next.kind] } as React.CSSProperties}>
              <button className="next-title" onClick={() => openMeeting(next.id)}>{next.title}</button>
              <div className="hint">{whenLabel(next, now)}</div>
              <Tooltip text={next.locationUrl ? null : t('No meeting link set for this meeting')}>
                {next.locationUrl
                  ? <a className="btn sm primary" href={next.locationUrl} target="_blank" rel="noreferrer" style={{ alignSelf: 'flex-start' }}>{joinLabel(next.locationUrl)}</a>
                  : <button className="btn sm primary" disabled style={{ alignSelf: 'flex-start' }}>{t('Join meeting')}</button>}
              </Tooltip>
              {next.kind === 'sprint_review' && <a className="hint" {...linkProps('/review')}>{t('Open sprint review')} ›</a>}
            </div>
          ) : <div className="hint">{t('Nothing planned. Sprint reviews appear here automatically.')}</div>}
        </div>
        {thisWeek.length > 0 && (
          <div className="props-group">
            <h4>{t('This week')}</h4>
            {thisWeek.map((m) => (
              <button key={m.id} className="prop week-item" onClick={() => openMeeting(m.id)}>
                <span className="dot" style={{ background: KIND_COLOR[m.kind] }} />
                {new Date(m.startsAt!).toLocaleDateString(locale, { weekday: 'short' })} {fmtTime(m.startsAt!)} · {m.title}
              </button>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/**
 * Miesiąc w siatce pon–nd (pełne tygodnie). W dniu do 3 pozycji, reszta jako "+N more".
 * Klik w numer dnia otwiera jego tydzień, dwuklik w tło dnia zakłada spotkanie, klik w pozycję otwiera spotkanie.
 */
function MonthGrid({ month, meetings, now, onOpenWeek }: { month: Date; meetings: Meeting[]; now: Date; onOpenWeek: (d: Date) => void }) {
  const first = weekStart(month);
  const weeks = Math.ceil(((month.getTime() - first.getTime()) / 864e5 + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));
  return (
    <div className="cal-month">
      {[t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat'), t('Sun')].map((d) => <div key={d} className="cal-month-dow">{d}</div>)}
      {cells.map((day) => {
        const items = itemsOn(meetings, day);
        const out = !sameMonth(day, month);
        return (
          <div key={day.toISOString()} className={`cal-month-day ${out ? 'out' : ''} ${sameDay(day, now) ? 'today' : ''} ${day.getDay() % 6 === 0 ? 'weekend' : ''}`}
            title={t('Double-click to plan a meeting')} onDoubleClick={(e) => { if (e.target === e.currentTarget) openNewMeeting(day); }}>
            <button className="cal-month-num" title={t('Open this week')} onClick={() => onOpenWeek(day)}>{day.getDate()}</button>
            {items.slice(0, 3).map((it) => (
              <button key={it.key} className={`cal-month-item ${it.option ? 'option' : ''}`}
                style={{ '--kind': it.option ? POLL_COLOR : KIND_COLOR[it.meeting.kind] } as React.CSSProperties}
                title={`${fmtTime(it.startsAt)} ${it.meeting.title}${it.option ? ` ${t('(poll option)')}` : ''}`}
                onClick={(e) => { e.stopPropagation(); openMeeting(it.meeting.id); }}>
                <span className="dot" />{fmtTime(it.startsAt)} {it.meeting.title}{it.option ? ' ?' : ''}
              </button>
            ))}
            {items.length > 3 && <span className="hint cal-month-more">{t('+{n} more', { n: items.length - 3 })}</span>}
          </div>
        );
      })}
    </div>
  );
}

function CalendarCard({ item, users }: { item: Item; users: { id: number; name: string; avatarUrl: string | null; active: boolean }[] }) {
  const m = item.meeting;
  const color = item.option ? POLL_COLOR : KIND_COLOR[m.kind];
  return (
    <button className={`cal-card ${item.option ? 'option' : ''}`} style={{ '--kind': color } as React.CSSProperties} onClick={() => openMeeting(m.id)}>
      <div className="cal-card-time">{item.option ? `${fmtTime(item.startsAt)} · ${t('option')}` : `${fmtTime(item.startsAt)} – ${fmtTime(item.endsAt)}`}</div>
      <div className="cal-card-title">{m.title}{item.option ? ' ?' : ''}</div>
      {!item.option && (
        <div className="cal-card-people">
          {users.filter((u) => u.active).slice(0, 6).map((u) => <Avatar key={u.id} user={u} size={18} />)}
        </div>
      )}
    </button>
  );
}
