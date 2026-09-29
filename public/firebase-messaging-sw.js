/* global firebase, importScripts, self, clients */
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyCTyZ9Qge9ssGifaSoLJei9dsosIw1geiU',
  authDomain: 'examifying.firebaseapp.com',
  projectId: 'examifying',
  storageBucket: 'examifying.firebasestorage.app',
  messagingSenderId: '598489092395',
  appId: '1:598489092395:web:6e34f6e5663997fabe756e',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  self.registration.showNotification(notification.title || 'Examifying', {
    body: notification.body || 'You have a new Examifying update.',
    icon: notification.icon || '/logo.png',
    badge: '/logo.png',
    tag: data.tag || data.assignmentId || 'examifying-notification',
    data: {
      url: data.url || '/student?tab=mark',
    },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/student?tab=mark';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const matchingClient = clientList.find((client) => client.url.includes(self.location.origin));
      if (matchingClient) {
        matchingClient.focus();
        matchingClient.navigate(url);
        return;
      }
      return clients.openWindow(url);
    }),
  );
});
