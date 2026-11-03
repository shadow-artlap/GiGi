'use strict';

// GiGi renderer: groups (workspaces) in the sidebar, each with its own set of
// service tabs (<webview>). Config is loaded from / saved to the main process.

const servicesEl = document.getElementById('services');
const webviewsEl = document.getElementById('webviews');
const emptyEl = document.getElementById('empty');
const groupBtn = document.getElementById('groupBtn');

const dialog = document.getElementById('dialog');
const form = document.getElementById('svcForm');
const nameInput = document.getElementById('svcName');
const urlInput = document.getElementById('svcUrl');
const dlgTitle = document.getElementById('dlgTitle');

const groupDialog = document.getElementById('groupDialog');
const groupForm = document.getElementById('groupForm');
const groupNameInput = document.getElementById('groupName');
const groupDlgTitle = document.getElementById('groupDlgTitle');

// config = { version, activeGroupId, groups: [{ id, name, services:[{id,name,url,shared}] }] }
let config = { version: 2, activeGroupId: null, groups: [] };
const unread = new Map();          // serviceId -> count
const views = new Map();           // serviceId -> { webview, button, partition, iconUrl }
const activeByGroup = new Map();   // groupId -> serviceId
let editingId = null;              // service id being edited, or null
let groupEditId = null;            // group id being renamed, or null (null = create)

// ---- Helpers ----------------------------------------------------------------
const uid = (p = 's') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

function activeGroup() {
  return config.groups.find((g) => g.id === config.activeGroupId) || config.groups[0];
}

// The partition decides which cookie/storage jar a tab uses.
// - Private: persist:<serviceId>  → unique per tab (isolated account).
// - Shared:  persist:shared:<groupId>:<origin>  → linked only within the same group,
//   so the same site in another group keeps a separate login.
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

  webview.addEventListener('page-favicon-updated', (e) => {
    const url = e.favicons && e.favicons[0];
    if (url) setButtonIcon(svc.id, url);
  });
  webview.addEventListener('ipc-message', (e) => {
    if (e.channel === 'unread') {
      const prev = unread.get(svc.id) || 0;
      const now = e.args[0] || 0;
      unread.set(svc.id, now);
      const activeId = activeByGroup.get(config.activeGroupId);
      if (now > prev && (svc.id !== activeId || !document.hasFocus())) window.hub.flash();
      refreshBadges();
    } else if (e.channel === 'notify') {
      const activeId = activeByGroup.get(config.activeGroupId);
      if (svc.id !== activeId || !document.hasFocus()) window.hub.flash();
    }
  });

  const button = document.createElement('button');
  button.className = 'rail-btn';
  button.title = svc.name;
  button.addEventListener('click', () => activate(svc.id));
  button.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    showServiceMenu(ev.clientX, ev.clientY, svc.id);
  });

  const entry = { webview, button, partition };
  views.set(svc.id, entry);
  webviewsEl.appendChild(webview);
  return entry;
}

// ---- Rendering --------------------------------------------------------------
function render() {
  // Make sure there is always a valid active group.
  if (!config.groups.length) {
    config.groups.push({ id: uid('g'), name: 'Default', services: [] });
  }
  if (!config.groups.some((g) => g.id === config.activeGroupId)) {
    config.activeGroupId = config.groups[0].id;
  }
  const g = activeGroup();

  // Group button (initial letter).
  groupBtn.textContent = (g.name.trim()[0] || '?').toUpperCase();
  groupBtn.title = `Group: ${g.name}`;
  groupBtn.style.background = avatarColor('grp-' + g.name);

  // Resolve the active service within this group.
  const ids = g.services.map((s) => s.id);
  let activeId = activeByGroup.get(g.id);
  if (!activeId || !ids.includes(activeId)) activeId = g.services[0] && g.services[0].id;
  activeByGroup.set(g.id, activeId || null);

  // Sidebar buttons for this group's services.
  servicesEl.innerHTML = '';
  g.services.forEach((svc) => {
    let entry = views.get(svc.id);
    const partition = partitionFor(svc, g);
    if (entry && entry.partition !== partition) { dropView(svc.id); entry = null; }
    if (!entry) entry = createView(svc, partition);
    entry.button.title = svc.name;
    paintButton(svc, entry.button, activeId);
    servicesEl.appendChild(entry.button);
  });

  // Visibility + cleanup of webviews that no longer belong to any group.
  const allIds = new Set(config.groups.flatMap((gr) => gr.services.map((s) => s.id)));
  const activeSet = new Set(ids);
  for (const id of [...views.keys()]) {
    if (!allIds.has(id)) { dropView(id); unread.delete(id); continue; }
    const entry = views.get(id);
    entry.webview.classList.toggle('hidden', !(activeSet.has(id) && id === activeId));
  }

  emptyEl.classList.toggle('hidden', g.services.length > 0);
  refreshBadges();
}

function paintButton(svc, button, activeId) {
  const entry = views.get(svc.id);
  const hasIcon = entry && entry.iconUrl;
  button.innerHTML = '';
  if (hasIcon) {
    const img = document.createElement('img');
    img.src = entry.iconUrl;
    img.onerror = () => { entry.iconUrl = null; paintButton(svc, button, activeByGroup.get(config.activeGroupId)); };
    button.appendChild(img);
  } else {
    button.textContent = (svc.name.trim()[0] || '?').toUpperCase();
    button.style.background = avatarColor(svc.name);
  }
  const badge = document.createElement('span');
  badge.className = 'badge hidden';
  button.appendChild(badge);

  if (svc.shared) {
    const mark = document.createElement('span');
    mark.className = 'link-mark';
    mark.title = 'Shared login (within this group)';
    mark.textContent = '🔗';
    button.appendChild(mark);
  }

  button.classList.toggle('active', svc.id === activeId);
}

