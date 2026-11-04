import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, awaitsMyVote, pollAlertKey, useMe, useMeetings, useNotifySettings, type NotifySettings } from './api.ts';
import { Icon } from './icons.tsx';
import { Tooltip } from './menu.tsx';
import { toast } from './toast.ts';
import { useNow } from './time.ts';
import { fmtTime, meetingColor, openMeeting } from './Meetings.tsx';
import { disablePush, enablePush, pushPermission, pushSubscriptionOnServer, pushSupported, refreshPush, sendPushTest } from './push.ts';
import { isHttpUrl } from './links.ts';
import { t } from './i18n.ts';

const DISMISSED = 'dismissedMeetingBanners';
const readDismissed = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? '[]'); } catch { return []; } };
// Zamknięte komunikaty trzymamy też w pamięci (prywatne okno bez localStorage) i dajemy znać banerowi oraz dzwonkowi.
let dismissedNow = readDismissed();
export function addDismissed(key: string) {
  dismissedNow = [key, ...dismissedNow].slice(0, 50);
  try { localStorage.setItem(DISMISSED, JSON.stringify(dismissedNow)); } catch { /* prywatne okno */ }
  window.dispatchEvent(new Event('meeting-dismissed'));
}
function useDismissed() {
  const [d, setD] = useState(dismissedNow);
  useEffect(() => {
    const f = () => setD(dismissedNow);
    window.addEventListener('meeting-dismissed', f);
    return () => window.removeEventListener('meeting-dismissed', f);
  }, []);
  return d;
}

/** Spotkania za ≤ 15 min albo trwające i ankiety czekające na mój głos, bez zamkniętych; wspólne dla banera i dzwonka. */
export function useMeetingAlerts() {
  const now = useNow(20_000);
  const me = useMe().data;
  const meetings = useMeetings().data ?? [];
  const dismissed = useDismissed();
  const soon = meetings.filter((m) => m.status === 'scheduled' && m.startsAt && m.endsAt
    && new Date(m.startsAt).getTime() - 15 * 60_000 <= now.getTime() && new Date(m.endsAt) > now
    && !dismissed.includes(`m${m.id}:${m.startsAt}`));
  const polls = meetings.filter((m) => awaitsMyVote(m, me?.id) && !dismissed.includes(pollAlertKey(m)));
  return { now, soon, polls };
}

/**
 * Baner nad widokami: spotkanie za ≤ 15 min albo trwające (z "Join"). Ankieta czekająca na głos jest tylko w dzwonku i liczniku Kalendarza.
 * Liczony z listy spotkań, więc działa też po przegapionym zdarzeniu SSE. Wyłączany w Settings (in-app).
 */
export function MeetingBanner() {
  const settings = useNotifySettings().data;
  const { now, soon } = useMeetingAlerts();
  if (settings && !settings.inApp) return null;
  const dismiss = addDismissed;
  if (!soon.length) return null;

  return (
    <div className="meeting-banners">
      {soon.map((m) => {
        const mins = Math.round((new Date(m.startsAt!).getTime() - now.getTime()) / 60000);
        return (
          <div key={m.id} className="meeting-banner" style={{ '--kind': meetingColor(m) } as React.CSSProperties}>
            <span className="pulse" />
            <button className="banner-text" onClick={() => openMeeting(m.id)}>
              <div className="strong">{m.title} {mins > 0 ? t('starts in {n} min', { n: mins }) : t('is starting now')}</div>
              <div className="hint">{fmtTime(m.startsAt!)}{m.locationUrl ? ' · Discord' : ''}</div>
            </button>
            <Tooltip text={isHttpUrl(m.locationUrl) ? null : t('No meeting link set for this meeting')}>
              {isHttpUrl(m.locationUrl)
                ? <a className="btn sm primary" href={m.locationUrl} target="_blank" rel="noreferrer">{t('Join')}</a>
                : <button className="btn sm primary" disabled>{t('Join')}</button>}
            </Tooltip>
            <button className="btn sm" onClick={() => dismiss(`m${m.id}:${m.startsAt}`)}>{t('Dismiss')}</button>
          </div>
        );
      })}
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
      <div className="notify-head">
        <span className="notify-icon"><Icon.bell size={16} /></span>
        <div>
          <div className="notify-title">{t('Turn on notifications?')}</div>
          <div className="hint">{t("So you don't miss things even with Exponential closed:")}</div>
        </div>
      </div>
      <div className="notify-list">
        <div>· {t('a meeting is about to start (with a meeting link)')}</div>
        <div>· {t('a new time poll needs your vote')}</div>
        <div>· {t('someone suggests another time or picks the final one')}</div>
      </div>
      <div className="hint">{t('We ask once. You can change it in Settings.')}</div>
      <div className="notify-foot">
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
  // Przełącznik push świeci tylko, gdy ta przeglądarka ma subskrypcję znaną serwerowi.
  const [subscribed, setSubscribed] = useState(false);
  const [testError, setTestError] = useState('');
  const [testing, setTesting] = useState(false);
  const recheck = () => { if (pushPermission() === 'granted') void pushSubscriptionOnServer().then(setSubscribed); else setSubscribed(false); };
  useEffect(recheck, []);
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
    setTestError('');
    recheck();
  };
  const pushOn = s.push && perm === 'granted' && subscribed;
  const runTest = async () => {
    setTesting(true);
    setTestError('');
    try {
      const r = await sendPushTest();
      if (r.ok) toast(t('Test notification sent')); else setTestError(r.error ? t(r.error) : t('Could not send the test notification'));
    } catch (e) { setTestError((e as Error).message); }
    setTesting(false);
  };
  const discordNames = s.discordProjects?.map((p) => p.name) ?? [];
  const row = (id: string, label: string, hint: string, checked: boolean, onChange: (v: boolean) => void, disabled?: string | null, extra?: React.ReactNode, below?: string) => (
    <div className="s-row" id={id}>
      <span className="grow">{label}<div className="hint">{hint}</div>{below && <div className="hint notify-error">{below}</div>}</span>
      {extra}
      <Tooltip text={disabled}>
        <button className={`switch ${checked && !disabled ? 'on' : ''}`} role="switch" aria-checked={checked && !disabled} aria-label={label}
          disabled={!!disabled} style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} onClick={() => void onChange(!checked)} />
      </Tooltip>
    </div>
  );
  return (
    <>
      <div className="s-card">
        {row('notif-app', t('In Exponential'), t('Bell and banners: mentions, questions, polls, meetings.'), s.inApp, (v) => save({ inApp: v }))}
        {row('notif-push', t('Browser notifications'), t('Also when the tab is closed. Per browser.'), pushOn, togglePush, pushBlocked,
          pushOn && <button className="btn sm" disabled={testing} onClick={() => void runTest()}>{t('Send test')}</button>, testError)}
        {row('notif-discord', 'Discord', discordNames.length ? t('Polls and meetings in {names}', { names: discordNames.join(', ') }) : '', s.discord && discordNames.length > 0, (v) => save({ discord: v }), discordNames.length ? null : t('No project has a Discord channel set'))}
        {row('notif-analysis', t('Keep the analysis toast until it is done'), '', s.analysisToastSticky !== false, (v) => save({ analysisToastSticky: v }))}
        {row('notif-important', t('Only mentions and questions to me'), t('Polls and meeting reminders stay in the bell only.'), s.onlyImportant, (v) => save({ onlyImportant: v }))}
      </div>
    </>
  );
}
