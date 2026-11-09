'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog, session, net } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Paths & storage (everything stays local) --------------------------------
const CONFIG_FILE = path.join(app.getPath('userData'), 'services.json');
const CONFIG_BAK = path.join(app.getPath('userData'), 'services.bak.json');
const CONFIG_TMP = path.join(app.getPath('userData'), 'services.tmp.json');
const ICON_FILE = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// Shared "template" (groups/services setup) the owner publishes to GitHub.
// Every install pulls it so they all start from the same setup; each user can
// still add their own tabs, and logins always stay local (per-install sessions).
const REMOTE_CONFIG_URL = 'https://raw.githubusercontent.com/shadow-artlap/GiGi/main/app-config.json';

// The in-memory config the whole app shares this session.
let currentConfig = null;

// A few popular services to start with. The user can add/remove/reorder freely;
// adding the same service twice gives two independent logins (separate sessions).
const DEFAULT_SERVICES = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/' },
  { id: 'messenger', name: 'Messenger', url: 'https://www.messenger.com/' },
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' },
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app' }
];

const normSvc = (s) => ({ id: s.id, name: s.name, url: s.url, shared: !!s.shared });

// Parse raw JSON text into a valid config, or return null if it is not usable.
function parseConfig(text) {
  const raw = JSON.parse(text);
  // Migrate an old flat services array into a single "Default" group.
  if (Array.isArray(raw)) {
    return {
      version: 2,
      activeGroupId: 'g_default',
      groups: [{ id: 'g_default', name: 'Default', services: raw.map(normSvc) }]
    };
  }
  if (raw && raw.version === 2 && Array.isArray(raw.groups) && raw.groups.length) {
    return raw;
  }
  return null;
}

function readConfigFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return parseConfig(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('Config unreadable:', file, err.message);
    return null;
  }
}

// Config schema v2: groups (workspaces). Loading never destroys existing data:
// a corrupt main file falls back to the backup, and a truly unreadable original
// is preserved as services.corrupt-<ts>.json instead of being overwritten.
function loadConfig() {
  const mainExists = fs.existsSync(CONFIG_FILE);

  const fromMain = readConfigFile(CONFIG_FILE);
  if (fromMain) return fromMain;

  // Main missing or corrupt → try the backup.
  const fromBak = readConfigFile(CONFIG_BAK);
  if (fromBak) {
    console.warn('Recovered config from backup.');
    return fromBak;
  }

  // Main exists but is unreadable and there is no good backup: keep the original
  // for manual recovery and start empty (NOT the preset apps), so a corruption
  // never masquerades as the user's chosen setup.
  if (mainExists) {
    try { fs.renameSync(CONFIG_FILE, CONFIG_FILE + '.corrupt-' + Date.now()); } catch (_) {}
    return { version: 2, activeGroupId: 'g_default', groups: [{ id: 'g_default', name: 'Default', services: [] }] };
  }

  // Genuine first run: start empty; the shared template (below) fills it in.
  // If the template can't be reached (offline), DEFAULT_SERVICES seed it instead.
  return {
    version: 2,
    activeGroupId: 'g_default',
    templateVersion: 0,
    groups: [{ id: 'g_default', name: 'Default', services: [] }]
  };
}

// ---- Shared template: fetch + merge -----------------------------------------
function fetchRemoteTemplate() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = net.request(REMOTE_CONFIG_URL + '?t=' + Date.now());
      const timer = setTimeout(() => { try { req.abort(); } catch (_) {} done(null); }, 8000);
      req.on('response', (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { clearTimeout(timer); done(null); return; }
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { clearTimeout(timer); try { done(JSON.parse(data)); } catch (_) { done(null); } });
      });
      req.on('error', () => { clearTimeout(timer); done(null); });
      req.end();
    } catch (_) { done(null); }
  });
}

const tplSvc = (s) => ({ id: s.id, name: s.name, url: s.url, shared: !!s.shared, muted: false, tpl: true });

function seedFromTemplate(tpl, ver) {
  const groups = (tpl.groups || []).map((g) => ({
    id: g.id, name: g.name, icon: g.icon || null, tpl: true,
    services: (g.services || []).map(tplSvc)
  }));
  if (!groups.length) groups.push({ id: 'g_default', name: 'Default', services: [] });
  return { version: 2, templateVersion: ver, activeGroupId: groups[0].id, groups };
}

