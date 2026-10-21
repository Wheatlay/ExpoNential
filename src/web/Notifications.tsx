import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, awaitsMyVote, useMe, useMeetings, useNotifySettings, type NotifySettings } from './api.ts';
import { Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { toast } from './toast.ts';
import { useNow } from './Calendar.tsx';
import { KIND_COLOR, fmtTime, openMeeting } from './Meetings.tsx';
import { disablePush, enablePush, pushPermission, pushSupported, refreshPush } from './push.ts';
import { t, tn } from './i18n.ts';

const DISMISSED = 'dismissedMeetingBanners';
const readDismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]'); } catch { return []; } };

/**
 * Baner nad widokami: spotkanie za ≤ 15 min albo trwające (z "Join") i ankieta czekająca na mój głos.
 * Liczony z listy spotkań, więc działa też po przegapionym zdarzeniu SSE. Wyłączany w Settings (in-app).
 */
export function MeetingBanner() {
  const now = useNow(20_000);
  const me = useMe().data;
  const settings = useNotifySettings().data;
  const meetings = useMeetings().data ?? [];
  const [dismissed, setDismissed] = useState(readDismissed);
  if (settings && !settings.inApp) return null;
  const dismiss = (key: string) => {
    const next = [key, ...dismissed].slice(0, 50);
    setDismissed(next);
    try { localStorage.setItem(DISMISSED, JSON.stringify(next)); } catch { /* prywatne okno */ }
  };
  const soon = meetings.filter((m) => m.status === 'scheduled' && m.startsAt && m.endsAt
    && new Date(m.startsAt).getTime() - 15 * 60_000 <= now.getTime() && new Date(m.endsAt) > now
    && !dismissed.includes(`m${m.id}:${m.startsAt}`));
  const polls = meetings.filter((m) => awaitsMyVote(m, me?.id) && !dismissed.includes(`p${m.id}`));
  if (!soon.length && !polls.length) return null;

  return (
    <div className="meeting-banners">
      {soon.map((m) => {
        const mins = Math.round((new Date(m.startsAt!).getTime() - now.getTime()) / 60000);
        return (
          <div key={m.id} className="meeting-banner" style={{ '--kind': KIND_COLOR[m.kind] } as React.CSSProperties}>
            <span className="pulse" />
            <button className="banner-text" onClick={() => openMeeting(m.id)}>
              <div style={{ fontWeight: 600 }}>{m.title} {mins > 0 ? t('starts in {n} min', { n: mins }) : t('is starting now')}</div>
              <div className="hint">{fmtTime(m.startsAt!)}{m.locationUrl ? ' · Discord' : ''}</div>
            </button>
            <Tooltip text={m.locationUrl ? null : t('No meeting link set for this meeting')}>
              {m.locationUrl
                ? <a className="btn sm primary" href={m.locationUrl} target="_blank" rel="noreferrer">{t('Join')}</a>
                : <button className="btn sm primary" disabled>{t('Join')}</button>}
            </Tooltip>
            <button className="btn sm" onClick={() => dismiss(`m${m.id}:${m.startsAt}`)}>{t('Dismiss')}</button>
          </div>
        );
      })}
      {polls.map((m) => (
        <div key={`p${m.id}`} className="meeting-banner poll">
          <button className="banner-text" onClick={() => openMeeting(m.id)}>
            <div style={{ fontWeight: 600, color: 'var(--warning-text)' }}>{t('Vote')}: {m.title}</div>
            <div className="hint">{tn(m.slots.length, '{n} option', '{n} options')} · {t('pick the times that work for you')}</div>
          </button>
          <button className="btn sm warn" onClick={() => openMeeting(m.id)}>{t('Vote')}</button>
          <button className="btn sm" onClick={() => dismiss(`p${m.id}`)}>{t('Dismiss')}</button>
        </div>
      ))}
    </div>
  );
}

/**
 * Prośba o zgodę na powiadomienia: tylko raz, przy pierwszym wejściu (flaga na serwerze).
 * Najpierw nasze okno z wyjaśnieniem, dopiero potem systemowe pytanie przeglądarki.
 */
