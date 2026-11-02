'use strict';

// Runs inside each embedded service (isolated, no node access to the page).
// It reports an unread count to the host window and signals incoming notifications,
// then lets the native notification go through as usual.

const { ipcRenderer } = require('electron');

// Pull the first small number out of the tab title, e.g. "(3) WhatsApp",
// "Inbox (12) - Gmail", "• 5 Slack". This is the same heuristic most
// multi-messenger apps use; it covers the majority of web services.
function unreadFromTitle() {
  const title = document.title || '';
  const match = title.match(/[\(\[]?\s*(\d{1,4})\s*[\)\]]?/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : 0;
}

function report() {
  try { ipcRenderer.sendToHost('unread', unreadFromTitle()); } catch (_) {}
}

// React to title changes, and poll as a safety net for services that
// update their title through the History API or inside a frame.
function watchTitle() {
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(report).observe(titleEl, {
      subtree: true, childList: true, characterData: true
    });
  }
  setInterval(report, 4000);
  report();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchTitle);
} else {
  watchTitle();
}

// Wrap the Notification API so we can flash the window / bump the counter,
// while still showing the real OS notification.
try {
  const Native = window.Notification;
  if (Native) {
    const Wrapped = function (title, options) {
      try { ipcRenderer.sendToHost('notify', { title: String(title || ''), body: options && options.body }); } catch (_) {}
      return new Native(title, options);
    };
    Wrapped.maxActions = Native.maxActions;
    Object.defineProperty(Wrapped, 'permission', { get: () => Native.permission });
    Wrapped.requestPermission = Native.requestPermission
      ? Native.requestPermission.bind(Native)
      : () => Promise.resolve('granted');
    Object.defineProperty(window, 'Notification', { value: Wrapped, configurable: true, writable: true });
  }
} catch (_) { /* some pages lock Notification down; ignore */ }
