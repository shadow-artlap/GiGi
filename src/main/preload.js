'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Absolute file:// URL to the webview preload, so the renderer can set it as the
// `preload` attribute on each <webview> without knowing filesystem paths.
const webviewPreloadUrl = pathToFileURL(
  path.join(__dirname, '..', 'renderer', 'webview-preload.js')
).toString();

contextBridge.exposeInMainWorld('hub', {
  webviewPreload: webviewPreloadUrl,
  platform: process.platform,

  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  pickGroupIcon: () => ipcRenderer.invoke('group:pick-icon'),

  setBadge: (count) => ipcRenderer.send('badge:set', count),
  flash: () => ipcRenderer.send('window:flash')
});
