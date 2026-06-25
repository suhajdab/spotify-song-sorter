self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = payload.title || 'Song Sorter';
  const options = {
    body: payload.body || 'A playlist needs re-sorting.',
    data: {
      url: payload.url || '/playlists.html?filter=needs-resorting',
      playlistId: payload.playlistId || null,
    },
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: payload.playlistId ? `resort-needed-${payload.playlistId}` : 'resort-needed',
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/playlists.html', self.location.origin).href;

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windowClients) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) return client.navigate(targetUrl);
        return;
      }
    }
    if (clients.openWindow) return clients.openWindow(targetUrl);
  })());
});
