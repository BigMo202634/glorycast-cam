/* Does the heavy work off the window so the app never freezes. */
importScripts('engine.js');

let logo = null; // ImageBitmap

async function decode(bytes, maxSide) {
  const blob = new Blob([bytes]);
  const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  if (!maxSide || Math.max(full.width, full.height) <= maxSide) return full;
  const k = maxSide / Math.max(full.width, full.height);
  const w = Math.round(full.width * k), h = Math.round(full.height * k);
  const bmp = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  full.close();
  return bmp;
}

function measure(bmp) {
  // analysis always on a small copy: fast and the same for preview and export
  const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, w, h);
  return GCEngine.analyse(x.getImageData(0, 0, w, h).data, w, h);
}

function render(bmp, stats, settings, opts) {
  const crop = GCEngine.CROPS[opts.crop] || GCEngine.CROPS.original;
  const r = GCEngine.cropRect(bmp.width, bmp.height, crop.ratio, stats.skinCenter);
  let ow = r.w, oh = r.h;
  if (opts.full && crop.size) { ow = crop.size[0]; oh = crop.size[1]; }
  else if (opts.full && opts.maxSide && Math.max(ow, oh) > opts.maxSide) {
    const k = opts.maxSide / Math.max(ow, oh); ow = Math.round(ow * k); oh = Math.round(oh * k);
  }
  const c = new OffscreenCanvas(ow, oh), x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, ow, oh);
  if (!opts.before) {
    const img = x.getImageData(0, 0, ow, oh);
    GCEngine.apply(img.data, ow, oh, GCEngine.plan(stats, settings));
    x.putImageData(img, 0, 0);
  }
  if (logo && opts.watermark && opts.watermark.on) drawLogo(x, ow, oh, opts.watermark);
  return c;
}

function drawLogo(x, w, h, wm) {
  const lw = Math.round(Math.min(w, h) * (wm.size / 100));
  const lh = Math.round(lw * logo.height / logo.width);
  const pad = Math.round(Math.min(w, h) * 0.03);
  const pos = wm.position || 'bottom-right';
  const lx = pos.endsWith('left') ? pad : pos.endsWith('center') ? Math.round((w - lw) / 2) : w - lw - pad;
  const ly = pos.startsWith('top') ? pad : h - lh - pad;
  x.globalAlpha = wm.opacity / 100;
  x.drawImage(logo, lx, ly, lw, lh);
  x.globalAlpha = 1;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'logo') {
      if (logo) logo.close();
      logo = m.bytes ? await createImageBitmap(new Blob([m.bytes])) : null;
      self.postMessage({ id: m.id, ok: true });
    } else if (m.type === 'thumb') {
      const bmp = await decode(m.bytes, 360);
      const stats = measure(bmp);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
      self.postMessage({ id: m.id, ok: true, blob, stats });
    } else if (m.type === 'preview') {
      const bmp = await decode(m.bytes, m.maxSide || 1600);
      const stats = m.stats || measure(bmp);
      const after = render(bmp, stats, m.settings, { crop: m.crop, watermark: m.watermark });
      const before = m.noBefore ? null : render(bmp, stats, m.settings, { crop: m.crop, before: true });
      bmp.close();
      const [a, b] = await Promise.all([
        after.convertToBlob({ type: 'image/jpeg', quality: 0.9 }),
        before ? before.convertToBlob({ type: 'image/jpeg', quality: 0.9 }) : null,
      ]);
      self.postMessage({ id: m.id, ok: true, after: a, before: b, stats });
    } else if (m.type === 'export') {
      const bmp = await decode(m.bytes, 0);
      const stats = measure(bmp);
      const c = render(bmp, stats, m.settings, {
        crop: m.crop, watermark: m.watermark, full: true, maxSide: m.maxSide,
      });
      bmp.close();
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: m.quality / 100 });
      const buf = await blob.arrayBuffer();
      self.postMessage({ id: m.id, ok: true, bytes: buf }, [buf]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
