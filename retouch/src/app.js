/* GloryCast Retouch 0.2 window logic: per-photo edits, presets, history, sync, pick/reject, export. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.gcr; // from preload (Electron). Absent in a plain browser test.
  const D = GCEngine.DEFAULTS;

  // ---------- tools ----------
  const AI_TOOLS = [
    ['White garments & light'],
    ['colour', 'Fix colour cast', 0, 100, 'Uses white garments to remove green, yellow or pink light'],
    ['exposure', 'Fix white brightness', 0, 100, 'Brings white cloth to a clean, bright level'],
    ['highlights', 'Save burnt whites', 0, 100, 'Brings back folds in over-bright garments'],
    ['iron', 'Iron clothes', 0, 100, 'Softens creases on white cloth, keeps pleats and seams'],
    ['Faces & skin'],
    ['face', 'Brighten faces', 0, 100, 'Lifts faces that look dark next to white cloth'],
    ['skin', 'Smooth skin', 0, 100, 'Evens skin, keeps eyes, lips and texture'],
    ['blemish', 'Remove blemishes', 0, 100, 'Lightens small dark spots, leaves brows and lashes'],
  ];
  const ADJUST_TOOLS = [
    ['White balance'],
    ['temp', 'Temperature', -100, 100, 'Left cooler / right warmer'],
    ['tint', 'Tint', -100, 100, 'Left greener / right more magenta'],
    ['Light'],
    ['ev', 'Exposure', -100, 100, ''],
    ['contrast', 'Contrast', -100, 100, ''],
    ['hiTone', 'Highlights', -100, 100, ''],
    ['shadows', 'Shadows', -100, 100, ''],
    ['whites', 'Whites', -100, 100, ''],
    ['blacks', 'Blacks', -100, 100, ''],
    ['Colour & detail'],
    ['vibrance', 'Vibrance', -100, 100, 'Livelier colours, gentle on skin'],
    ['saturation', 'Saturation', -100, 100, ''],
    ['sharpen', 'Sharpen', 0, 100, ''],
  ];
  const LABEL = Object.fromEntries([...AI_TOOLS, ...ADJUST_TOOLS].filter((t) => t.length > 1).map((t) => [t[0], t[1]]));

  const BUILTIN = {
    'GloryCast Auto': {},
    'Clean & cool': { temp: -15, iron: 45, skin: 45, exposure: 75, vibrance: 15, ev: 4, blemish: 35 },
    'Outdoor': { colour: 55, exposure: 45, highlights: 75, face: 55 },
    'Indoor tube lights': { colour: 90, exposure: 65, face: 55 },
    'Night / stage': { colour: 50, exposure: 50, highlights: 45, face: 70, skin: 40, shadows: 15 },
    'Portrait glow': { skin: 60, blemish: 50, face: 60, iron: 50, hiTone: -15, shadows: 15, vibrance: 15, sharpen: 15 },
    'Gentle': { colour: 45, exposure: 35, highlights: 40, face: 30, skin: 20, blemish: 15, iron: 15 },
    'Original (no AI)': { colour: 0, exposure: 0, highlights: 0, face: 0, skin: 0, blemish: 0, iron: 0, vibrance: 0 },
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('gcr.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('gcr.' + k, JSON.stringify(v)); } catch { /* full or blocked */ } },
  };

  const state = {
    photos: [],          // {path|file, name, el, settings, preset, hist:[{label,settings}], hpos, flag, edited, stats, done}
    current: -1,
    selected: new Set(), // indexes
    anchor: -1,
    filter: 'all',
    userPresets: store.get('userPresets', {}),
    newPreset: store.get('newPreset', 'GloryCast Auto'),
    clipboard: null,
    crop: store.get('crop', 'original'),
    wm: Object.assign({ on: false, position: 'bottom-right', size: 15, opacity: 85, path: null }, store.get('wm', {})),
    maxSide: store.get('maxSide', 2048),
    quality: store.get('quality', 92),
    compare: true, zoom: false,
    exporting: false,
  };
  const allPresets = () => Object.assign({}, BUILTIN, state.userPresets);
  const presetSettings = (name) => Object.assign({}, D, allPresets()[name] || {});
  const cur = () => state.photos[state.current];
  const key = (p) => p.path || p.name;

  // ---------- workers ----------
  function makeWorker() {
    const w = new Worker('worker.js'), waiting = new Map();
    w.onmessage = (e) => { const x = waiting.get(e.data.id); if (x) { waiting.delete(e.data.id); e.data.ok ? x.resolve(e.data) : x.reject(new Error(e.data.error)); } };
    w.onerror = (e) => showError('Photo engine did not start', e.message || 'worker error');
    return (msg, transfer) => new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      waiting.set(id, { resolve, reject });
      w.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }
  const ask = makeWorker();       // big preview + export
  const askThumb = makeWorker();  // thumbnails, never blocks the preview
  async function bytesOf(p) {
    if (p.file) return new Uint8Array(await p.file.arrayBuffer());
    return new Uint8Array(await api.readFile(p.path));
  }

  // ---------- sliders ----------
  function buildSliders(boxId, tools) {
    const box = $(boxId);
    for (const t of tools) {
      if (t.length === 1) { const h = document.createElement('h3'); h.textContent = t[0]; box.appendChild(h); continue; }
      const [k, label, min, max, help] = t;
      const l = document.createElement('label');
      l.className = 'slider'; l.id = 'row_' + k;
      l.innerHTML = `<span><b>${label}</b> <i id="v_${k}" title="Double-click to reset"></i></span>` +
        `<input type="range" id="s_${k}" min="${min}" max="${max}">` + (help ? `<small>${help}</small>` : '');
      box.appendChild(l);
      const input = l.querySelector('input');
      let startVal = null;
      input.addEventListener('pointerdown', () => { startVal = cur() && cur().settings[k]; });
      input.addEventListener('input', () => {
        const p = cur(); if (!p) return;
        p.settings[k] = +input.value; showValue(k);
        changed();
      });
      input.addEventListener('change', () => {
        const p = cur(); if (!p) return;
        if (startVal !== p.settings[k]) commit(`${label} ${fmt(p.settings[k])}`);
        startVal = null;
      });
      const reset = () => { const p = cur(); if (!p) return; p.settings[k] = presetSettings(p.preset)[k]; syncPanel(); changed(); commit(`${label} reset`); };
      input.addEventListener('dblclick', reset);
      l.querySelector('i').addEventListener('dblclick', reset);
    }
  }
  const fmt = (v) => (v > 0 ? '+' + v : String(v));
  function showValue(k) {
    const p = cur(); const v = p ? p.settings[k] : D[k];
    const el = $('v_' + k); if (!el) return;
    el.textContent = fmt(v);
    const base = p ? presetSettings(p.preset)[k] : D[k];
    $('row_' + k).classList.toggle('changed', v !== base);
  }
  function syncPanel() {
    const p = cur();
    for (const k of Object.keys(LABEL)) {
      const s = $('s_' + k); if (!s) continue;
      s.value = p ? p.settings[k] : D[k];
      s.disabled = !p;
      showValue(k);
    }
    renderPresets(); renderHistory(); renderFlags();
    const n = state.selected.size;
    $('editScope').textContent = p ? (n > 1 ? `Editing 1 photo · ${n} selected` : 'Editing this photo') : '';
  }

  // ---------- history ----------
  function commit(label) {
    const p = cur(); if (!p) return;
    p.hist = p.hist.slice(0, p.hpos + 1);
    p.hist.push({ label, settings: Object.assign({}, p.settings), preset: p.preset });
    if (p.hist.length > 80) p.hist.shift();
    p.hpos = p.hist.length - 1;
    p.edited = true;
    afterEdit(p);
  }
  function goHistory(i) {
    const p = cur(); if (!p || i < 0 || i >= p.hist.length) return;
    p.hpos = i;
    p.settings = Object.assign({}, p.hist[i].settings); p.preset = p.hist[i].preset;
    p.edited = i > 0;
    syncPanel(); changed(); afterEdit(p);
  }
  function renderHistory() {
    const box = $('historyList'); box.innerHTML = '';
    const p = cur(); if (!p) return;
    p.hist.forEach((h, i) => {
      const d = document.createElement('div');
      d.className = 'item' + (i === p.hpos ? ' on' : '') + (i > p.hpos ? ' future' : '');
      d.textContent = h.label;
      d.onclick = () => goHistory(i);
      box.prepend(d);
    });
    $('undo').disabled = p.hpos <= 0; $('redo').disabled = p.hpos >= p.hist.length - 1;
  }
  function afterEdit(p) {
    p.el.querySelector('.edited').hidden = !p.edited;
    renderHistory();
    saveEdits(p);
    queueThumb(p);
  }
  // remember edits per photo, so closing the app keeps your work
  function saveEdits(p) {
    if (!p.path) return;
    const all = store.get('edits', {});
    all[p.path] = { settings: p.settings, preset: p.preset, flag: p.flag || null, edited: p.edited, t: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 3000) keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 3000).forEach((k) => delete all[k]);
    store.set('edits', all);
  }

  // ---------- presets ----------
  function renderPresets() {
    const box = $('presetList'); box.innerHTML = '';
    const p = cur();
    for (const name of Object.keys(allPresets())) {
      const d = document.createElement('div');
      const isUser = name in state.userPresets;
      d.className = 'item' + (p && p.preset === name ? ' on' : '');
      d.innerHTML = `<span></span>${isUser ? '<span class="x" title="Delete preset">✕</span>' : ''}`;
      d.firstChild.textContent = name;
      d.title = 'Click: apply to this photo' + (state.selected.size > 1 ? ' and all selected' : '') + '. New photos also start with it.';
      d.onclick = (e) => {
        if (e.target.classList.contains('x')) {
          delete state.userPresets[name]; store.set('userPresets', state.userPresets); renderPresets(); return;
        }
        applyPreset(name);
      };
      box.appendChild(d);
    }
  }
  function applyPreset(name) {
    state.newPreset = name; store.set('newPreset', name);
    const targets = new Set(state.selected); if (state.current >= 0) targets.add(state.current);
    for (const i of targets) {
      const p = state.photos[i];
      p.preset = name; p.settings = presetSettings(name);
      if (i === state.current) commit(`Preset: ${name}`);
      else { pushHist(p, `Preset: ${name}`); afterEdit(p); }
    }
    syncPanel(); changed();
  }
  function pushHist(p, label) {
    p.hist = p.hist.slice(0, p.hpos + 1);
    p.hist.push({ label, settings: Object.assign({}, p.settings), preset: p.preset });
    p.hpos = p.hist.length - 1; p.edited = true;
  }
  $('savePreset').onclick = () => {
    if (!cur()) return;
    $('presetName').value = ''; $('presetDlg').hidden = false; $('presetName').focus();
  };
  $('presetCancel').onclick = () => { $('presetDlg').hidden = true; };
  $('presetOk').onclick = () => {
    const name = $('presetName').value.trim(); if (!name) return;
    const s = {}; const p = cur();
    for (const k of Object.keys(D)) if (p.settings[k] !== D[k]) s[k] = p.settings[k];
    state.userPresets[name] = s; store.set('userPresets', state.userPresets);
    p.preset = name; $('presetDlg').hidden = true; renderPresets(); commit(`Saved preset ${name}`);
  };
  $('presetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('presetOk').click(); if (e.key === 'Escape') $('presetCancel').click(); });

  // ---------- sync / copy / paste ----------
  function copyTo(indexes, settings, label) {
    let n = 0;
    for (const i of indexes) {
      if (i === state.current) continue;
      const p = state.photos[i];
      p.settings = Object.assign({}, settings.settings); p.preset = settings.preset;
      pushHist(p, label); afterEdit(p); n++;
    }
    $('info').textContent = `${label}: ${n} photo${n === 1 ? '' : 's'} updated`;
  }
  const snapshot = () => ({ settings: Object.assign({}, cur().settings), preset: cur().preset });
  $('syncBtn').onclick = () => { if (cur()) copyTo([...state.selected], snapshot(), 'Synced'); };
  $('syncAllBtn').onclick = () => { if (cur()) copyTo(state.photos.map((_, i) => i), snapshot(), 'Synced to all'); };
  $('copyBtn').onclick = () => { if (cur()) { state.clipboard = snapshot(); $('info').textContent = 'Edit copied. Select photos and Paste.'; } };
  $('pasteBtn').onclick = () => {
    if (!state.clipboard) return;
    const targets = state.selected.size ? [...state.selected] : [state.current];
    for (const i of targets) {
      const p = state.photos[i];
      p.settings = Object.assign({}, state.clipboard.settings); p.preset = state.clipboard.preset;
      if (i === state.current) commit('Pasted edit'); else { pushHist(p, 'Pasted edit'); afterEdit(p); }
    }
    syncPanel(); changed();
  };
  $('resetPhoto').onclick = () => {
    const p = cur(); if (!p) return;
    p.settings = presetSettings(state.newPreset); p.preset = state.newPreset;
    commit('Reset'); p.edited = false; afterEdit(p); syncPanel(); changed();
  };
  $('undo').onclick = () => { const p = cur(); if (p) goHistory(p.hpos - 1); };
  $('redo').onclick = () => { const p = cur(); if (p) goHistory(p.hpos + 1); };

  // ---------- photos & filmstrip ----------
  function addPhotos(items) {
    const known = new Set(state.photos.map(key));
    const saved = store.get('edits', {});
    const fresh = items.filter((p) => !known.has(key(p)));
    for (const p of fresh) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.title = p.name;
      el.innerHTML = '<img alt=""><span class="edited" hidden></span><span class="flag" hidden></span><span class="tag">…</span>';
      el.onclick = (e) => clickThumb(state.photos.indexOf(p), e);
      $('strip').appendChild(el);
      const prev = p.path && saved[p.path];
      Object.assign(p, {
        el, flag: prev ? prev.flag : null, edited: prev ? !!prev.edited : false,
        preset: prev ? prev.preset : state.newPreset,
        settings: prev ? Object.assign({}, D, prev.settings) : presetSettings(state.newPreset),
      });
      p.hist = [{ label: prev && prev.edited ? 'Opened (your saved edit)' : 'Opened', settings: Object.assign({}, p.settings), preset: p.preset }];
      p.hpos = 0;
      el.querySelector('.edited').hidden = !p.edited;
      state.photos.push(p);
      renderFlag(p);
    }
    $('empty').hidden = state.photos.length > 0;
    if (state.current < 0 && state.photos.length) select(0);
    applyFilter();
    makeThumbs(fresh);
  }

  let thumbQueue = [], thumbBusy = false;
  function makeThumbs(list) { thumbQueue.push(...list.map((p) => ({ p, first: true }))); pumpThumbs(); }
  function queueThumb(p) { if (!thumbQueue.some((q) => q.p === p && !q.first)) thumbQueue.push({ p, first: false }); pumpThumbs(); }
  async function pumpThumbs() {
    if (thumbBusy) return; thumbBusy = true;
    while (thumbQueue.length) {
      const { p, first } = thumbQueue.shift();
      if (!state.photos.includes(p)) continue;
      try {
        if (!p.thumbBytes) {
          const r = await askThumb({ type: 'thumb', bytes: await bytesOf(p) });
          p.stats = r.stats;
          p.thumbBytes = new Uint8Array(await r.blob.arrayBuffer());
          const tag = p.el.querySelector('.tag'); const d = describe(r.stats);
          tag.textContent = d.short; tag.classList.toggle('warn', d.warn);
        }
        // thumbnail shows the edited photo
        const r = await askThumb({ type: 'preview', bytes: p.thumbBytes, settings: p.settings, crop: 'original', maxSide: 360, noBefore: true });
        const img = p.el.querySelector('img'); const old = img.src;
        img.src = URL.createObjectURL(r.after);
        if (old.startsWith('blob:')) URL.revokeObjectURL(old);
      } catch (err) {
        console.error(p.name, err);
        if (first) { p.el.querySelector('.tag').textContent = 'cannot open'; p.flag = 'reject'; renderFlag(p); }
      }
    }
    thumbBusy = false;
  }

  function describe(st) {
    const g = st && st.garment;
    if (!g) return { short: 'no white cloth', long: 'No white garment found: AI colour fix stays off', warn: false };
    const m = (g.r + g.g + g.b) / 3;
    const cast = g.g - m > 0.025 ? 'green light' : g.g - m < -0.025 ? 'pink light' : g.r - g.b > 0.06 ? 'yellow light' : '';
    const bright = st.clipped > 0.08 ? 'burnt whites' : g.lum < 0.68 ? 'dark' : '';
    const face = st.skinY != null && st.skinY < 0.38 ? 'dark faces' : '';
    const issues = [cast, bright, face].filter(Boolean);
    return { short: issues[0] || 'good', long: issues.length ? 'AI found: ' + issues.join(', ') : 'AI: looks good already', warn: issues.length > 0 };
  }

  function clickThumb(i, e) {
    if (i < 0) return;
    if (e.shiftKey && state.anchor >= 0) {
      const [a, b] = [Math.min(state.anchor, i), Math.max(state.anchor, i)];
      if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
      for (let k = a; k <= b; k++) if (visible(state.photos[k])) state.selected.add(k);
      select(i, true);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(i) && state.selected.size > 1) state.selected.delete(i); else state.selected.add(i);
      state.anchor = i; select(i, true);
    } else {
      state.selected = new Set([i]); state.anchor = i; select(i, true);
    }
  }
  function select(i, keepSel) {
    if (i < 0 || i >= state.photos.length) return;
    state.current = i;
    if (!keepSel) { state.selected = new Set([i]); state.anchor = i; }
    state.selected.add(i);
    state.photos.forEach((p, k) => { p.el.classList.toggle('on', k === i); p.el.classList.toggle('sel', state.selected.has(k)); });
    state.photos[i].el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncPanel(); changed(true); updateCount();
  }
  function step(dir) {
    let i = state.current;
    do { i += dir; } while (i >= 0 && i < state.photos.length && !visible(state.photos[i]));
    if (i >= 0 && i < state.photos.length) select(i);
  }

  // flags and filter
  function renderFlag(p) {
    const f = p.el.querySelector('.flag');
    f.hidden = !p.flag; f.className = 'flag ' + (p.flag || '');
    f.textContent = p.flag === 'pick' ? '✓' : p.flag === 'reject' ? '✕' : '';
    p.el.classList.toggle('reject', p.flag === 'reject');
  }
  function renderFlags() {
    const p = cur();
    $('pickBtn').classList.toggle('on', !!p && p.flag === 'pick');
    $('rejectBtn').classList.toggle('on', !!p && p.flag === 'reject');
  }
  function setFlag(flag) {
    const targets = state.selected.size ? [...state.selected] : [state.current];
    const p0 = cur(); if (!p0) return;
    const value = p0.flag === flag ? null : flag;
    for (const i of targets) { const p = state.photos[i]; p.flag = value; renderFlag(p); saveEdits(p); }
    renderFlags(); applyFilter();
  }
  $('pickBtn').onclick = () => setFlag('pick');
  $('rejectBtn').onclick = () => setFlag('reject');
  const visible = (p) => state.filter === 'all' || (state.filter === 'pick' && p.flag === 'pick') ||
    (state.filter === 'reject' && p.flag === 'reject') || (state.filter === 'edited' && p.edited) ||
    (state.filter === 'unflagged' && !p.flag);
  function applyFilter() {
    state.photos.forEach((p) => { p.el.style.display = visible(p) ? '' : 'none'; });
    updateCount();
  }
  function updateCount() {
    const n = state.photos.length, picks = state.photos.filter((p) => p.flag === 'pick').length;
    $('count').textContent = n ? `${n} photos · ${picks} picked · ${state.selected.size} selected` : '';
  }
  $('filter').onchange = () => { state.filter = $('filter').value; applyFilter(); };
  $('selAll').onclick = () => {
    state.selected = new Set(state.photos.map((p, i) => (visible(p) ? i : -1)).filter((i) => i >= 0));
    state.photos.forEach((p, k) => p.el.classList.toggle('sel', state.selected.has(k)));
    syncPanel(); updateCount();
  };

  // ---------- preview ----------
  let pending = false, running = false, debounce = 0, centerNext = false;
  function changed(now) { clearTimeout(debounce); debounce = setTimeout(preview, now ? 0 : 90); }
  async function preview() {
    const p = cur();
    if (!p) { $('after').removeAttribute('src'); $('before').removeAttribute('src'); return; }
    if (running) { pending = true; return; }
    running = true; $('busy').hidden = false;
    try {
      if (!p.preview) p.preview = await bytesOf(p);
      const box = $('stage').getBoundingClientRect();
      const maxSide = state.zoom ? 100000 : Math.min(2400, Math.round(Math.max(box.width, box.height) * (window.devicePixelRatio || 1)));
      const r = await ask({ type: 'preview', bytes: p.preview, settings: p.settings, crop: state.crop, watermark: state.wm, maxSide });
      swap($('after'), r.after); swap($('before'), r.before);
      if (state.zoom && centerNext) {
        centerNext = false;
        $('after').onload = () => {
          $('after').onload = null;
          const st = $('stage');
          st.scrollLeft = (st.scrollWidth - st.clientWidth) / 2; st.scrollTop = (st.scrollHeight - st.clientHeight) / 2;
        };
      }
      p.stats = p.stats || r.stats;
      $('info').textContent = `${p.name} · ${describe(r.stats).long}`;
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
    if (old && old.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(old), 1500);
  }

  // before/after split
  function setSplit(x) {
    const r = $('canvas').getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, (x - r.left) / r.width * 100));
    $('split').style.left = pct + '%';
    $('beforeWrap').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  }
  $('split').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    $('split').setPointerCapture(e.pointerId);
    const move = (ev) => setSplit(ev.clientX);
    $('split').addEventListener('pointermove', move);
    $('split').addEventListener('pointerup', () => $('split').removeEventListener('pointermove', move), { once: true });
  });
  function setCompare(on) { state.compare = on; $('stage').classList.toggle('nocompare', !on); $('cmpBtn').classList.toggle('on', on); }
  $('cmpBtn').onclick = () => setCompare(!state.compare);
  function setZoom(on) {
    state.zoom = on; $('stage').classList.toggle('zoom', on); $('zoomBtn').classList.toggle('on', on);
    $('zoomBtn').textContent = on ? '100%' : 'Fit'; centerNext = on; changed(true);
  }
  $('zoomBtn').onclick = () => setZoom(!state.zoom);
  $('stage').addEventListener('dblclick', () => { if (cur()) setZoom(!state.zoom); });
  // drag to pan when zoomed
  $('stage').addEventListener('pointerdown', (e) => {
    if (!state.zoom) return;
    const st = $('stage'), sx = e.clientX, sy = e.clientY, l = st.scrollLeft, t = st.scrollTop;
    const move = (ev) => { st.scrollLeft = l - (ev.clientX - sx); st.scrollTop = t - (ev.clientY - sy); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', () => window.removeEventListener('pointermove', move), { once: true });
  });

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
    };
  });

  // ---------- crop & logo ----------
  function buildCrop() {
    const crop = $('crop');
    for (const [k, c] of Object.entries(GCEngine.CROPS)) {
      const o = document.createElement('option'); o.value = k; o.textContent = c.label; crop.appendChild(o);
    }
    crop.value = state.crop;
    crop.onchange = () => { state.crop = crop.value; store.set('crop', state.crop); changed(); };
    $('wmOn').checked = state.wm.on; $('wmPos').value = state.wm.position;
    $('wmSize').value = state.wm.size; $('wmOp').value = state.wm.opacity;
    const wmChanged = () => {
      state.wm.on = $('wmOn').checked; state.wm.position = $('wmPos').value;
      state.wm.size = +$('wmSize').value; state.wm.opacity = +$('wmOp').value;
      $('wmSizeV').textContent = state.wm.size + '%'; $('wmOpV').textContent = state.wm.opacity + '%';
      store.set('wm', state.wm); changed();
    };
    ['wmOn', 'wmPos'].forEach((id) => { $(id).onchange = wmChanged; });
    ['wmSize', 'wmOp'].forEach((id) => { $(id).oninput = wmChanged; });
    wmChanged();
    $('pickLogo').onclick = async () => {
      if (!api) return;
      const p = await api.pickLogo(); if (!p) return;
      state.wm.path = p; state.wm.on = true; $('wmOn').checked = true;
      await loadLogo(); wmChanged();
    };
  }
  async function loadLogo() {
    if (!api || !state.wm.path) { $('logoName').textContent = 'none'; return; }
    try {
      await ask({ type: 'logo', bytes: new Uint8Array(await api.readFile(state.wm.path)) });
      $('logoName').textContent = state.wm.path.split(/[\\/]/).pop();
    } catch { $('logoName').textContent = 'logo not found'; state.wm.path = null; }
  }

  // ---------- add / drop / clear ----------
  const asItems = (paths) => paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  $('add').onclick = async () => { try { if (api) addPhotos(asItems(await api.pickPhotos())); } catch (err) { showError('Could not add photos', err); } };
  $('addFolder').onclick = async () => {
    try {
      if (!api) return;
      const files = await api.pickFolder();
      if (!files.length) { $('info').textContent = 'No JPG, PNG or WEBP photos found in that folder.'; return; }
      addPhotos(asItems(files));
    } catch (err) { showError('Could not add folder', err); }
  };
  $('clear').onclick = () => {
    if (state.exporting) return;
    state.photos = []; state.current = -1; state.selected.clear(); thumbQueue = [];
    $('strip').innerHTML = ''; $('empty').hidden = false;
    $('after').removeAttribute('src'); $('before').removeAttribute('src'); $('info').textContent = '';
    syncPanel(); updateCount();
  };
  const stage = $('stage');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add('drop'); }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) stage.classList.remove('drop'); }));
  document.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer.files || [])];
    try {
      if (api) addPhotos(asItems(await api.expandPaths(files.map((f) => api.pathForFile(f)).filter(Boolean))));
      else addPhotos(files.filter((f) => /\.(jpe?g|png|webp)$/i.test(f.name)).map((f) => ({ file: f, name: f.name })));
    } catch (err) { showError('Could not add', err); }
  });

  // ---------- export ----------
  const scopeList = (scope) => state.photos.filter((p, i) =>
    scope === 'pick' ? p.flag === 'pick' : scope === 'sel' ? state.selected.has(i) : p.flag !== 'reject');
  $('exportBtn').onclick = () => {
    if (!state.photos.length) return;
    $('nAll').textContent = scopeList('all').length; $('nPick').textContent = scopeList('pick').length; $('nSel').textContent = scopeList('sel').length;
    $('maxSide').value = String(state.maxSide); $('quality').value = state.quality; $('qV').textContent = state.quality;
    $('progress').hidden = true; $('exportDlg').hidden = false;
  };
  $('maxSide').onchange = () => { state.maxSide = +$('maxSide').value; store.set('maxSide', state.maxSide); };
  $('quality').oninput = () => { state.quality = +$('quality').value; $('qV').textContent = state.quality; store.set('quality', state.quality); };
  $('expCancel').onclick = () => { if (state.exporting) state.exporting = false; else $('exportDlg').hidden = true; };
  $('expGo').onclick = async () => {
    if (!api || state.exporting) return;
    const scope = document.querySelector('input[name=scope]:checked').value;
    const todo = scopeList(scope);
    if (!todo.length) { $('progress').hidden = false; $('progress').querySelector('span').textContent = 'No photos in that choice.'; return; }
    const first = todo.find((p) => p.path);
    const out = await api.pickOutput(first ? first.path.replace(/[\\/][^\\/]+$/, '') : undefined);
    if (!out) return;
    await exportList(todo, out);
  };
  async function exportList(todo, out) {
    state.exporting = true; $('expGo').disabled = true; $('expCancel').textContent = 'Stop';
    $('progress').hidden = false;
    let ok = 0, failed = 0; const started = Date.now();
    for (let i = 0; i < todo.length && state.exporting; i++) {
      const p = todo[i];
      $('progress').querySelector('span').textContent = `${i + 1} of ${todo.length}: ${p.name}`;
      try {
        const r = await ask({ type: 'export', bytes: await bytesOf(p), settings: p.settings, crop: state.crop,
          watermark: state.wm, maxSide: state.maxSide, quality: state.quality });
        await api.writeFile(out, `${p.name.replace(/\.[^.]+$/, '')}-GC.jpg`, new Uint8Array(r.bytes));
        ok++;
        if (!p.el.querySelector('.done')) p.el.insertAdjacentHTML('beforeend', '<span class="done">⬇</span>');
      } catch (err) { failed++; console.error(p.name, err); }
      $('progress').querySelector('i').style.width = ((i + 1) / todo.length * 100) + '%';
    }
    const secs = Math.round((Date.now() - started) / 1000);
    $('progress').querySelector('span').innerHTML =
      `${state.exporting ? 'Done' : 'Stopped'}: ${ok} saved${failed ? `, ${failed} failed` : ''} in ${secs}s. <button class="link" id="openOut">Open folder</button>`;
    $('openOut').onclick = () => api.openFolder(out);
    state.exporting = false; $('expGo').disabled = false; $('expCancel').textContent = 'Close';
    return { ok, failed };
  }
  // used by the build self-test
  const exportAll = (out) => exportList(scopeList('all'), out);

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (!$('presetDlg').hidden || !$('exportDlg').hidden) { if (e.key === 'Escape') { $('presetDlg').hidden = true; if (!state.exporting) $('exportDlg').hidden = true; } return; }
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); return; }
    if (mod && k === 'y') { e.preventDefault(); $('redo').click(); return; }
    if (mod && k === 'c') { e.preventDefault(); $('copyBtn').click(); return; }
    if (mod && k === 'v') { e.preventDefault(); $('pasteBtn').click(); return; }
    if (mod && k === 'a') { e.preventDefault(); $('selAll').click(); return; }
    if (mod) return;
    if (e.target.type === 'range' && (k.startsWith('arrow'))) return;
    if (k === 'arrowright' || k === 'arrowdown') { step(1); e.preventDefault(); }
    else if (k === 'arrowleft' || k === 'arrowup') { step(-1); e.preventDefault(); }
    else if (k === 'p') setFlag('pick');
    else if (k === 'x') setFlag('reject');
    else if (k === 'u') { const t = state.selected.size ? [...state.selected] : [state.current]; t.forEach((i) => { const p = state.photos[i]; if (p) { p.flag = null; renderFlag(p); saveEdits(p); } }); renderFlags(); applyFilter(); }
    else if (k === 'b' || k === '\\') setCompare(!state.compare);
    else if (k === 'z') setZoom(!state.zoom);
  });

  // ---------- errors ----------
  function showError(what, err) { $('info').textContent = `${what}: ${err && err.message || err}`; console.error(what, err); }
  window.addEventListener('error', (e) => showError('Problem', e.message));
  window.addEventListener('unhandledrejection', (e) => showError('Problem', e.reason));

  // ---------- start ----------
  buildSliders('tab-ai', AI_TOOLS);
  buildSliders('tab-adjust', ADJUST_TOOLS);
  buildCrop();
  loadLogo();
  syncPanel();
  if (api) api.version().then((v) => { $('ver').textContent = 'v' + v; });
  window.addEventListener('resize', () => { if (!state.zoom) changed(); });
  window.__gcr = { state, addPhotos, select, preview, exportAll, applyPreset, clickThumb };
})();
