// Run with Electron, not node:test. Uses an isolated profile and synthetic context.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const profile = mkdtempSync(join(tmpdir(), 'mailroom-desktop-smoke-'));
app.setPath('userData', profile);
const P = require('../shared/protocol.js');
const state = {
  actions: P.actions, bridge: { connected: true, profile: 'Preview Chrome', status: 'Connected',
    contexts: [{ id: 'preview', revision: 1, scope: 'A12345', label: 'Window 1 · Tab 2 · A12345' }] },
  selected: { id: 'preview', revision: 1 }, dark: false, alwaysOnTop: true,
  extensionId: 'a'.repeat(32), theme: 'system', shortcut: 'Alt+Shift+Space', launchAtLogin: false
};
let win;
const timeout = setTimeout(() => { console.error('Native smoke test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  ipcMain.handle('desktop:state', () => state);
  ipcMain.handle('desktop:select', (_, selected) => ({ ...state, selected }));
  ipcMain.handle('desktop:action', (_, action) => {
    assert(P.actions.some(item => item.id === action)); return { ok: true };
  });
  win = new BrowserWindow({ width: 540, height: 132, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, show: true,
    webPreferences: { preload: join(__dirname, '../src/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  await win.loadFile(join(__dirname, '../src/toolbar.html'));
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const until = Date.now() + 5000;
    const check = () => document.querySelectorAll('#actions button').length === 10 ? resolve() : Date.now() > until ? reject(Error('Toolbar did not render')) : setTimeout(check, 25);
    check();
  })`);
  const geometry = await win.webContents.executeJavaScript(`({
    count: document.querySelectorAll('#actions button:not(:disabled)').length,
    bottom: document.querySelector('.floating-shell').getBoundingClientRect().bottom,
    height: innerHeight, node: typeof require, target: document.querySelector('#context').value
  })`);
  assert.equal(geometry.count, 10); assert.equal(geometry.target, 'preview');
  assert.equal(geometry.node, 'undefined'); assert(geometry.bottom <= geometry.height, JSON.stringify(geometry));
  assert(win.isAlwaysOnTop());
  await win.webContents.executeJavaScript(`document.querySelector('[data-action="dashboard"]').click()`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(await win.webContents.executeJavaScript(`document.querySelector('#feedback').textContent`), /Sent to/);
  const output = join(tmpdir(), 'mailroom-desktop-preview.png');
  writeFileSync(output, (await win.webContents.capturePage()).toPNG());
  win.hide(); assert.equal(win.isVisible(), false); win.show(); assert.equal(win.isVisible(), true);
  const start = win.getBounds(); win.setPosition(start.x + 10, start.y + 10);
  assert.equal(win.getBounds().x, start.x + 10);
  nativeTheme.themeSource = 'dark';
  win.webContents.send('desktop:state', { ...state, dark: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await win.webContents.executeJavaScript(`document.documentElement.classList.contains('dark')`), true);
  await win.loadFile(join(__dirname, '../src/settings.html'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#extensionId').value`), state.extensionId);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, geometry, screenshot: output }));
  clearTimeout(timeout); win.destroy(); app.quit();
}).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); });
app.on('quit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch {} });
