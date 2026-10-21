// Service worker trackera: tylko powiadomienia Web Push (bez cache offline).
// Działa przy zamkniętej karcie trackera, o ile przeglądarka jest uruchomiona.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Tracker', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Tracker', {
    body: d.body || '',
    tag: d.tag,
    renotify: !!d.tag,
    icon: '/icon.svg',
    data: { url: d.url || '/' },
  }));
});

// Klik: link Discorda otwieramy w nowej karcie, link do trackera w już otwartej karcie (jeśli jest).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  const sameOrigin = new URL(url, self.location.origin).origin === self.location.origin;
  e.waitUntil((async () => {
    if (sameOrigin) {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const tab = all.find((c) => new URL(c.url).origin === self.location.origin);
      if (tab) {
        await tab.focus();
        return tab.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});
