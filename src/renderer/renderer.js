'use strict';

// GiGi renderer: groups (workspaces) in the sidebar, each with its own set of
// service tabs (<webview>) and an optional custom icon. The active group and the
// active tab per group are stored in the config, so they persist across restarts.

const servicesEl = document.getElementById('services');
const webviewsEl = document.getElementById('webviews');
const emptyEl = document.getElementById('empty');
const groupBtn = document.getElementById('groupBtn');
const groupDot = document.getElementById('groupDot');

const dialog = document.getElementById('dialog');
const form = document.getElementById('svcForm');
const nameInput = document.getElementById('svcName');
const urlInput = document.getElementById('svcUrl');
const dlgTitle = document.getElementById('dlgTitle');

const groupDialog = document.getElementById('groupDialog');
const groupForm = document.getElementById('groupForm');
const groupNameInput = document.getElementById('groupName');
const groupDlgTitle = document.getElementById('groupDlgTitle');
const groupIconPreview = document.getElementById('groupIconPreview');
const pickIconBtn = document.getElementById('pickIconBtn');
const removeIconBtn = document.getElementById('removeIconBtn');
const dndBtn = document.getElementById('dndBtn');

// config = { version, activeGroupId,
//            groups: [{ id, name, icon?, activeServiceId?, services:[{id,name,url,shared}] }] }
let config = { version: 2, activeGroupId: null, groups: [] };
const views = new Map();           // serviceId -> { webview, button, partition, url, iconUrl }

// Unread counts per service, from the site's own signals. Priority:
//   1. badge — what the site sets with navigator.setAppBadge (exact)
//   2. title — the number in its tab title, e.g. "(3) WhatsApp" (exact)
//   3. notif — notifications since you last looked (estimate, for sites with neither)
// Once a site has shown a badge/title count, we trust that source (0 = read).
const counts = new Map();          // serviceId -> { badge, badgeSeen, title, titleSeen, notif }

function countState(id) {
  let c = counts.get(id);
  if (!c) { c = { badge: 0, badgeSeen: false, title: null, titleSeen: false, notif: 0 }; counts.set(id, c); }
  return c;
}
function unreadOf(id) {
  const c = counts.get(id);
  if (!c) return 0;
  if (c.badgeSeen) return c.badge || 0;
  if (c.titleSeen) return c.title || 0;
  return c.notif;
}
function findService(id) {
  for (const g of config.groups) { const s = g.services.find((x) => x.id === id); if (s) return s; }
  return null;
}
// Is the user looking at this service right now?
function isViewing(id) {
  const g = activeGroup();
  return !!g && g.activeServiceId === id && document.hasFocus() && !document.hidden;
}
function markSeen(id) {
  if (!id) return;
  const c = counts.get(id);
  if (c && c.notif) { c.notif = 0; refreshBadges(); }
}
let editingId = null;              // service id being edited, or null
let groupEditId = null;            // group id being renamed, or null (null = create)
let groupIconDraft;               // dialog's pending icon: undefined=unchanged, null=remove, string=new

