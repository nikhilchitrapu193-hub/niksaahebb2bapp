// =============================================================================
// sw-register.js — registers the service worker (web/sw.js) for the installable
// restaurant app. It is a separate file, not an inline <script>, because the page
// CSP is script-src 'self', which blocks inline scripts.
// =============================================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch((error) => console.warn('Service worker registration failed:', error));
}
