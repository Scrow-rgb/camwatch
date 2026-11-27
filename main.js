// CamWatch - janela de desktop (Electron). Roda o servidor embutido e mostra o painel numa janela própria.
'use strict';
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');

// Dados ficam fora da pasta de instalação, para sobreviver às atualizações.
// Em desenvolvimento (npm start) ficam na própria pasta do projeto.
process.env.CAMWATCH_HOME = process.env.CAMWATCH_HOME
  || (app.isPackaged ? app.getPath('userData') : __dirname);
process.env.NO_BROWSER = '1';

if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null;
function createWindow(port) {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    title: 'CamWatch', backgroundColor: '#111111', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  // Links externos abrem no navegador padrão, não dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

// ---------- Atualização automática (GitHub Releases) ----------
// Baixa em segundo plano e avisa quando estiver pronta. Se o usuário escolher "Depois",
// instala sozinha na próxima vez que o app for fechado.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (i) => { if (win) win.setTitle(`CamWatch - baixando atualização ${i.version}...`); });
  autoUpdater.on('update-not-available', () => { if (win) win.setTitle('CamWatch'); });
  autoUpdater.on('error', (e) => console.log('Atualização:', e && e.message));
  autoUpdater.on('update-downloaded', (i) => {
    if (win) win.setTitle(`CamWatch - atualização ${i.version} pronta`);
    dialog.showMessageBox(win || undefined, {
      type: 'info', title: 'Atualização disponível', buttons: ['Reiniciar agora', 'Depois'], defaultId: 0, cancelId: 1,
      message: `A versão ${i.version} do CamWatch está pronta.`,
      detail: 'Reiniciar agora para atualizar? Se escolher "Depois", ela é instalada quando você fechar o programa.',
    }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 60 * 60 * 1000); // confere de hora em hora
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  global.__camwatchReady = (port) => { if (!win) createWindow(port); };
  require('./server.js');
  setupAutoUpdate();
});

app.on('window-all-closed', () => app.quit());
