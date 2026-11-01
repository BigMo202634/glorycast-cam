// GloryCast Retouch: desktop shell. All photo work happens in the window (src/),
// this file only opens files and folders and writes the finished photos.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function listPhotos(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isFile() && PHOTO_EXT.has(path.extname(name).toLowerCase())) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0d1424',
    title: 'GloryCast Retouch',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('pick-photos', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose a folder of photos',
    properties: ['openDirectory', 'openFile', 'multiSelections'],
    filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  if (r.canceled) return [];
  let files = [];
  for (const p of r.filePaths) {
    if (fs.statSync(p).isDirectory()) files = files.concat(listPhotos(p));
    else if (PHOTO_EXT.has(path.extname(p).toLowerCase())) files.push(p);
  }
  return files;
});

ipcMain.handle('expand-paths', async (_e, paths) => {
  let files = [];
  for (const p of paths || []) {
    try {
      if (fs.statSync(p).isDirectory()) files = files.concat(listPhotos(p));
      else if (PHOTO_EXT.has(path.extname(p).toLowerCase())) files.push(p);
    } catch { /* skip */ }
  }
  return files;
});

ipcMain.handle('pick-logo', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose your logo (PNG with see-through background is best)',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-output', async (_e, suggested) => {
  const r = await dialog.showOpenDialog({
    title: 'Where should the finished photos go?',
    defaultPath: suggested || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('read-file', async (_e, p) => fs.promises.readFile(p));

ipcMain.handle('write-file', async (_e, dir, name, bytes) => {
  await fs.promises.mkdir(dir, { recursive: true });
  let target = path.join(dir, name);
  // never overwrite: add (2), (3)...
  const ext = path.extname(name), base = name.slice(0, -ext.length || undefined);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  await fs.promises.writeFile(target, Buffer.from(bytes));
  return target;
});

ipcMain.handle('open-folder', async (_e, dir) => shell.openPath(dir));
ipcMain.handle('app-version', () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
