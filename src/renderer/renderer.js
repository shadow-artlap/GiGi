'use strict';

// GiGi renderer: owns the sidebar and the stack of <webview> elements.
// Config is loaded from / saved to the main process (local JSON file).

const servicesEl = document.getElementById('services');
const webviewsEl = document.getElementById('webviews');
const emptyEl = document.getElementById('empty');
const dialog = document.getElementById('dialog');
const form = document.getElementById('svcForm');
const nameInput = document.getElementById('svcName');
const urlInput = document.getElementById('svcUrl');
const dlgTitle = document.getElementById('dlgTitle');

let services = [];          // [{ id, name, url }]
let activeId = null;
const unread = new Map();    // id -> count
const views = new Map();     // id -> { webview, button }
let editingId = null;        // id being edited, or null when adding

// ---- Helpers ----------------------------------------------------------------
const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

// ---- Persistence ------------------------------------------------------------
async function persist() {
  await window.hub.saveServices(services.map(({ id, name, url }) => ({ id, name, url })));
}

// ---- Rendering --------------------------------------------------------------
function render() {
  servicesEl.innerHTML = '';
  const seen = new Set();

  services.forEach((svc) => {
    seen.add(svc.id);
    let entry = views.get(svc.id);

    // Create the webview once, lazily reused afterwards.
    if (!entry) {
      const webview = document.createElement('webview');
      webview.className = 'hidden';
      webview.setAttribute('src', svc.url);
      webview.setAttribute('partition', 'persist:' + svc.id); // isolated session per service
      webview.setAttribute('preload', window.hub.webviewPreload);
      webview.setAttribute('allowpopups', 'true');
      webview.setAttribute('useragent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      webview.addEventListener('page-favicon-updated', (e) => {
        const url = e.favicons && e.favicons[0];
        if (url) setButtonIcon(svc.id, url);
      });
      webview.addEventListener('ipc-message', (e) => {
        if (e.channel === 'unread') {
          const prev = unread.get(svc.id) || 0;
          const now = e.args[0] || 0;
          unread.set(svc.id, now);
          // Flash the taskbar when a background service gains unread messages.
          // This is reliable even when the page's Notification API cannot be
          // hooked (webviews run with contextIsolation on).
          if (now > prev && (svc.id !== activeId || !document.hasFocus())) window.hub.flash();
          refreshBadges();
        } else if (e.channel === 'notify') {
          if (svc.id !== activeId || !document.hasFocus()) window.hub.flash();
        }
      });

      const button = document.createElement('button');
      button.className = 'rail-btn';
      button.title = svc.name;
      button.addEventListener('click', () => activate(svc.id));
      button.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, svc.id);
      });

      entry = { webview, button };
      views.set(svc.id, entry);
      webviewsEl.appendChild(webview);
    }

    entry.button.title = svc.name;
    paintButton(svc, entry.button);
    servicesEl.appendChild(entry.button);
  });

  // Drop any webviews for services that were removed.
  for (const id of [...views.keys()]) {
    if (!seen.has(id)) {
      const { webview, button } = views.get(id);
      webview.remove();
      button.remove();
      views.delete(id);
      unread.delete(id);
    }
  }

  if (services.length === 0) {
    emptyEl.classList.remove('hidden');
    activeId = null;
  } else {
    emptyEl.classList.add('hidden');
    if (!activeId || !views.has(activeId)) activate(services[0].id);
  }

  refreshBadges();
}

function paintButton(svc, button) {
  const entry = views.get(svc.id);
  const hasIcon = entry && entry.iconUrl;
  button.innerHTML = '';
  if (hasIcon) {
    const img = document.createElement('img');
    img.src = entry.iconUrl;
    img.onerror = () => { entry.iconUrl = null; paintButton(svc, button); };
    button.appendChild(img);
  } else {
    button.textContent = (svc.name.trim()[0] || '?').toUpperCase();
    button.style.background = avatarColor(svc.name);
  }
  const badge = document.createElement('span');
  badge.className = 'badge hidden';
  button.appendChild(badge);
  button.classList.toggle('active', svc.id === activeId);
}