function setButtonIcon(id, url) {
  const entry = views.get(id);
  if (!entry) return;
  entry.iconUrl = url;
  // Find the service in whichever group holds it.
  let svc = null;
  for (const gr of config.groups) { const f = gr.services.find((s) => s.id === id); if (f) { svc = f; break; } }
  if (svc) {
    paintButton(svc, entry.button, activeByGroup.get(config.activeGroupId));
    refreshBadges();
  }
}

function refreshBadges() {
  const g = activeGroup();
  let total = 0;
  g.services.forEach((svc) => {
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
  activeByGroup.set(config.activeGroupId, id);
  render();
}

function setActiveGroup(gid) {
  config.activeGroupId = gid;
  persist();
  render();
}

// ---- Popup menu (shared by service + group menus) ---------------------------
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
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    if (it.checked) b.classList.add('checked');
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
  const items = [
    { label: 'Reload', fn: () => { const v = views.get(id); if (v) v.webview.reload(); } },
    { label: 'Edit…', fn: () => openDialog(id) },
    { label: svc.shared ? 'Switch to Private' : 'Switch to Shared', fn: () => {
        svc.shared = !svc.shared; dropView(id); persist(); render();
      } },
    { label: 'Duplicate', fn: () => {
        g.services.splice(idx + 1, 0, { id: uid(), name: svc.name, url: svc.url, shared: !!svc.shared });
        persist(); render();
      } }
  ];
  if (idx > 0) items.push({ label: 'Move up', fn: () => swap(idx, idx - 1) });
  if (idx < g.services.length - 1) items.push({ label: 'Move down', fn: () => swap(idx, idx + 1) });
  items.push({ label: 'Remove', danger: true, fn: () => removeService(id) });
  openMenu(x, y, items);
}

function swap(i, j) {
  const g = activeGroup();
  [g.services[i], g.services[j]] = [g.services[j], g.services[i]];
  persist();
  render();
}

function removeService(id) {
  const g = activeGroup();
  const svc = g.services.find((s) => s.id === id);
  if (!svc) return;
  if (!confirm(`Remove "${svc.name}" from "${g.name}"? Its local session data stays on disk until cleared.`)) return;
  g.services = g.services.filter((s) => s.id !== id);
  if (activeByGroup.get(g.id) === id) activeByGroup.set(g.id, null);
  persist();
  render();
}

// ---- Group menu -------------------------------------------------------------
function showGroupMenu() {
  const r = groupBtn.getBoundingClientRect();
  const items = [];
  config.groups.forEach((g) => {
    items.push({
      label: g.name,
      checked: g.id === config.activeGroupId,
      fn: () => setActiveGroup(g.id)
    });
  });
  items.push({ sep: true });
  items.push({ label: '＋ New group', fn: () => openGroupDialog(null) });
  items.push({ label: '⧉ Duplicate this group (same setup, separate logins)', fn: duplicateActiveGroup });
  items.push({ label: '✎ Rename this group', fn: () => openGroupDialog(config.activeGroupId) });
  items.push({ label: 'Delete this group', danger: true, fn: deleteActiveGroup });
  openMenu(r.right + 6, r.top, items);
}
groupBtn.addEventListener('click', (e) => { e.stopPropagation(); showGroupMenu(); });

function duplicateActiveGroup() {
  const g = activeGroup();
  // Same setup (name/url/mode) but brand-new service ids → logins stay separate.
  const copy = {
    id: uid('g'),
    name: g.name + ' copy',
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

// ---- Group create/rename dialog ---------------------------------------------
function openGroupDialog(id) {
  groupEditId = id || null;
  const g = id ? config.groups.find((x) => x.id === id) : null;
  groupDlgTitle.textContent = g ? 'Rename group' : 'New group';
  groupNameInput.value = g ? g.name : '';
  groupDialog.showModal();
  groupNameInput.focus();
}

groupForm.addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value === 'cancel') { groupDialog.close(); return; }
  e.preventDefault();
  const name = groupNameInput.value.trim();
  if (!name) return;
  if (groupEditId) {
    const g = config.groups.find((x) => x.id === groupEditId);
    if (g) g.name = name;
  } else {
    const ng = { id: uid('g'), name, services: [] };
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
    if (partitionFor(svc, g) !== before) {
      dropView(svc.id);
    } else {
      const entry = views.get(svc.id);
      if (entry && entry.webview.getAttribute('src') !== url) entry.webview.setAttribute('src', url);
    }
  } else {
    g.services.push({ id: uid(), name, url, shared });
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
  config = await window.hub.getConfig();
  // Defensive normalization.
  if (!config || !Array.isArray(config.groups)) {
    config = { version: 2, activeGroupId: null, groups: [] };
  }
  config.groups.forEach((g) => {
    g.id = g.id || uid('g');
    g.name = g.name || 'Group';
    g.services = (g.services || []).map((s) => ({ id: s.id || uid(), name: s.name, url: s.url, shared: !!s.shared }));
  });
  render();
  await persist();
})();
