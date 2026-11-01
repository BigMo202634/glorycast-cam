/* GloryCast Retouch window logic. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.gcr; // from preload (Electron). Absent in a plain browser test.

  const SLIDERS = [
    ['colour', 'Fix colour cast', 0, 100, 'Uses the white garments to remove green, yellow or pink light'],
    ['exposure', 'Fix white brightness', 0, 100, 'Brings white cloth to a clean, bright level'],
    ['highlights', 'Save burnt whites', 0, 100, 'Brings back folds in over-bright garments'],
    ['face', 'Brighten faces', 0, 100, 'Lifts faces that look dark next to white cloth'],
    ['skin', 'Smooth skin', 0, 100, 'Evens skin, keeps eyes, lips and texture'],
    ['iron', 'Iron clothes', 0, 100, 'Softens creases on white cloth, keeps pleats and seams'],
    ['warmth', 'Warm / cool', -50, 50, 'Left = cooler, cleaner white. Right = warmer'],
    ['vibrance', 'Colour strength', -50, 50, 'Livelier colours without overdoing skin'],
    ['brightness', 'Overall brightness', -50, 50, ''],
  ];
  const D = GCEngine.DEFAULTS;
  const PRESETS = {
    'GloryCast Auto': {},
    'Clean & cool': { warmth: -18, iron: 45, skin: 45, exposure: 75, vibrance: 15, brightness: 4 },
    'Outdoor': { colour: 55, exposure: 45, highlights: 75, face: 55 },
    'Indoor tube lights': { colour: 90, exposure: 65, face: 55 },
    'Night / stage': { colour: 50, exposure: 50, highlights: 45, face: 70, skin: 40 },
    'Gentle': { colour: 45, exposure: 35, highlights: 40, face: 30, skin: 20, iron: 15 },
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('gcr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('gcr.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const state = {
    photos: [],            // {path, name, el, skip, done, stats}
    current: -1,
    settings: Object.assign({}, D, store.get('settings', {})),
    preset: store.get('preset', 'GloryCast Auto'),
    crop: store.get('crop', 'original'),
    wm: Object.assign({ on: false, position: 'bottom-right', size: 15, opacity: 85, path: null }, store.get('wm', {})),
    maxSide: store.get('maxSide', 2048),
    quality: store.get('quality', 92),
    exporting: false,
  };

  // ---------- worker ----------
  const worker = new Worker('worker.js');
  let seq = 0;
  const waiting = new Map();
  worker.onmessage = (e) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    e.data.ok ? w.resolve(e.data) : w.reject(new Error(e.data.error));
  };
  const ask = (msg, transfer) => new Promise((resolve, reject) => {
    const id = ++seq; waiting.set(id, { resolve, reject });
    worker.postMessage(Object.assign({ id }, msg), transfer || []);
  });
  // a second worker for thumbnails so the big preview never waits behind 300 thumbs
  const thumbWorker = new Worker('worker.js');
  const tWaiting = new Map();
  thumbWorker.onmessage = (e) => { const w = tWaiting.get(e.data.id); if (w) { tWaiting.delete(e.data.id); e.data.ok ? w.resolve(e.data) : w.reject(new Error(e.data.error)); } };
  const askThumb = (msg) => new Promise((resolve, reject) => { const id = ++seq; tWaiting.set(id, { resolve, reject }); thumbWorker.postMessage(Object.assign({ id }, msg)); });

  async function bytesOf(photo) {
    if (photo.file) return new Uint8Array(await photo.file.arrayBuffer());
    return new Uint8Array(await api.readFile(photo.path));
  }

  // ---------- panel ----------
  function buildPanel() {
    const box = $('presets');
    for (const name of Object.keys(PRESETS)) {
      const b = document.createElement('button');
      b.textContent = name;
      b.onclick = () => { state.preset = name; state.settings = Object.assign({}, D, PRESETS[name]); syncSliders(); changed(); };
      box.appendChild(b);
    }
    const sl = $('sliders');
    for (const [key, label, min, max, help] of SLIDERS) {
      const l = document.createElement('label');
      l.className = 'slider';
      l.innerHTML = `<span>${label} <i id="v_${key}"></i></span><input type="range" id="s_${key}" min="${min}" max="${max}">` +
        (help ? `<small>${help}</small>` : '');
      sl.appendChild(l);
      const input = l.querySelector('input');
      input.addEventListener('input', () => { state.settings[key] = +input.value; state.preset = null; syncSliders(false); changed(); });
      input.addEventListener('dblclick', () => { state.settings[key] = D[key]; syncSliders(); changed(); });
    }
    $('reset').onclick = () => { state.preset = 'GloryCast Auto'; state.settings = Object.assign({}, D); syncSliders(); changed(); };

    const crop = $('crop');
    for (const [k, c] of Object.entries(GCEngine.CROPS)) {
      const o = document.createElement('option'); o.value = k; o.textContent = c.label; crop.appendChild(o);
    }
    crop.value = state.crop;
    crop.onchange = () => { state.crop = crop.value; store.set('crop', state.crop); changed(); };

    $('wmOn').checked = state.wm.on;
    $('wmPos').value = state.wm.position;
    $('wmSize').value = state.wm.size;
    $('wmOp').value = state.wm.opacity;
    const wmChanged = () => {
      state.wm.on = $('wmOn').checked; state.wm.position = $('wmPos').value;
      state.wm.size = +$('wmSize').value; state.wm.opacity = +$('wmOp').value;
      $('wmSizeV').textContent = state.wm.size + '%'; $('wmOpV').textContent = state.wm.opacity + '%';
      store.set('wm', state.wm); changed();
    };
    ['wmOn', 'wmPos'].forEach((id) => $(id).onchange = wmChanged);
    ['wmSize', 'wmOp'].forEach((id) => $(id).oninput = wmChanged);
    wmChanged();
    $('pickLogo').onclick = async () => {
      if (!api) return;
      const p = await api.pickLogo();
      if (!p) return;
      state.wm.path = p; state.wm.on = true; $('wmOn').checked = true;
      await loadLogo(); wmChanged();
    };

    $('maxSide').value = String(state.maxSide);
    $('maxSide').onchange = () => { state.maxSide = +$('maxSide').value; store.set('maxSide', state.maxSide); };
    $('quality').value = state.quality;
    const q = () => { state.quality = +$('quality').value; $('qV').textContent = state.quality; store.set('quality', state.quality); };
    $('quality').oninput = q; q();
    syncSliders();
  }

  async function loadLogo() {
    if (!api || !state.wm.path) { $('logoName').textContent = 'none'; return; }
    try {
      const bytes = new Uint8Array(await api.readFile(state.wm.path));
      await ask({ type: 'logo', bytes });
      $('logoName').textContent = state.wm.path.split(/[\\/]/).pop();
    } catch {
      $('logoName').textContent = 'logo not found';
      state.wm.path = null;
    }
  }

  function syncSliders(moveKnobs = true) {
    for (const [key] of SLIDERS) {
      if (moveKnobs) $('s_' + key).value = state.settings[key];
      const v = state.settings[key];
      $('v_' + key).textContent = (v > 0 && (key === 'warmth' || key === 'vibrance' || key === 'brightness') ? '+' : '') + v;
    }
    document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', b.textContent === state.preset));
    store.set('settings', state.settings); store.set('preset', state.preset);
  }

  // ---------- photos ----------
  async function addPaths(paths) {
    const files = api ? await api.expandPaths(paths) : [];
    addPhotos(files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
  }

  function addPhotos(items) {
    const known = new Set(state.photos.map((p) => p.path || p.name));
    const fresh = items.filter((p) => !known.has(p.path || p.name));
    for (const p of fresh) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.title = p.name;
      el.innerHTML = '<img alt=""><span class="tag">…</span>';
      el.onclick = () => select(state.photos.indexOf(p));
      $('grid').appendChild(el);
      Object.assign(p, { el, skip: false, done: false });
      state.photos.push(p);
    }
    $('empty').hidden = state.photos.length > 0;
    updateExportButton();
    if (state.current < 0 && state.photos.length) select(0);
    makeThumbs(fresh);
  }

  async function makeThumbs(list) {
    for (const p of list) {
      try {
        const r = await askThumb({ type: 'thumb', bytes: await bytesOf(p) });
        p.el.querySelector('img').src = URL.createObjectURL(r.blob);
        p.stats = r.stats;
        const tag = p.el.querySelector('.tag');
        tag.textContent = describe(r.stats).short;
        tag.classList.toggle('warn', describe(r.stats).warn);
      } catch (err) {
        console.error(p.name, err);
        p.el.querySelector('.tag').textContent = 'cannot open';
        p.skip = true; p.el.classList.add('skip');
      }
    }
  }

  function describe(st) {
    const g = st && st.garment;
    if (!g) return { short: 'no white cloth', long: 'No white garment found: only your sliders apply', warn: false };
    const m = (g.r + g.g + g.b) / 3;
    const cast = g.g - m > 0.025 ? 'green light' : g.g - m < -0.025 ? 'pink light' : g.b - g.r > 0.06 ? 'blue light' : g.r - g.b > 0.06 ? 'yellow light' : '';
    const bright = st.clipped > 0.08 ? 'burnt whites' : g.lum < 0.68 ? 'dark' : '';
    const face = st.skinY != null && st.skinY < 0.38 ? 'dark faces' : '';
    const issues = [cast, bright, face].filter(Boolean);
    return { short: issues[0] || 'good', long: issues.length ? 'Found: ' + issues.join(', ') : 'Looks good already', warn: issues.length > 0 };
  }

  function select(i) {
    if (i < 0 || i >= state.photos.length) return;
    state.current = i;
    state.photos.forEach((p, k) => p.el.classList.toggle('on', k === i));
    $('skipOne').checked = state.photos[i].skip;
    state.photos[i].el.scrollIntoView({ block: 'nearest' });
    changed(true);
  }

  // ---------- preview ----------
  let pending = null, running = false, debounce = 0;
  function changed(now) {
    clearTimeout(debounce);
    debounce = setTimeout(preview, now ? 0 : 120);
  }
  async function preview() {
    const p = state.photos[state.current];
    if (!p) { $('after').removeAttribute('src'); $('before').removeAttribute('src'); return; }
    if (running) { pending = true; return; }
    running = true; $('busy').hidden = false;
    try {
      if (!p.preview) p.preview = await bytesOf(p);
      const box = $('stage').getBoundingClientRect();
      const maxSide = Math.min(2400, Math.round(Math.max(box.width, box.height) * (window.devicePixelRatio || 1)));
      const r = await ask({ type: 'preview', bytes: p.preview, settings: state.settings, crop: state.crop, watermark: state.wm, maxSide });
      swap($('after'), r.after); swap($('before'), r.before);
      $('info').textContent = `${p.name}  ·  ${describe(r.stats).long}`;
      // free memory of photos we are not looking at
      state.photos.forEach((q, k) => { if (Math.abs(k - state.current) > 2) q.preview = null; });
    } catch (err) {
      $('info').textContent = `${p.name}: cannot open (${err.message})`;
    } finally {
      running = false; $('busy').hidden = true;
      if (pending) { pending = false; preview(); }
    }
  }
  function swap(img, blob) {
    const old = img.src;
    img.src = URL.createObjectURL(blob);
    if (old && old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1000);
  }

  // before/after split
  function setSplit(x) {
    const r = $('stage').getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, (x - r.left) / r.width * 100));
    $('split').style.left = pct + '%';
    $('beforeWrap').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  }
  $('split').addEventListener('pointerdown', (e) => {
    $('split').setPointerCapture(e.pointerId);
    const move = (ev) => setSplit(ev.clientX);
    $('split').addEventListener('pointermove', move);
    $('split').addEventListener('pointerup', () => $('split').removeEventListener('pointermove', move), { once: true });
  });
  $('compare').onchange = () => $('stage').classList.toggle('nocompare', !$('compare').checked);
  $('skipOne').onchange = () => {
    const p = state.photos[state.current]; if (!p) return;
    p.skip = $('skipOne').checked; p.el.classList.toggle('skip', p.skip); updateExportButton();
  };

  // keyboard: arrows move, space holds "before"
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.target.type === 'range') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { select(state.current + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { select(state.current - 1); e.preventDefault(); }
  });

  // ---------- add / drop ----------
  $('add').onclick = async () => {
    try { if (api) addPhotos((await api.pickPhotos()).map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }))); }
    catch (err) { showError('Could not add photos', err); }
  };
  $('addFolder').onclick = async () => {
    try {
      if (!api) return;
      const files = await api.pickFolder();
      if (!files.length) { $('info').textContent = 'No JPG, PNG or WEBP photos found in that folder.'; return; }
      addPhotos(files.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() })));
    } catch (err) { showError('Could not add folder', err); }
  };
  $('clear').onclick = () => {
    if (state.exporting) return;
    state.photos = []; state.current = -1; $('grid').innerHTML = ''; $('empty').hidden = false;
    $('after').removeAttribute('src'); $('before').removeAttribute('src'); $('info').textContent = '';
    updateExportButton();
  };
  const list = $('list');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); list.classList.add('drop'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) list.classList.remove('drop'); }));
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])];
    if (api) addPaths(files.map((f) => api.pathForFile(f)).filter(Boolean));
    else addPhotos(files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name)).map((f) => ({ file: f, name: f.name })));
  });

  // ---------- export ----------
  function updateExportButton() {
    const n = state.photos.filter((p) => !p.skip).length;
    $('export').textContent = state.exporting ? 'Stop' : n ? `Export ${n} photo${n === 1 ? '' : 's'}` : 'Export all photos';
    $('export').disabled = !state.exporting && !n;
  }

  $('export').onclick = async () => {
    if (state.exporting) { state.exporting = false; return; }
    if (!api) return;
    const first = state.photos.find((p) => p.path);
    const suggested = first ? first.path.replace(/[\\/][^\\/]+$/, '') : undefined;
    const out = await api.pickOutput(suggested);
    if (!out) return;
    await exportAll(out);
  };

  async function exportAll(out) {
    const todo = state.photos.filter((p) => !p.skip);
    state.exporting = true; updateExportButton();
    $('progress').hidden = false;
    let ok = 0, failed = 0;
    const started = Date.now();
    for (let i = 0; i < todo.length && state.exporting; i++) {
      const p = todo[i];
      $('progress').querySelector('span').textContent = `${i + 1} of ${todo.length}: ${p.name}`;
      try {
        const r = await ask({
          type: 'export', bytes: await bytesOf(p), settings: state.settings, crop: state.crop,
          watermark: state.wm, maxSide: state.maxSide, quality: state.quality,
        });
        const base = p.name.replace(/\.[^.]+$/, '');
        await api.writeFile(out, `${base}-GC.jpg`, new Uint8Array(r.bytes));
        p.done = true; ok++;
        if (!p.el.querySelector('.done')) p.el.insertAdjacentHTML('beforeend', '<span class="done">✓</span>');
      } catch (err) {
        failed++; console.error(p.name, err);
      }
      $('progress').querySelector('i').style.width = ((i + 1) / todo.length * 100) + '%';
    }
    const secs = Math.round((Date.now() - started) / 1000);
    $('progress').querySelector('span').innerHTML =
      `${state.exporting ? 'Done' : 'Stopped'}: ${ok} saved${failed ? `, ${failed} failed` : ''} in ${secs}s. <button class="link" id="openOut">Open folder</button>`;
    $('openOut').onclick = () => api.openFolder(out);
    state.exporting = false; updateExportButton();
    return { ok, failed };
  }

  function showError(what, err) {
    $('info').textContent = `${what}: ${err && err.message || err}`;
    console.error(what, err);
  }
  window.addEventListener('error', (e) => showError('Problem', e.message));
  window.addEventListener('unhandledrejection', (e) => showError('Problem', e.reason));
  worker.onerror = thumbWorker.onerror = (e) => showError('Photo engine did not start', e.message || 'worker error');

  // ---------- start ----------
  buildPanel();
  loadLogo();
  if (api) api.version().then((v) => { $('ver').textContent = 'v' + v; });
  window.addEventListener('resize', () => changed());
  window.__gcr = { state, addPhotos, select, preview, exportAll }; // for tests
})();
