import { api } from './api.ts';

/** Web Push: zgoda przeglądarki + subskrypcja zapisana na serwerze (klucz VAPID z serwera). */

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function pushPermission(): NotificationPermission | 'unsupported' {
  return pushSupported() ? Notification.permission : 'unsupported';
}

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** Pyta o zgodę (jeśli trzeba) i zapisuje subskrypcję. */
export async function enablePush(publicKey: string): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return 'denied';
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api('/api/push/subscription', { method: 'POST', body: sub.toJSON() });
  return 'ok';
}

/** Ma już zgodę: po cichu odświeża subskrypcję (np. nowa przeglądarka po zalogowaniu). */
export async function refreshPush(publicKey: string) {
  if (pushPermission() !== 'granted') return;
  try { await enablePush(publicKey); } catch { /* brak sieci albo push zablokowany w przeglądarce */ }
}

export async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('/api/push/subscription', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}
