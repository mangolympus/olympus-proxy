// Olympus service worker — app shell caching + update handling.
//
// Bump CACHE_VERSION on every deploy that changes index.html (or any other cached file).
// The activate handler deletes any cache that doesn't match this string, so bumping it is
// what makes the "new version available" flow in index.html actually pick up the change —
// forgetting to bump it means devices keep serving the old cached copy indefinitely.
const CACHE_VERSION = 'olympus-v44';  // Phase 3 — dual RTDB write

// Same-origin, always-available files only. Google Sign-In (accounts.google.com), Google
// Fonts, and any Drive/Gemini API calls are all cross-origin and deliberately never touched
// by this service worker (see the fetch handler below) — caching or intercepting those could
// interfere with login/sync, which is explicitly out of scope for this pass.
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// index.html posts this once it's shown the "Updating…" toast and waited out the delay —
// see registerServiceWorker() there for the other half of this handshake.
//
// TIMER_NOTIFY / TIMER_NOTIFY_CLEAR: the persistent "session active" notification for the
// Study Timer. Deliberately NOT live-ticking — checked this first, not just assumed it:
// there is no web-notification equivalent of Android's native chronometer notification
// (Notification.Builder.setUsesChronometer(), which only native apps can use), and updating
// a shown notification every second from here would mean waking this worker every second,
// which Chrome throttles hard in the background — the exact failure mode already flagged in
// the brief. So this shows static status text ("Session Active — Started at 10:00 AM" / "On
// Break") that only changes on real state transitions (start/pause/resume), same tag every
// time so it replaces in place rather than stacking.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data && event.data.type === 'TIMER_NOTIFY') {
    const { title, body } = event.data;
    self.registration.showNotification(title, {
      body,
      tag: 'olympus-active-timer',
      silent: true,
      requireInteraction: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      actions: [
        { action: 'pause', title: 'Pause' },
        { action: 'stop', title: 'End' },
      ],
    });
  } else if (event.data && event.data.type === 'TIMER_NOTIFY_CLEAR') {
    self.registration.getNotifications({ tag: 'olympus-active-timer' }).then((notifs) => {
      notifs.forEach((n) => n.close());
    });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept cross-origin requests

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Cache same-origin GETs as they're seen, so anything not pre-listed in APP_SHELL
          // still becomes available offline after the first successful load.
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline and not cached — for a page navigation, fall back to the shell rather
          // than showing the browser's default offline error page.
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});

// ── Push notifications ──────────────────────────────────────────
// The payload is whatever /api/send-push passed through to web-push's sendNotification() —
// see sendPush() in index.html: {title, body, data:{url}}.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) { /* non-JSON payload, ignore */ }
  const title = payload.title || 'Olympus';
  const options = {
    body: payload.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Focuses an already-open Olympus tab/window if one exists, otherwise opens a new one —
// rather than always opening a fresh tab regardless of what's already running.
self.addEventListener('notificationclick', (event) => {
  // Pause/End tapped on the persistent timer notification — hand off to index.html to run
  // the actual timerPause()/timerStop() so shared state and Drive sync fire exactly as if
  // the button had been tapped in the UI (see the message listener there). Deliberately
  // doesn't close the notification here: index.html updates or clears it once the state
  // change is actually applied, via TIMER_NOTIFY/TIMER_NOTIFY_CLEAR above, so the shade
  // never shows a stale status for the instant before that round-trip completes.
  if (event.notification.tag === 'olympus-active-timer' && (event.action === 'pause' || event.action === 'stop')) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        if (windowClients.length > 0) {
          windowClients.forEach((client) => client.postMessage({ type: 'TIMER_ACTION', action: event.action }));
          return;
        }
        // No open tab to postMessage to — Android had fully killed it, not just backgrounded
        // it, which is common for a PWA tab left alone for a while. Open one instead of
        // silently dropping the tap; index.html checks for ?timerAction= on load and applies
        // it once app state is actually ready, then cleans the URL up.
        if (clients.openWindow) return clients.openWindow(`./?timerAction=${event.action}`);
      })
    );
    return;
  }
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
