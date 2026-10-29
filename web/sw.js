// =============================================================================
// sw.js — Service worker for Fresh Supply PWA (P2-7)
//
// Strategy:
//  - Static shell (HTML / CSS / core JS):  stale-while-revalidate from cache.
//  - Supabase API calls:                   network-only (auth + live data).
//  - Product images:                       cache-first, 24-hour TTL.
//  - Everything else:                      network-first with cache fallback.
//
// Install: add <link rel="manifest" href="/manifest.json"> and register this
// file in each app's index.html:
//   <script src="../js/core/sw-register.js"></script>  (a file, because the CSP blocks inline scripts)
// =============================================================================

const SHELL_CACHE   = 'fs-shell-v2';   // v2: shells load base.css + components.css (main.css no longer)
const IMAGE_CACHE   = 'fs-images-v1';
const FALLBACK_CACHE = 'fs-fallback-v1';

const SHELL_ASSETS = [
  '/',
  '/restaurant/',
  '/restaurant/index.html',
  '/admin/',
  '/admin/index.html',
  '/css/base.css',
  '/css/components.css',
  '/vendor/supabase.js',
  '/js/core/config.js',
  '/js/core/ui.js',
  '/js/core/auth.js',
  '/js/core/api.js',
  '/js/core/shell.js',
  '/js/core/permissions.js',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const current = new Set([SHELL_CACHE, IMAGE_CACHE, FALLBACK_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !current.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Supabase / external API: always network-only
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) {
    return; // fall through to default network fetch
  }

  // Images: cache-first with 24h TTL
  if (request.destination === 'image') {
    event.respondWith(cacheFirstWithTTL(request, IMAGE_CACHE, 86_400));
    return;
  }

  // Shell assets: stale-while-revalidate
  if (SHELL_ASSETS.some((a) => url.pathname === a || url.pathname.startsWith(a))) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // Navigation (HTML): stale-while-revalidate with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      staleWhileRevalidate(request, SHELL_CACHE)
        .catch(() => caches.match('/offline.html') ?? fetch(request)),
    );
    return;
  }

  // Default: network-first with cache fallback
  event.respondWith(networkFirst(request, FALLBACK_CACHE));
});

// ── Push notifications ────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'Fresh Supply', body: 'You have a new notification.' };
  try { data = { ...data, ...event.data?.json() }; } catch { /* ignore */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      data:  data,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? '/restaurant/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const match = clients.find((c) => c.url === url);
      if (match) { match.focus(); }
      else { self.clients.openWindow(url); }
    }),
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function staleWhileRevalidate(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => {});
  return cached ?? (await fetchPromise) ?? new Response('Offline', { status: 503 });
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) ?? new Response('Offline', { status: 503 });
  }
}

async function cacheFirstWithTTL(request, cacheName, ttlSeconds) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    const date  = cached.headers.get('date');
    const age   = date ? (Date.now() - new Date(date).getTime()) / 1000 : 0;
    if (age < ttlSeconds) return cached;
  }
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return cached ?? new Response('', { status: 503 });
  }
}