// Merge a newer template into the local config: template items (marked tpl) are
// added/updated/removed to match, while the user's own additions and all logins
// are left untouched.
function mergeTemplate(local, tpl, ver) {
  const tplGroupIds = new Set((tpl.groups || []).map((g) => g.id));
  (tpl.groups || []).forEach((tg) => {
    let lg = local.groups.find((g) => g.id === tg.id);
    if (!lg) { lg = { id: tg.id, name: tg.name, icon: tg.icon || null, tpl: true, services: [] }; local.groups.push(lg); }
    else { lg.name = tg.name; lg.icon = tg.icon || null; lg.tpl = true; }

    const tplSvcIds = new Set((tg.services || []).map((s) => s.id));
    (tg.services || []).forEach((ts) => {
      const ls = lg.services.find((s) => s.id === ts.id);
      if (!ls) lg.services.push(tplSvc(ts));
      else { ls.name = ts.name; ls.url = ts.url; ls.shared = !!ts.shared; ls.tpl = true; } // keep user's muted
    });
    // Drop template-origin services the owner removed; keep user-added ones.
    lg.services = lg.services.filter((s) => !(s.tpl === true && !tplSvcIds.has(s.id)));
  });
  // Drop template-origin groups the owner removed; keep user-added groups.
  local.groups = local.groups.filter((g) => !(g.tpl === true && !tplGroupIds.has(g.id)));
  if (!local.groups.length) local.groups.push({ id: 'g_default', name: 'Default', services: [] });
  local.templateVersion = ver;
  return true;
}

async function applyRemoteTemplate(firstRun) {
  const tpl = await fetchRemoteTemplate();
  if (!tpl || !Array.isArray(tpl.groups)) return;
  const ver = Number(tpl.templateVersion) || 1;

  const untemplated = (currentConfig.templateVersion || 0) === 0;
  const empty = !currentConfig.groups.some((g) => (g.services || []).length);

  let changed = false;
  if (firstRun || (untemplated && empty)) {
    currentConfig = seedFromTemplate(tpl, ver);   // brand-new install → use the template
    changed = true;
  } else if (ver > (currentConfig.templateVersion || 0)) {
    changed = mergeTemplate(currentConfig, tpl, ver);  // owner published an update
  }

  if (changed) {
    saveConfig(currentConfig);
    if (win && !win.isDestroyed()) win.webContents.send('config:updated', currentConfig);
  }
}

// Atomic save: write a temp file, then rename over the real file (rename is atomic
// on the same volume), so the config is never left half-written if the app is
// killed mid-save. A second copy is kept as a backup for recovery.
function saveConfig(config) {
  if (!config || !Array.isArray(config.groups) || config.groups.length === 0) {
    console.error('Refusing to save an empty config.');
    return false; // never clobber real data with nothing
  }
  try {
    const data = JSON.stringify(config, null, 2);
    fs.writeFileSync(CONFIG_TMP, data);
    fs.renameSync(CONFIG_TMP, CONFIG_FILE);
    try { fs.writeFileSync(CONFIG_BAK, data); } catch (_) { /* backup is best-effort */ }
    return true;
  } catch (err) {
    console.error('Failed to save config:', err);
    return false;
  }
}

// ---- Window & tray ------------------------------------------------------------
let win = null;
let tray = null;
let isQuitting = false;

function trayImage() {
  const img = nativeImage.createFromPath(ICON_FILE);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#15171c',
    icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined,
    title: 'GiGi',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,       // host renderer needs the preload bridge; webviews stay locked down
      webviewTag: true,     // services are embedded as isolated <webview> elements
      spellcheck: true
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the window hides to tray instead of quitting (stays running for notifications).
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('focus', () => { win.flashFrame(false); });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('GiGi');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show GiGi', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', () => {
    if (win.isVisible() && win.isFocused()) win.hide();
    else { win.show(); win.focus(); }
  });
}

