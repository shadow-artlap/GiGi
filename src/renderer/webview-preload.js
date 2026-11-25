'use strict';

// Runs inside each embedded service. Reports the site's own unread signals to
// the host window:
//   'title'  — a count the site puts in its tab title, e.g. "(3) WhatsApp" (null if none)
//   'badge'  — a count the site sets with navigator.setAppBadge() (most exact)
//   'notify' — the site showed a notification (fallback for sites with no count)
// Notifications still go through normally, unless the tab is muted here.

const { ipcRenderer, webFrame } = require('electron');

const send = (channel, value) => { try { ipcRenderer.sendToHost(channel, value); } catch (_) {} };

// Only accept numbers in the usual unread formats, so titles that merely
// contain a number ("Ads 2", "2024 report") aren't mistaken for a count.
function countFromTitle() {
  const t = document.title || '';
  const m = t.match(/^\s*[(\[]\s*(\d{1,4})\+?\s*[)\]]/)               // "(3) WhatsApp", "[12] Inbox"
    || t.match(/[(\[]\s*(\d{1,4})\+?\s*[)\]]/)                         // "Inbox (12) - Gmail"
    || t.match(/(\d{1,4})\+?\s*(?:unread|new|messages?|notifications?|ข้อความ|รายการใหม่)/i)
    || t.match(/^\s*[•·●*]\s*(\d{1,4})/);                              // "• 5 Slack"
  return m ? parseInt(m[1], 10) : null;
}

let lastTitleCount;
function reportTitle(force) {
  const n = countFromTitle();
  if (force || n !== lastTitleCount) { lastTitleCount = n; send('title', n); }
}

function watchTitle() {
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(() => reportTitle(false)).observe(titleEl, { subtree: true, childList: true, characterData: true });
  }
  // Safety net for titles changed in ways the observer misses (e.g. replaced <title>).
  setInterval(() => reportTitle(false), 3000);
  reportTitle(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTitle);
else watchTitle();

// The page's own Notification / setAppBadge live in its main world, which this
// isolated preload can't patch directly. Inject a small hook there; it reports
// back with window.postMessage, which we relay to the host.
const MAIN_WORLD_HOOK = `(() => {
  if (window.__gigiHooked) return;
  window.__gigiHooked = true;
  const post = (type, data) => { try { window.postMessage({ __gigi: type, data }, '*'); } catch (_) {} };

  try {
    const N = window.Notification;
    if (N) {
      // Muted on this device: count it, but show no toast and play no sound.
      const silent = () => {
        const t = new EventTarget();
        t.close = () => {}; t.onclick = null; t.onclose = null; t.onerror = null; t.onshow = null;
        return t;
      };
      const Wrapped = function (title, options) {
        post('notify', { title: String(title || '') });
        if (window.__gigiMuted) return silent();
        return new N(title, options);
      };
      Wrapped.prototype = N.prototype;
      Object.defineProperty(Wrapped, 'permission', { get: () => N.permission });
      Wrapped.requestPermission = (...args) => N.requestPermission(...args);
      Wrapped.maxActions = N.maxActions;
      window.Notification = Wrapped;
    }
  } catch (_) {}

  try {
    const proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    if (proto && proto.showNotification) {
      const original = proto.showNotification;
      proto.showNotification = function (title, options) {
        post('notify', { title: String(title || '') });
        if (window.__gigiMuted) return Promise.resolve();
        return original.call(this, title, options);
      };
    }
  } catch (_) {}

  try {
    if (navigator.setAppBadge) {
      const set = navigator.setAppBadge.bind(navigator);
      const clear = navigator.clearAppBadge ? navigator.clearAppBadge.bind(navigator) : null;
      navigator.setAppBadge = (n) => {
        post('badge', { n: typeof n === 'number' ? n : 1 });
        return set(n).catch(() => {});
      };
      if (clear) navigator.clearAppBadge = () => { post('badge', { n: 0 }); return clear().catch(() => {}); };
    }
  } catch (_) {}
})();`;

try { webFrame.executeJavaScript(MAIN_WORLD_HOOK); } catch (_) {}
document.addEventListener('DOMContentLoaded', () => { try { webFrame.executeJavaScript(MAIN_WORLD_HOOK); } catch (_) {} });

// The host tells us whether this tab is muted on this device (sent on every
// page load). The flag lives in the page's main world, where the hook reads it.
let muted = false;
function applyMuted() {
  try { webFrame.executeJavaScript('window.__gigiMuted = ' + (muted ? 'true' : 'false') + ';'); } catch (_) {}
}
ipcRenderer.on('gigi:mute', (_e, m) => { muted = !!m; applyMuted(); });

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.__gigi) return;
  if (d.__gigi === 'notify') send('notify', d.data || {});
  else if (d.__gigi === 'badge') send('badge', d.data && Number(d.data.n) >= 0 ? Number(d.data.n) : 0);
});
