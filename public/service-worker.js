self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'Notification', body: event.data?.text || '' };
  }

  const title = payload.title || 'Rivo';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/assets/icons/Icon-192.png',
    badge: payload.badge || '/assets/icons/Icon-192.png',
    data: payload.data || {},
  };

  event.waitUntil(self.registration.showNotification(title, options));
});


self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  let urlToOpen = '/';
  try {
    const raw = event.notification.data && event.notification.data.url ? String(event.notification.data.url) : '/';
    const baseScope = self.registration.scope || '/';
    const parsed = new URL(raw, baseScope);
    const baseOrigin = new URL(baseScope).origin;
    if (parsed.origin === baseOrigin) {
      urlToOpen = parsed.href;
    } else {
      urlToOpen = '/';
    }
  } catch (e) {
    urlToOpen = '/';
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          if (client.url === urlToOpen && 'focus' in client) {
            return client.focus();
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    }),
  );
});