// ---- Auto-update from GitHub Releases ----------------------------------------
// Only runs in an installed build. electron-updater reads app-update.yml
// (generated at build time from the "publish" config in package.json), compares
// against the latest GitHub release, downloads it, and installs on restart.
function initUpdater() {
  if (!app.isPackaged) return; // nothing to update in `npm start`

  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (_) { return; } // dependency missing → skip silently

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('update:status', payload);
  };

  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => {
    console.error('Updater error:', err);
    send({ state: 'error' });
  });

  // The in-app banner's "Restart" button triggers the install.
  ipcMain.on('update:install', () => { isQuitting = true; try { autoUpdater.quitAndInstall(); } catch (_) {} });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();                                     // on launch
  setInterval(check, 6 * 60 * 60 * 1000);      // then every 6 hours
}

// ---- Harden every embedded session -------------------------------------------
function wireWebContents() {
  app.on('web-contents-created', (_e, contents) => {
    // Allow the things a messenger needs; deny the rest.
    contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = ['notifications', 'media', 'clipboard-read', 'fullscreen', 'pointerLock'];
      callback(allowed.includes(permission));
    });

    // Open real external links in the user's default browser, never as popups inside the app.
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

// ---- IPC (renderer <-> main) --------------------------------------------------
ipcMain.handle('config:get', () => currentConfig || (currentConfig = loadConfig()));
ipcMain.handle('config:save', (_e, config) => { currentConfig = config; return saveConfig(config); });

// Let the user pick an image for a group; return it as a small 64x64 PNG data URL
// so it stores inline in the config (no extra files to manage).
// Real mute / Do Not Disturb: the renderer sends the partitions whose
// notifications should be blocked. We deny the 'notifications' permission on
// those sessions (and allow it again when they leave the set), which stops the
// OS toast and its sound at the source — not just GiGi's own taskbar flash.
const ALLOWED_PERMS = ['notifications', 'media', 'clipboard-read', 'fullscreen', 'pointerLock'];
let notifyBlocked = new Set();

function setPartitionNotify(partition, deny) {
  try {
    const ses = session.fromPartition(partition);
    const handler = (_wc, perm) => (perm === 'notifications' ? !deny : ALLOWED_PERMS.includes(perm));
    ses.setPermissionCheckHandler(handler);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'notifications' ? !deny : ALLOWED_PERMS.includes(perm)));
  } catch (err) {
    console.error('setPartitionNotify failed for', partition, err);
  }
}

ipcMain.on('notify:block-set', (_e, partitions) => {
  const next = new Set(Array.isArray(partitions) ? partitions : []);
  for (const p of notifyBlocked) if (!next.has(p)) setPartitionNotify(p, false); // unblock
  for (const p of next) setPartitionNotify(p, true);                             // block
  notifyBlocked = next;
});

ipcMain.handle('group:pick-icon', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a group image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'] }]
  });
  if (res.canceled || !res.filePaths[0]) return null;
  try {
    const img = nativeImage.createFromPath(res.filePaths[0]);
    if (img.isEmpty()) return null;
    return img.resize({ width: 64, height: 64, quality: 'good' }).toDataURL();
  } catch (err) {
    console.error('Failed to read group image:', err);
    return null;
  }
});

ipcMain.on('badge:set', (_e, countRaw) => {
  const count = Number(countRaw) || 0;
  try { app.setBadgeCount(count); } catch (_) { /* unsupported platform */ }
  if (process.platform === 'darwin' && app.dock) app.dock.setBadge(count ? String(count) : '');
  if (tray) tray.setToolTip(count ? `GiGi — ${count} unread` : 'GiGi');
});

ipcMain.on('window:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

// ---- App lifecycle (single instance) -----------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    // Lets Windows attribute toast notifications to GiGi (correct name/icon,
    // grouped under the app) instead of a generic host.
    if (process.platform === 'win32') app.setAppUserModelId('com.gigi.app');

    // Load local config now (fast, offline-safe); pull the shared template after.
    const hadConfig = fs.existsSync(CONFIG_FILE) || fs.existsSync(CONFIG_BAK);
    currentConfig = loadConfig();
    currentConfig.templateVersion = currentConfig.templateVersion || 0;

    wireWebContents();
    createWindow();
    createTray();
    initUpdater();

    applyRemoteTemplate(!hadConfig);                           // on launch
    setInterval(() => applyRemoteTemplate(false), 30 * 60 * 1000); // then every 30 min

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (win) win.show();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });

  // Stay alive in the tray when the window is closed (except macOS convention handled above).
  app.on('window-all-closed', () => { /* intentionally keep running */ });
}