export function NotifyPrompt() {
  const qc = useQueryClient();
  const s = useNotifySettings().data;
  const [busy, setBusy] = useState(false);
  // Zgoda już jest (np. inna karta, nowa subskrypcja po zalogowaniu): po cichu odświeżamy push.
  useEffect(() => { if (s?.pushKey && s.push) void refreshPush(s.pushKey); }, [s?.pushKey, s?.push]);
  const show = !!s && !s.notifyPromptShown && !!s.pushKey && pushPermission() === 'default';
  if (!show) return null;
  const done = async (patch: Partial<NotifySettings>) => {
    const next = await api<NotifySettings>('/api/notify-settings', { method: 'PUT', body: { notifyPromptShown: true, ...patch } });
    qc.setQueryData<NotifySettings>(['notify-settings'], (old) => (old ? { ...old, ...next } : old));
  };
  const turnOn = async () => {
    setBusy(true);
    const r = await enablePush(s!.pushKey!).catch(() => 'denied' as const);
    await done({ push: r === 'ok' });
    setBusy(false);
    toast(r === 'ok' ? t('Notifications are on') : t('The browser blocked notifications. You can allow them later in Settings.'), r === 'ok' ? 'ok' : 'warn');
  };
  return (
    <div className="notify-prompt" role="dialog" aria-label={t('Turn on notifications')}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span className="notify-icon"><Icon.bell size={16} /></span>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('Turn on notifications?')}</div>
          <div className="hint" style={{ lineHeight: 1.5, marginTop: 4 }}>{t("So you don't miss things even with the tracker closed:")}</div>
        </div>
      </div>
      <div className="notify-list">
        <div>· {t('a meeting is about to start (with a meeting link)')}</div>
        <div>· {t('a new time poll needs your vote')}</div>
        <div>· {t('someone suggests another time or picks the final one')}</div>
      </div>
      <div className="hint" style={{ paddingLeft: 46 }}>{t('Only these. We ask once; you can change it any time in Settings. Your browser will ask next.')}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm" disabled={busy} onClick={() => void done({})}>{t('Not now')}</button>
        <button className="btn sm primary" disabled={busy} onClick={() => void turnOn()}>{t('Turn on')}</button>
      </div>
    </div>
  );
}

/** Settings › Notifications: kanały wybiera osoba, nie spotkanie. */
export function NotificationSettings() {
  const qc = useQueryClient();
  const s = useNotifySettings().data;
  const [perm, setPerm] = useState(pushPermission);
  if (!s) return null;
  const save = async (patch: Partial<NotifySettings>) => {
    const next = await api<NotifySettings>('/api/notify-settings', { method: 'PUT', body: patch });
    qc.setQueryData<NotifySettings>(['notify-settings'], (old) => (old ? { ...old, ...next } : old));
  };
  const pushBlocked = !pushSupported() ? t('This browser does not support notifications')
    : !s.pushKey ? t('Browser notifications are not configured on the server yet')
    : perm === 'denied' ? t('Notifications are blocked for this site in the browser settings (lock icon in the address bar)') : null;
  const togglePush = async (on: boolean) => {
    if (on) {
      const r = await enablePush(s.pushKey!).catch(() => 'denied' as const);
      setPerm(pushPermission());
      if (r !== 'ok') { toast(t('The browser blocked notifications'), 'warn'); return; }
    } else {
      await disablePush().catch(() => {});
    }
    await save({ push: on, notifyPromptShown: true });
  };
  const row = (label: string, hint: string, checked: boolean, onChange: (v: boolean) => void, disabled?: string | null) => (
    <div className="s-row">
      <span className="grow">{label}<div className="hint">{hint}</div></span>
      <Tooltip text={disabled}>
        <button className={`switch ${checked && !disabled ? 'on' : ''}`} role="switch" aria-checked={checked && !disabled} aria-label={label}
          disabled={!!disabled} style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} onClick={() => void onChange(!checked)} />
      </Tooltip>
    </div>
  );
  return (
    <>
      <div className="s-card">
        {row(t('In the tracker'), t('Banner when a meeting starts in 15 minutes or a poll waits for your vote.'), s.inApp, (v) => save({ inApp: v }))}
        {row(t('Browser notifications'), t('Also when the tracker tab is closed (the browser must be running). Per browser.'), s.push && perm === 'granted', togglePush, pushBlocked)}
        {row('Discord', t('Post my polls and meetings to the project channel with @here. Everyone in the channel sees them.'), s.discord, (v) => save({ discord: v }))}
      </div>
    </>
  );
}
