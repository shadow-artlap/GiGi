'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ---- Paths & storage (everything stays local) --------------------------------
const CONFIG_FILE = path.join(app.getPath('userData'), 'services.json');
const ICON_FILE = path.join(__dirname, '..', '..', 'assets', 'icon.png');

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

// Config schema v2: groups (workspaces). Each group has its own list of services
// (the "setup": link + name + mode). Logins stay per-service and per-group, so the
// same app in two groups keeps separate logins unless explicitly shared within a group.
function loadConfig() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { /* first run */ }

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
  // Fresh install: one group seeded with the default services.
  return {
    version: 2,
    activeGroupId: 'g_default',
    groups: [{ id: 'g_default', name: 'Default', services: DEFAULT_SERVICES.map(normSvc) }]
  };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `GiGi ${info.version} has been downloaded.`,
      detail: 'Restart the app to install the new version.'
    }).then(({ response }) => {
      if (response === 0) { isQuitting = true; autoUpdater.quitAndInstall(); }
    });
  });

  autoUpdater.on('error', (err) => console.error('Updater error:', err));

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
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, config) => saveConfig(config));

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
    wireWebContents();
    createWindow();
    createTray();
    initUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (win) win.show();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });

  // Stay alive in the tray when the window is closed (except macOS convention handled above).
  app.on('window-all-closed', () => { /* intentionally keep running */ });
}
