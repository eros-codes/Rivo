// self.addEventListener('push', (event) => {
// 	let payload = {};
// 	try {
// 		payload = event.data ? event.data.json() : {};
// 	} catch (e) {
// 		payload = { title: 'Rivo', body: event.data?.text || '' };
// 	}

// 	const title = payload.title || 'Rivo';
// 	const options = {
// 		body: payload.body || '',
// 		icon: payload.icon || '/assets/icons/Icon-192.png',
// 		badge: payload.badge || '/assets/icons/Icon-192.png',
// 		data: payload.data || {},
// 	};

// 	event.waitUntil(self.registration.showNotification(title, options));
// });


// self.addEventListener('notificationclick', function (event) {
// 	event.notification.close();
// 	const payload = event.notification.data || {};
// 	let urlToOpen = '/';
// 	try {
// 		if (payload.url) {
// 			urlToOpen = String(payload.url);
// 		} else if (payload.conversationId) {
// 			urlToOpen = `/?conversationId=${encodeURIComponent(String(payload.conversationId))}${payload.messageId ? '&messageId=' + encodeURIComponent(String(payload.messageId)) : ''}`;
// 		}
// 	} catch (e) {
// 		urlToOpen = '/';
// 	}

// 	event.waitUntil(
// 		clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
// 			for (const client of clientList) {
// 				try {
// 					if ('focus' in client) {
// 						client.focus();
// 						try { client.postMessage({ type: 'push:click', payload }); } catch (e) { /* ignore */ }
// 						return;
// 					}
// 				} catch (e) {
// 					/* ignore */
// 				}
// 			}
// 			if (clients.openWindow) return clients.openWindow(urlToOpen);
// 		}),
// 	);
// });
