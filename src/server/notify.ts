import { eq, inArray } from 'drizzle-orm';
import webpush from 'web-push';
import { db } from '../db/index.ts';
import { projects, pushSubscriptions, userNotificationSettings } from '../db/schema.ts';
import type { Project } from './projects.ts';
import { RuleError } from './rules.ts';
import { st } from './i18n.ts';

/**
 * Kanały powiadomień: in-app (SSE + baner, robi to klient), Web Push (przeglądarka, także przy
 * zamkniętej karcie) i Discord (webhook projektu, z @here). Kanały wybiera osoba w Settings.
 */

export type NotifySettings = { inApp: boolean; push: boolean; discord: boolean; notifyPromptShown: boolean; onlyImportant: boolean };
const DEFAULTS: NotifySettings = { inApp: true, push: true, discord: true, notifyPromptShown: false, onlyImportant: false };

export async function getNotifySettings(userId: number): Promise<NotifySettings> {
  const [row] = await db.select().from(userNotificationSettings).where(eq(userNotificationSettings.userId, userId));
  return row ? { inApp: row.inApp, push: row.push, discord: row.discord, notifyPromptShown: row.notifyPromptShown, onlyImportant: row.onlyImportant } : { ...DEFAULTS };
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
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      // Endpoint innego konta zostaje przy właścicielu (bez przejmowania cudzej subskrypcji).
      setWhere: eq(pushSubscriptions.userId, userId) });
}

export async function hasPushSubscription(userId: number, endpoint: string) {
  const [s] = await db.select({ userId: pushSubscriptions.userId }).from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return s?.userId === userId;
}

/** Testowy push na jedną subskrypcję tej osoby (ignoruje kanały i "tylko ważne"). Błąd zwracamy zamiast rzucać. */
export async function sendTestPush(userId: number, endpoint: string): Promise<{ ok: boolean; error?: string }> {
  if (!pushEnabled) return { ok: false, error: 'Push is not configured on the server' };
  const [s] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  if (!s || s.userId !== userId) return { ok: false, error: 'No such subscription' };
  try {
    await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify({ title: 'Exponential', body: st('Test notification'), url: '/', tag: 'test' } satisfies PushPayload), { TTL: 60 });
    return { ok: true };
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
    return { ok: false, error: code ? `Push service answered ${code}` : 'Push failed' };
  }
}

export async function deletePushSubscription(userId: number, endpoint: string) {
  const [s] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  if (s?.userId === userId) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

/**
 * Push do osób, które mają włączony ten kanał. Wygasłe subskrypcje (404/410) usuwamy.
 * important: wzmianki i pytania; "tylko ważne" wycina resztę (np. spotkania).
 */
export async function sendPush(userIds: number[], payload: PushPayload, log?: { warn: (o: object, m: string) => void }, opts?: { important?: boolean }) {
  if (!pushEnabled || !userIds.length) return 0;
  const settings = await db.select().from(userNotificationSettings).where(inArray(userNotificationSettings.userId, userIds));
  const off = new Set(settings.filter((s) => !s.push || (!opts?.important && s.onlyImportant)).map((s) => s.userId));
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

const BASE_URL = (process.env.BASE_URL ?? '').replace(/\/$/, '');

export type DiscordMessage = { title: string; description: string; url?: string; color?: number };

/** Tekst od użytkowników nie może pingować: @everyone/@here i <@...> dostają niewidoczny znak w środku. */
export function defangMentions(s: string) {
  return s.replace(/@(everyone|here)/gi, "@\u200b$1").replace(/<@/g, "<\u200b@");
}

const discordBody = (m: DiscordMessage) => ({
  // Powiadomienie systemowe pokazuje tylko content (bez embeda), więc tytuł na początku, @here (tylko dla pingu Discorda) na końcu.
  content: `**${defangMentions(m.title)}** @here`,
  allowed_mentions: { parse: ['everyone'] },
  embeds: [{ title: defangMentions(m.title), description: defangMentions(m.description), url: m.url, color: m.color ?? 0xa855f7 }],
});

/** Adres webhooka z dopiskiem ścieżki, z zachowaniem parametrów (np. thread_id). */
function webhookUrl(base: string, path: string, params: Record<string, string> = {}) {
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/$/, '') + path;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Wiadomość na kanał projektu z @here. Brak webhooka = nic. Błąd Discorda nie psuje akcji.
 * Zwraca id wiadomości (do późniejszej edycji; pusty napis, gdy Discord go nie podał) albo false.
 */
export async function sendDiscord(p: Project, m: DiscordMessage, log?: { warn: (o: object, m: string) => void }): Promise<string | false> {
  if (!p.discordWebhookUrl) return false;
  try {
    // wait=true: Discord odsyła zapisaną wiadomość, a z nią id.
    const res = await fetch(webhookUrl(p.discordWebhookUrl, '', { wait: 'true' }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        ...discordBody(m),
        // Nazwa i logo aplikacji zamiast domyślnych z webhooka. Logo Discord pobiera sam, więc tylko z publicznego https.
        username: 'Exponential',
        ...(BASE_URL.startsWith('https://') ? { avatar_url: `${BASE_URL}/icon-256.png` } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    const sent = await res.json().catch(() => null) as { id?: string } | null;
    // Ślad błędu czyścimy tylko gdy był, żeby nie pisać do bazy przy każdej wiadomości.
    if (p.discordLastError) await db.update(projects).set({ discordLastError: '', discordLastErrorAt: null }).where(eq(projects.id, p.id)).catch(() => {});
    return sent?.id ?? '';
  } catch (e) {
    const msg = (e as Error).message;
    log?.warn({ err: msg }, 'discord webhook failed');
    // Komunikat z fetch bywa z adresem webhooka, więc zapisujemy tylko kod statusu albo ogólny opis.
    const safe = /^Discord \d+$/.test(msg) ? msg : 'Request failed';
    await db.update(projects).set({ discordLastError: safe.slice(0, 200), discordLastErrorAt: new Date() }).where(eq(projects.id, p.id)).catch(() => {});
    return false;
  }
}

/**
 * Podmienia treść wysłanej wcześniej wiadomości (np. nowa godzina spotkania). Edycja na Discordzie nikogo nie pinguje.
 * Wiadomość usunięta na kanale albo zmieniony webhook: po cichu nic (tylko log).
 */
export async function editDiscord(p: Project, messageId: string, m: DiscordMessage, log?: { warn: (o: object, m: string) => void }) {
  if (!p.discordWebhookUrl || !messageId) return false;
  try {
    const res = await fetch(webhookUrl(p.discordWebhookUrl, `/messages/${messageId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(discordBody(m)),
    });
    if (!res.ok) throw new Error(`Discord ${res.status}`);
    return true;
  } catch (e) {
    const msg = (e as Error).message;
    log?.warn({ err: /^Discord \d+$/.test(msg) ? msg : 'Request failed' }, 'discord edit failed');
    return false;
  }
}