// ---- Helpers ----------------------------------------------------------------
const uid = (p = 's') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 46%)`;
}

function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function activeGroup() {
  return config.groups.find((g) => g.id === config.activeGroupId) || config.groups[0];
}

// Private: persist:<serviceId>. Shared: persist:shared:<groupId>:<origin> (linked
// only within the group). Each group keeps separate logins for the same site.
function partitionFor(svc, group) {
  if (svc.shared) {
    let origin;
    try { origin = new URL(normalizeUrl(svc.url)).origin; } catch (_) { origin = svc.url; }
    return 'persist:shared:' + group.id + ':' + origin;
  }
  return 'persist:' + svc.id;
}

function dropView(id) {
  const entry = views.get(id);
  if (entry) { entry.webview.remove(); entry.button.remove(); views.delete(id); }
}

async function persist() {
  await window.hub.saveConfig(config);
}

// Tell main which partitions must have notifications blocked (muted tabs, or all
// tabs while Do Not Disturb is on). This silences the OS toast + sound at source.
// A Shared partition is used by several tabs, so it is only blocked when every
// tab on it is silenced; each tab's own page sound is muted separately below.
function syncNotifyBlocks() {
  const state = new Map(); // partition -> all tabs on it silenced?
  config.groups.forEach((g) => g.services.forEach((svc) => {
    const p = partitionFor(svc, g);
    const silenced = !!(config.dnd || svc.muted);
    state.set(p, state.has(p) ? state.get(p) && silenced : silenced);
  }));
  window.hub.setNotifyBlock([...state].filter(([, b]) => b).map(([p]) => p));
  config.groups.forEach((g) => g.services.forEach((svc) => applySilence(svc.id)));
}

// Chat sites (Messenger, WhatsApp, LINE…) play their own "ding" inside the page,
// which no notification permission can stop. So a muted tab (or every tab during
// Do Not Disturb) also has its page audio muted, and its notifications dropped.
function applySilence(id) {
  const entry = views.get(id);
  if (!entry || !entry.ready) return;
  const svc = findService(id);
  const silenced = !!(config.dnd || (svc && svc.muted));
  try { entry.webview.setAudioMuted(silenced); } catch (_) {}
  try { entry.webview.send('gigi:mute', silenced); } catch (_) {}
}

function paintDnd() {
  dndBtn.classList.toggle('on', !!config.dnd);
  dndBtn.title = config.dnd
    ? 'Do Not Disturb is on — click to resume alerts'
    : 'Do Not Disturb — silence all alerts';
}

// Paint a round icon element (letter or image) for a group.
function paintGroupIcon(el, group) {
  el.innerHTML = '';
  if (group && group.icon) {
    const img = document.createElement('img');
    img.src = group.icon;
    el.appendChild(img);
    el.style.background = '#0f1115';
  } else {
    const name = (group && group.name) || '';
    el.textContent = (name.trim()[0] || '?').toUpperCase();
    el.style.background = avatarColor('grp-' + name);
  }
}

// ---- View (webview) creation ------------------------------------------------
function createView(svc, partition) {
  const webview = document.createElement('webview');
  webview.className = 'hidden';
  webview.setAttribute('src', svc.url);
  webview.setAttribute('partition', partition);
  webview.setAttribute('preload', window.hub.webviewPreload);
  webview.setAttribute('allowpopups', 'true');
  webview.setAttribute('useragent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Re-apply mute after every page load (each load starts unmuted).
  webview.addEventListener('dom-ready', () => {
    const entry = views.get(svc.id);
    if (entry && entry.webview === webview) { entry.ready = true; applySilence(svc.id); }
  });
  webview.addEventListener('page-favicon-updated', (e) => {
    const url = e.favicons && e.favicons[0];
    if (url) setButtonIcon(svc.id, url);
  });
  webview.addEventListener('ipc-message', (e) => {
    const id = svc.id;
    const c = countState(id);
    const before = unreadOf(id);
    if (e.channel === 'title') {
      const n = e.args[0];
      c.title = (typeof n === 'number') ? n : null;
      if (c.title !== null) c.titleSeen = true;
    } else if (e.channel === 'badge') {
      c.badge = Number(e.args[0]) || 0;
      c.badgeSeen = true;
    } else if (e.channel === 'notify') {
      if (!isViewing(id)) c.notif += 1;
    } else {
      return;
    }
    // Read the live service (config may have been replaced since this view was made).
    const live = findService(id);
    const alerts = !config.dnd && !(live && live.muted);
    const grew = unreadOf(id) > before || e.channel === 'notify';
    if (alerts && grew && !isViewing(id)) window.hub.flash();
    refreshBadges();
  });

  const button = document.createElement('button');
  button.className = 'rail-btn';
  button.title = svc.name;
  button.addEventListener('click', () => activate(svc.id));
  button.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showServiceMenu(ev.clientX, ev.clientY, svc.id);
  });
  button.addEventListener('dragstart', (e) => {
    if (!editingAllowed()) { e.preventDefault(); return; }
    dragId = svc.id; e.dataTransfer.effectAllowed = 'move'; button.classList.add('dragging');
  });
  button.addEventListener('dragend', () => { dragId = null; button.classList.remove('dragging'); });
  button.addEventListener('dragover', (e) => { if (dragId && editingAllowed()) e.preventDefault(); });
  button.addEventListener('drop', (e) => {
    e.preventDefault();
    if (dragId && editingAllowed() && dragId !== svc.id) reorderService(dragId, svc.id);
  });

  const entry = { webview, button, partition, url: svc.url };
  views.set(svc.id, entry);
  webviewsEl.appendChild(webview);
  return entry;
}

// ---- Rendering --------------------------------------------------------------
function render() {
  if (!config.groups.length) {
    config.groups.push({ id: uid('g'), name: 'Default', services: [] });
  }
  if (!config.groups.some((g) => g.id === config.activeGroupId)) {
    config.activeGroupId = config.groups[0].id;
  }
  const g = activeGroup();

  // Group button (custom image or letter). Its title is set in refreshBadges.
  paintGroupIcon(groupBtn, g);

  // Resolve + remember the active service for this group (persisted on config).
  const ids = g.services.map((s) => s.id);
  if (!g.activeServiceId || !ids.includes(g.activeServiceId)) {
    g.activeServiceId = (g.services[0] && g.services[0].id) || null;
  }
  const activeId = g.activeServiceId;

  // Keep a live webview for every service in every group, so unread counts and
  // notifications keep working for groups you aren't looking at.
  config.groups.forEach((gr) => gr.services.forEach((svc) => {
    let entry = views.get(svc.id);
    const partition = partitionFor(svc, gr);
    if (entry && entry.partition !== partition) { dropView(svc.id); entry = null; }
    if (!entry) entry = createView(svc, partition);
    // The URL was changed (here or by someone else) → load the new address.
    if (entry.url !== svc.url) { entry.url = svc.url; entry.webview.setAttribute('src', svc.url); }
  }));

  // Sidebar buttons for the active group only.
  servicesEl.innerHTML = '';
  g.services.forEach((svc) => {
    const entry = views.get(svc.id);
    paintButton(svc, entry.button, activeId);
    servicesEl.appendChild(entry.button);
  });

  // Visibility + cleanup of webviews that no longer belong to any group.
  const allIds = new Set(config.groups.flatMap((gr) => gr.services.map((s) => s.id)));
  for (const id of [...views.keys()]) {
    if (!allIds.has(id)) { dropView(id); counts.delete(id); continue; }
    views.get(id).webview.classList.toggle('hidden', id !== activeId);
  }

  emptyEl.classList.toggle('hidden', g.services.length > 0);
  lockBtn.classList.toggle('hidden', !(config.pinHash && !config._unlocked));
  addBtnEl.classList.toggle('hidden', !editingAllowed());
  refreshBadges();
  paintDnd();
  syncNotifyBlocks();
}

function paintButton(svc, button, activeId) {
  const entry = views.get(svc.id);
  const hasIcon = entry && entry.iconUrl;
  button.innerHTML = '';
  if (hasIcon) {
    const img = document.createElement('img');
    img.src = entry.iconUrl;
    img.onerror = () => { entry.iconUrl = null; paintButton(svc, button, activeGroup().activeServiceId); };
    button.appendChild(img);
  } else {
    button.textContent = (svc.name.trim()[0] || '?').toUpperCase();
    button.style.background = avatarColor(svc.name);
  }
  const badge = document.createElement('span');
  badge.className = 'badge hidden';
  button.appendChild(badge);

  if (svc.muted) {
    const mark = document.createElement('span');
    mark.className = 'mute-mark';
    mark.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="currentColor"/><path d="M11 6l4 4M15 6l-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    button.appendChild(mark);
  }

  button.title = svc.name + (svc.muted ? ' — muted on this device' : '');
  button.classList.toggle('shared', !!svc.shared);
  button.classList.toggle('muted', !!svc.muted);
  button.classList.toggle('active', svc.id === activeId);
  button.draggable = editingAllowed();
}

function setButtonIcon(id, url) {
  const entry = views.get(id);
  if (!entry) return;
  entry.iconUrl = url;
  let svc = null;
  for (const gr of config.groups) { const f = gr.services.find((s) => s.id === id); if (f) { svc = f; break; } }
  if (svc) {
    paintButton(svc, entry.button, activeGroup().activeServiceId);
    refreshBadges();
  }
}

const fmtCount = (n) => (n > 99 ? '99+' : String(n));
const groupUnread = (g) => g.services.reduce((sum, s) => sum + unreadOf(s.id), 0);

function refreshBadges() {
  const ag = activeGroup();
  if (!ag) return;
  let total = 0;
  let elsewhere = 0;
  config.groups.forEach((g) => {
    const n = groupUnread(g);
    total += n;
    if (g.id !== ag.id) elsewhere += n;
  });

  ag.services.forEach((svc) => {
    const entry = views.get(svc.id);
    const badge = entry && entry.button.querySelector('.badge');
    if (!badge) return;
    const n = unreadOf(svc.id);
    if (n > 0) { badge.textContent = fmtCount(n); badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  });

  // Unread waiting in other groups shows on the group button.
  groupDot.textContent = fmtCount(elsewhere);
  groupDot.classList.toggle('hidden', elsewhere === 0);
  groupBtn.title = `Group: ${ag.name}` + (elsewhere ? ` — ${elsewhere} unread in other groups` : '');

  window.hub.setBadge(total);
}

function activate(id) {
  activeGroup().activeServiceId = id;
  persist();           // remember the open tab across restarts
  render();
  if (document.hasFocus()) markSeen(id);
}

function setActiveGroup(gid) {
  config.activeGroupId = gid;
  persist();           // remember the chosen group across restarts
  render();
  if (document.hasFocus()) markSeen(activeGroup().activeServiceId);
}

// Coming back to the window counts as looking at the open service.
window.addEventListener('focus', () => { const g = activeGroup(); if (g) markSeen(g.activeServiceId); });

// ---- Popup menu (service + group) -------------------------------------------
let menu = document.getElementById('menu');
if (!menu) {
  menu = document.createElement('div');
  menu.id = 'menu';
  menu.className = 'hidden';
  document.body.appendChild(menu);
}
function hideMenu() { menu.classList.add('hidden'); }
window.addEventListener('click', hideMenu);
window.addEventListener('blur', hideMenu);

function openMenu(x, y, items) {
  menu.innerHTML = '';
  items.forEach((it) => {
    if (it.sep) { const d = document.createElement('div'); d.className = 'menu-sep'; menu.appendChild(d); return; }
    if (it.head) { const h = document.createElement('div'); h.className = 'menu-head'; h.textContent = it.head; menu.appendChild(h); return; }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    if (it.checked) b.classList.add('checked');
    if (it.indent) b.classList.add('indent');
    b.addEventListener('click', (e) => { e.stopPropagation(); hideMenu(); it.fn(); });
    menu.appendChild(b);
  });
  menu.style.left = Math.min(x, window.innerWidth - 270) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 10) + 'px';
  menu.classList.remove('hidden');
}

// ---- Service context menu ---------------------------------------------------
function showServiceMenu(x, y, id) {
  const g = activeGroup();
  const idx = g.services.findIndex((s) => s.id === id);
  const svc = g.services[idx];
  if (!svc) return;
  const canEdit = editingAllowed();

  // Reload and Mute are local (always available); the rest change the shared setup.
  // Mute only affects this device — others using the same profile still get alerts.
  const items = [
    { label: 'Reload', fn: () => { const v = views.get(id); if (v) v.webview.reload(); } },
    { label: svc.muted ? 'Unmute on this device' : 'Mute on this device', fn: () => {
        svc.muted = !svc.muted; persist(); render();
      } }
  ];

  if (canEdit) {
    items.push({ label: 'Edit…', fn: () => openDialog(id) });
    items.push({ label: svc.shared ? 'Switch to Private' : 'Switch to Shared', fn: () => {
      svc.shared = !svc.shared; dropView(id); persist(); render();
    } });
    items.push({ label: 'Duplicate', fn: () => {
      g.services.splice(idx + 1, 0, { id: uid(), name: svc.name, url: svc.url, shared: !!svc.shared, muted: !!svc.muted });
      persist(); render();
    } });
    if (idx > 0) items.push({ label: 'Move up', fn: () => swap(idx, idx - 1) });
    if (idx < g.services.length - 1) items.push({ label: 'Move down', fn: () => swap(idx, idx + 1) });

    const others = config.groups.filter((gr) => gr.id !== g.id);
    if (others.length) {
      items.push({ sep: true });
      items.push({ head: 'Move to group' });
      others.forEach((tg) => items.push({ indent: true, label: tg.name, fn: () => moveServiceToGroup(id, tg.id) }));
    }
    items.push({ sep: true });
    items.push({ label: 'Remove', danger: true, fn: () => removeService(id) });
  } else {
    items.push({ sep: true });
    items.push({ label: 'Unlock to edit…', fn: promptUnlock });
  }
  openMenu(x, y, items);
}

function swap(i, j) {
  const g = activeGroup();
  [g.services[i], g.services[j]] = [g.services[j], g.services[i]];
  persist();
  render();
}

function moveServiceToGroup(id, targetGroupId) {
  const from = activeGroup();
  const idx = from.services.findIndex((s) => s.id === id);
  const target = config.groups.find((gr) => gr.id === targetGroupId);
  if (idx < 0 || !target) return;
  const [svc] = from.services.splice(idx, 1);
  target.services.push(svc);
  if (from.activeServiceId === id) from.activeServiceId = null;
  dropView(id); // rebuild under the target group's partition when that group is opened
  persist();
  render();
}

function removeService(id) {
  const g = activeGroup();
  const svc = g.services.find((s) => s.id === id);
  if (!svc) return;
  if (!confirm(`Remove "${svc.name}" from "${g.name}"? Its local session data stays on disk until cleared.`)) return;
  g.services = g.services.filter((s) => s.id !== id);
  if (g.activeServiceId === id) g.activeServiceId = null;
  persist();
  render();
}

// ---- Group menu -------------------------------------------------------------
function showGroupMenu() {
  const r = groupBtn.getBoundingClientRect();
  const items = [];
  config.groups.forEach((g) => {
    const n = groupUnread(g);
    items.push({ label: n ? `${g.name} (${fmtCount(n)})` : g.name, checked: g.id === config.activeGroupId, fn: () => setActiveGroup(g.id) });
  });
  items.push({ sep: true });
  if (editingAllowed()) {
    items.push({ label: 'New group', fn: () => openGroupDialog(null) });
    items.push({ label: 'Duplicate group (same setup, separate logins)', fn: duplicateActiveGroup });
    items.push({ label: 'Edit group (name & image)', fn: () => openGroupDialog(config.activeGroupId) });
    items.push({ label: 'Delete group', danger: true, fn: deleteActiveGroup });
  } else {
    items.push({ label: 'Unlock to edit…', fn: promptUnlock });
  }
  openMenu(r.right + 6, r.top, items);
}
groupBtn.addEventListener('click', (e) => { e.stopPropagation(); showGroupMenu(); });

dndBtn.addEventListener('click', () => {
  config.dnd = !config.dnd;
  persist();
  paintDnd();
  syncNotifyBlocks();
});

// ---- In-app update notification ---------------------------------------------
const updateToast = document.getElementById('updateToast');
const updateMsg = document.getElementById('updateMsg');
const updateAction = document.getElementById('updateAction');
const updateClose = document.getElementById('updateClose');
const updateDot = updateToast.querySelector('.toast-dot');

function showUpdateToast(msg, { action = false, spin = false } = {}) {
  updateMsg.textContent = msg;
  updateAction.classList.toggle('hidden', !action);
  updateDot.classList.toggle('spin', spin);
  updateToast.classList.remove('hidden');
}
function hideUpdateToast() { updateToast.classList.add('hidden'); }

updateClose.addEventListener('click', hideUpdateToast);
updateAction.addEventListener('click', () => window.hub.installUpdate());

window.hub.onUpdateStatus((p) => {
  if (!p) return;
  if (p.state === 'available') showUpdateToast(`Downloading GiGi ${p.version}…`, { spin: true });
  else if (p.state === 'downloading') showUpdateToast(`Downloading update… ${p.percent}%`, { spin: true });
  else if (p.state === 'ready') showUpdateToast(`GiGi ${p.version} is ready — restart to install.`, { action: true });
  else if (p.state === 'error') hideUpdateToast();
});

function duplicateActiveGroup() {
  const g = activeGroup();
  const copy = {
    id: uid('g'),
    name: g.name + ' copy',
    icon: g.icon || null,
    services: g.services.map((s) => ({ id: uid(), name: s.name, url: s.url, shared: !!s.shared }))
  };
  config.groups.push(copy);
  config.activeGroupId = copy.id;
  persist();
  render();
}

function deleteActiveGroup() {
  const g = activeGroup();
  if (!confirm(`Delete group "${g.name}" and its tab list? Saved logins for its tabs stay on disk until cleared.`)) return;
  config.groups = config.groups.filter((x) => x.id !== g.id);
  if (!config.groups.length) config.groups.push({ id: uid('g'), name: 'Default', services: [] });
  config.activeGroupId = config.groups[0].id;
  persist();
  render();
}

// ---- Group create/edit dialog (name + image) --------------------------------
function openGroupDialog(id) {
  groupEditId = id || null;
  const g = id ? config.groups.find((x) => x.id === id) : null;
  groupDlgTitle.textContent = g ? 'Edit group' : 'New group';
  groupNameInput.value = g ? g.name : '';
  groupIconDraft = g ? (g.icon || null) : null;   // start from existing
  paintGroupIcon(groupIconPreview, { name: groupNameInput.value, icon: groupIconDraft });
  groupDialog.showModal();
  groupNameInput.focus();
}

groupNameInput.addEventListener('input', () => {
  // keep the letter preview in sync while there is no image
  if (!groupIconDraft) paintGroupIcon(groupIconPreview, { name: groupNameInput.value, icon: null });
});

pickIconBtn.addEventListener('click', async () => {
  const data = await window.hub.pickGroupIcon();
  if (data) {
    groupIconDraft = data;
    paintGroupIcon(groupIconPreview, { name: groupNameInput.value, icon: data });
  }
});

removeIconBtn.addEventListener('click', () => {
  groupIconDraft = null;
  paintGroupIcon(groupIconPreview, { name: groupNameInput.value, icon: null });
});

groupForm.addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'cancel') { groupDialog.close(); return; }
  e.preventDefault();
  const name = groupNameInput.value.trim();
  if (!name) return;
  const icon = groupIconDraft || null;
  if (groupEditId) {
    const g = config.groups.find((x) => x.id === groupEditId);
    if (g) { g.name = name; g.icon = icon; }
  } else {
    const ng = { id: uid('g'), name, icon, services: [] };
    config.groups.push(ng);
    config.activeGroupId = ng.id;
  }
  groupEditId = null;
  groupDialog.close();
  persist();
  render();
});

// ---- Add / edit service dialog ----------------------------------------------
function openDialog(id) {
  editingId = id || null;
  const g = activeGroup();
  const svc = id ? g.services.find((s) => s.id === id) : null;
  dlgTitle.textContent = svc ? 'Edit service' : 'Add a service';
  nameInput.value = svc ? svc.name : '';
  urlInput.value = svc ? svc.url : '';
  const mode = svc && svc.shared ? 'shared' : 'private';
  const radio = form.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  dialog.showModal();
  nameInput.focus();
}

form.addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'cancel') { dialog.close(); return; }
  e.preventDefault();
  const name = nameInput.value.trim();
  const url = normalizeUrl(urlInput.value);
  if (!name || !url) return;
  const shared = (form.querySelector('input[name="mode"]:checked') || {}).value === 'shared';
  const g = activeGroup();

  if (editingId) {
    const svc = g.services.find((s) => s.id === editingId);
    const before = partitionFor(svc, g);
    svc.name = name; svc.url = url; svc.shared = shared;
    if (partitionFor(svc, g) !== before) dropView(svc.id); // new login jar → rebuild (render loads the URL)
  } else {
    g.services.push({ id: uid(), name, url, shared });
  }
  editingId = null;
  dialog.close();
  persist();
  render();
});

// ---- Settings, admin PIN, drag-reorder --------------------------------------
const settingsBtn = document.getElementById('settingsBtn');
const lockBtn = document.getElementById('lockBtn');
const addBtnEl = document.getElementById('addBtn');
const settingsDialog = document.getElementById('settingsDialog');
const loginToggle = document.getElementById('loginToggle');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const updateState = document.getElementById('updateState');
const pinState = document.getElementById('pinState');
const pinButtons = document.getElementById('pinButtons');
const pinDialog = document.getElementById('pinDialog');
const pinForm = document.getElementById('pinForm');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const pinDlgTitle = document.getElementById('pinDlgTitle');

let pinMode = 'unlock'; // 'unlock' | 'set' | 'change'

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Editing the shared setup is allowed when there is no PIN, or this device is unlocked.
function editingAllowed() { return !config.pinHash || !!config._unlocked; }

function openPin(mode, title) {
  pinMode = mode;
  pinDlgTitle.textContent = title;
  pinInput.value = '';
  pinError.textContent = '';
  pinDialog.showModal();
  pinInput.focus();
}
function promptUnlock() { openPin('unlock', 'Enter admin PIN to edit'); }

pinForm.addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') { pinDialog.close(); return; }
  e.preventDefault();
  const val = pinInput.value.trim();
  if (pinMode === 'unlock') {
    const h = val ? await sha256(val) : '';
    if (h && h === config.pinHash) { config._unlocked = true; pinDialog.close(); persist(); render(); refreshPinState(); }
    else pinError.textContent = 'Wrong PIN — try again.';
    return;
  }
  if (!val) { pinError.textContent = 'Enter a PIN.'; return; }
  config.pinHash = await sha256(val);  // set or change → shared with everyone
  config._unlocked = true;
  pinDialog.close();
  persist();
  render();
  refreshPinState();
});

function refreshPinState() {
  const hasPin = !!config.pinHash;
  const unlocked = !!config._unlocked;
  pinButtons.innerHTML = '';
  const add = (label, fn, cls) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls || 'ghost'; b.textContent = label;
    b.addEventListener('click', fn); pinButtons.appendChild(b);
  };
  if (!hasPin) {
    pinState.textContent = 'No PIN set — anyone can add, edit or delete the shared setup.';
    add('Set admin PIN', () => openPin('set', 'Set an admin PIN'), 'primary');
  } else if (unlocked) {
    pinState.textContent = 'PIN is set. This device is unlocked and can edit.';
    add('Change PIN', () => openPin('change', 'Set a new admin PIN'));
    add('Remove PIN', () => {
      if (!confirm('Remove the admin PIN? Everyone will be able to edit again.')) return;
      config.pinHash = null; config._unlocked = true; persist(); render(); refreshPinState();
    });
  } else {
    pinState.textContent = 'PIN is set. Editing is locked (view-only on this device).';
    add('Unlock', () => promptUnlock(), 'primary');
  }
}

async function openSettings() {
  try { loginToggle.checked = await window.hub.getLoginItem(); } catch (_) {}
  updateState.textContent = 'Updates install automatically.';
  refreshPinState();
  settingsDialog.showModal();
}

settingsBtn.addEventListener('click', openSettings);
lockBtn.addEventListener('click', promptUnlock);
loginToggle.addEventListener('change', () => window.hub.setLoginItem(loginToggle.checked));
checkUpdateBtn.addEventListener('click', async () => {
  updateState.textContent = 'Checking for updates…';
  await window.hub.checkForUpdate();
  setTimeout(() => { if (updateState.textContent === 'Checking for updates…') updateState.textContent = "You're up to date."; }, 5000);
});

// Drag-reorder service tiles within the active group.
let dragId = null;
function reorderService(fromId, toId) {
  const g = activeGroup();
  const from = g.services.findIndex((s) => s.id === fromId);
  if (from < 0) return;
  const [moved] = g.services.splice(from, 1);
  const to = g.services.findIndex((s) => s.id === toId);
  g.services.splice(to < 0 ? g.services.length : to, 0, moved);
  persist();
  render();
}

addBtnEl.addEventListener('click', () => { if (editingAllowed()) openDialog(null); else promptUnlock(); });
document.getElementById('emptyAdd').addEventListener('click', () => { if (editingAllowed()) openDialog(null); else promptUnlock(); });

// ---- Boot -------------------------------------------------------------------
function normalizeConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.groups)) cfg = { version: 2, activeGroupId: null, groups: [] };
  cfg._rev = Number(cfg._rev) || 0;       // which shared version this view is based on
  cfg.dnd = !!cfg.dnd;
  cfg.pinHash = cfg.pinHash || null;      // shared: whether an admin PIN is set
  cfg._unlocked = !!cfg._unlocked;        // local: did this device enter the PIN
  cfg.groups.forEach((g) => {
    g.id = g.id || uid('g');
    g.name = g.name || 'Group';
    g.icon = g.icon || null;
    g.services = (g.services || []).map((s) => ({
      id: s.id || uid(), name: s.name, url: s.url, shared: !!s.shared, muted: !!s.muted
    }));
    if (g.activeServiceId && !g.services.some((s) => s.id === g.activeServiceId)) g.activeServiceId = null;
  });
  return cfg;
}

// A shared-setup update arrived (another device edited, or main merged our own
// save). Adopt the shared structure only — this device's open tab, active group,
// mutes, Do Not Disturb and unlock stay exactly as they are here, so nothing
// jumps to a different profile.
window.hub.onConfigUpdated((incoming) => {
  if (!incoming) return;
  const next = normalizeConfig(incoming);
  const prevGroups = new Map(config.groups.map((g) => [g.id, g]));
  const muted = new Set();
  config.groups.forEach((g) => g.services.forEach((s) => { if (s.muted) muted.add(s.id); }));

  next.groups.forEach((g) => {
    const prev = prevGroups.get(g.id);
    if (prev && prev.activeServiceId && g.services.some((s) => s.id === prev.activeServiceId)) {
      g.activeServiceId = prev.activeServiceId;
    }
    g.services.forEach((s) => { s.muted = muted.has(s.id); });
  });
  if (config.groups.length) {
    next.activeGroupId = config.activeGroupId;
    next.dnd = config.dnd;
    next._unlocked = config._unlocked;
  }
  config = next;
  render();
});

(async function init() {
  // Load the local cache; the shared cloud config arrives via onConfigUpdated.
  // Don't persist here — that would push this machine's cache over everyone else.
  config = normalizeConfig(await window.hub.getConfig());
  render();
})();
