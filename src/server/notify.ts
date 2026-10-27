import { eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import { db } from '../db/index.ts';
import { projects, pushSubscriptions, userNotificationSettings } from '../db/schema.ts';
import type { Project } from './projects.ts';
import { RuleError } from './rules.ts';

/**
 * Kanały powiadomień: in-app (SSE + baner, robi to klient), Web Push (przeglądarka, także przy
 * zamkniętej karcie) i Discord (webhook projektu, z @here). Kanały wybiera osoba w Settings.
 */

export type NotifySettings = { inApp: boolean; push: boolean; discord: boolean; notifyPromptShown: boolean };
const DEFAULTS: NotifySettings = { inApp: true, push: true, discord: true, notifyPromptShown: false };

export async function getNotifySettings(userId: number): Promise<NotifySettings> {
  const [row] = await db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, userId));
  return row ? { inApp: row.inApp, push: row.push, discord: row.discord, notifyPromptShown: row.notifyPromptShown } : { ...DEFAULTS };
}

export async function saveNotifySettings(userId: number, patch: Partial<NotifySettings>) {
  const next = { ...(await getNotifySettings(userId)), ...patch };
  await db.insert(userNotificationSettings).values({ userId, ...next })
    .onConflictDoUpdate({ target: userNotificationSettings.userId, set: next });
  return next;
}

// ---------- Web Push ----------

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const pushEnabled = !!(VAPID_PUBLIC && VAPID_PRIVATE && process.env.VAPID_SUBJECT);
if (pushEnabled) webpush.setVapidDetails(process.env.VAPID_SUBJECT!, VAPID_PUBLIC!, VAPID_PRIVATE!);

const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/];
/** Endpoint Web Push tylko https i tylko znane usługi push (inaczej serwer robiłby POST w dowolne miejsce, SSRF). */
export function isPushEndpoint(url: string) {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((r) => r.test(u.hostname)); } catch { return false; }
}

export function pushPublicKey() {
  return pushEnabled ? VAPID_PUBLIC! : null;
}

export async function savePushSubscription(userId: number, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  if (!isPushEndpoint(sub.endpoint)) throw new RuleError('Unsupported push endpoint', 'invalid');
  await db.insert(pushSubscriptions).values({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
}

export async function deletePushSubscription(userId: number, endpoint: string) {
  const [s] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  if (s?.userId === userId) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

/** Push do osób, które mają włączony ten kanał. Wygasłe subskrypcje (404/410) usuwamy. */
export async function sendPush(userIds: number[], payload: PushPayload, log?: { warn: (o: object, m: string) => void }) {
  if (!pushEnabled || !userIds.length) return 0;
  const settings = await db.select().from(userNotificationSettings).where(inArray(userNotificationSettings.userId, userIds));
  const off = new Set(settings.filter((s) => !s.push).map((s) => s.userId));
  const targets = userIds.filter((id) => !off.has(id));
  if (!targets.length) return 0;
  const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, targets));
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      else log?.warn({ err: (e as Error).message, code }, 'web push failed');
    }
  }));
  return sent;
}

// ---------- Discord ----------

export type DiscordMessage = { title: string; description: string; url?: string; color?: number };

/** Wiadomość na kanał projektu z @here. Brak webhooka = nic. Błąd Discorda nie psuje akcji. */
export async function sendDiscord(p: Project, m: DiscordMessage, log?: { warn: (o: object, m: string) => void }) {
  if (!p.discordWebhookUrl) return false;
  try {
    const res = await fetch(p.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        // Powiadomienie systemowe pokazuje tylko content (bez embeda), więc tytuł na początku, @here (tylko dla pingu Discorda) na końcu.
        content: `**${m.title}** @here`,
        allowed_mentions: { parse: ['everyone'] },
        embeds: [{ title: m.title, description: m.description, url: m.url, color: m.color ?? 0xa855f7 }],
      }),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    // Ślad błędu czyścimy tylko gdy był, żeby nie pisać do bazy przy każdej wiadomości.
    if (p.discordLastError) await db.update(projects).set({ discordLastError: '', discordLastErrorAt: null }).where(eq(projects.id, p.id)).catch(() => {});
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    log?.warn({ err: msg }, 'discord webhook failed');
    // Komunikat z fetch bywa z adresem webhooka, więc zapisujemy tylko kod statusu albo ogólny opis.
    const safe = /^Discord \d+$/.test(msg) ? msg : 'Request failed';
    await db.update(projects).set({ discordLastError: safe.slice(0, 200), discordLastErrorAt: new Date() }).where(eq(projects.id, p.id)).catch(() => {});
    return false;
  }
}
