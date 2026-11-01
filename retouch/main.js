// GloryCast Retouch: desktop shell. All photo work happens in the window (src/),
// this file only opens files and folders and writes the finished photos.
const { app, BrowserWindow, dialog, ipcMain, shell, protocol, net } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');

// Serve the window from app://retouch/ (a proper origin) so the photo worker
// loads the same way on Windows and Mac. file:// pages can block workers.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const SRC = path.join(__dirname, 'src');

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
  win.loadURL('app://retouch/index.html');
  if (process.env.GCR_SELFTEST) selfTest(win, process.env.GCR_SELFTEST);
}

// Build check: GCR_SELFTEST=<folder with sample photos> opens the app, adds the photos,
// waits for preview, exports them, saves a screenshot and exits 0 (pass) or 1 (fail).
function selfTest(win, dir) {
  const log = (m) => {
    process.stdout.write('[selftest] ' + m + '\n');
    try { fs.appendFileSync(path.join(dir, 'selftest.log'), m + '\n'); } catch { /* ignore */ }
  };
  const fail = (m) => { log('FAIL ' + m); app.exit(1); };
  setTimeout(() => fail('timeout'), 90000);
  win.webContents.on('console-message', (_e, _l, msg) => log('console: ' + msg));
  win.webContents.on('did-fail-load', (_e, code, desc) => fail('load ' + code + ' ' + desc));
  win.webContents.once('did-finish-load', async () => {
    try {
      const files = listPhotos(dir);
      log('photos: ' + files.length);
      const out = path.join(dir, 'out');
      const res = await win.webContents.executeJavaScript(`(async () => {
        const files = ${JSON.stringify(files)};
        window.__gcr.addPhotos(files.map((p) => ({ path: p, name: p.split(/[\\\\/]/).pop() })));
        const t0 = Date.now();
        while (Date.now() - t0 < 40000) {
          const st = window.__gcr.state;
          const thumbs = st.photos.every((p) => p.stats || p.skip);
          const img = document.getElementById('after').getAttribute('src');
          if (thumbs && img) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const st = window.__gcr.state;
        const r = await window.__gcr.exportAll(${JSON.stringify(out)});
        return { photos: st.photos.length, analysed: st.photos.filter((p) => p.stats).length,
          preview: !!document.getElementById('after').getAttribute('src'),
          info: document.getElementById('info').textContent, exported: r.ok, failed: r.failed };
      })()`);
      log(JSON.stringify(res));
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'selftest-screen.png'), shot.toPNG());
      const written = fs.existsSync(out) ? fs.readdirSync(out) : [];
      log('written: ' + written.join(', '));
      if (res.photos !== files.length || res.analysed !== files.length || !res.preview ||
          res.exported !== files.length || written.length !== files.length) return fail('result');
      log('PASS');
      app.exit(0);
    } catch (err) { fail(err && err.stack || err); }
  });
}

// Windows cannot show a picker for files and folders at once, so two buttons.
ipcMain.handle('pick-photos', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose photos',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'JPG', 'JPEG', 'PNG'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.filter((p) => PHOTO_EXT.has(path.extname(p).toLowerCase()));
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose a folder of photos',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (r.canceled) return [];
  let files = [];
  for (const p of r.filePaths) files = files.concat(listPhotos(p));
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
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(SRC, rel));
    if (!file.startsWith(SRC)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