function setButtonIcon(id, url) {
  const entry = views.get(id);
  if (!entry) return;
  entry.iconUrl = url;
  const svc = services.find((s) => s.id === id);
  if (svc) {
    paintButton(svc, entry.button);
    refreshBadges(); // repaint rebuilt the badge; re-apply the current count
  }
}

function refreshBadges() {
  let total = 0;
  services.forEach((svc) => {
    const n = unread.get(svc.id) || 0;
    total += n;
    const entry = views.get(svc.id);
    if (!entry) return;
    const badge = entry.button.querySelector('.badge');
    if (!badge) return;
    if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  });
  window.hub.setBadge(total);
}

function activate(id) {
  activeId = id;
  views.forEach((entry, key) => {
    entry.webview.classList.toggle('hidden', key !== id);
    entry.button.classList.toggle('active', key === id);
  });
}

// ---- Context menu (right-click a service) -----------------------------------
let ctx = document.getElementById('ctx');
if (!ctx) {
  ctx = document.createElement('div');
  ctx.id = 'ctx';
  ctx.className = 'hidden';
  document.body.appendChild(ctx);
}
function hideContextMenu() { ctx.classList.add('hidden'); }
window.addEventListener('click', hideContextMenu);
window.addEventListener('blur', hideContextMenu);

function showContextMenu(x, y, id) {
  const idx = services.findIndex((s) => s.id === id);
  ctx.innerHTML = '';
  const add = (label, fn, danger) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); fn(); });
    ctx.appendChild(b);
  };
  add('Reload', () => { const v = views.get(id); if (v) v.webview.reload(); });
  add('Edit…', () => openDialog(id));
  if (idx > 0) add('Move up', () => { swap(idx, idx - 1); });
  if (idx < services.length - 1) add('Move down', () => { swap(idx, idx + 1); });
  add('Remove', () => removeService(id), true);

  ctx.style.left = Math.min(x, window.innerWidth - 170) + 'px';
  ctx.style.top = Math.min(y, window.innerHeight - 10) + 'px';
  ctx.classList.remove('hidden');
}

function swap(i, j) {
  [services[i], services[j]] = [services[j], services[i]];
  persist();
  render();
}

function removeService(id) {
  const svc = services.find((s) => s.id === id);
  if (!svc) return;
  if (!confirm(`Remove "${svc.name}"? Its local session data stays on disk until you clear it.`)) return;
  services = services.filter((s) => s.id !== id);
  if (activeId === id) activeId = null;
  persist();
  render();
}

// ---- Add / edit dialog ------------------------------------------------------
function openDialog(id) {
  editingId = id || null;
  const svc = id ? services.find((s) => s.id === id) : null;
  dlgTitle.textContent = svc ? 'Edit service' : 'Add a service';
  nameInput.value = svc ? svc.name : '';
  urlInput.value = svc ? svc.url : '';
  dialog.showModal();
  nameInput.focus();
}

form.addEventListener('submit', (e) => {
  // The "Cancel" button submits with value "cancel".
  const submitter = e.submitter && e.submitter.value;
  if (submitter === 'cancel') { dialog.close(); return; }

  e.preventDefault();
  const name = nameInput.value.trim();
  const url = normalizeUrl(urlInput.value);
  if (!name || !url) return;

  if (editingId) {
    const svc = services.find((s) => s.id === editingId);
    const urlChanged = svc.url !== url;
    svc.name = name;
    svc.url = url;
    if (urlChanged) {
      const entry = views.get(editingId);
      if (entry) entry.webview.setAttribute('src', url);
    }
  } else {
    services.push({ id: uid(), name, url });
  }
  editingId = null;
  dialog.close();
  persist();
  render();
});

document.getElementById('addBtn').addEventListener('click', () => openDialog(null));
document.getElementById('emptyAdd').addEventListener('click', () => openDialog(null));

// ---- Boot -------------------------------------------------------------------
(async function init() {
  services = await window.hub.getServices();
  // Make sure every service has a stable id.
  services = services.map((s) => ({ id: s.id || uid(), name: s.name, url: s.url }));
  render();
  await persist();
})();
