/* GloryCast Retouch engine.
 * Pure pixel code: works in the app window, in a worker, and in Node tests.
 * Images are RGBA Uint8ClampedArray (ImageData.data) with width and height.
 *
 * The "look" targets below were measured from Zion and partner photo sets
 * (Palm Sunday, Afobaje, Praise Concert = good; Appasionato 3.0 = green cast;
 * Harvest 2026 = pink cast; Unveiling = whites pushed too hard).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GCEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOOK = {
    garmentLum: 0.83,   // white cloth sits here in the good sets, not at 1.0
    skinY: 0.46,        // median face/skin brightness in the good sets
    knee: 0.86,
    coolKeep: 0.035,    // how much blue in white cloth we leave alone         // highlights above this are rolled off, so cloth keeps folds
  };

  // AI (automatic, measured per photo) + manual sliders. Every key at 0 = untouched,
  // except the AI ones which start at gentle defaults.
  const DEFAULTS = {
    // AI: white garments and light
    colour: 70,      // 0..100 remove colour cast measured on white garments
    exposure: 60,    // 0..100 bring white cloth to a clean bright level
    highlights: 60,  // 0..100 roll off burnt whites so folds come back
    // AI: people
    face: 50,        // 0..100 lift faces that are dark next to white cloth
    skin: 35,        // 0..100 smooth skin, keep texture
    blemish: 25,     // 0..100 lighten small dark spots on skin
    iron: 30,        // 0..100 smooth creases on white cloth, keep pleats
    // manual
    temp: 0,         // -100..100 cool .. warm
    tint: 0,         // -100..100 green .. magenta
    ev: 0,           // -100..100 exposure, 100 = +2 stops
    contrast: 0,     // -100..100
    hiTone: 0,       // -100..100 highlights
    shadows: 0,      // -100..100
    whites: 0,       // -100..100
    blacks: 0,       // -100..100
    vibrance: 10,    // -100..100
    saturation: 0,   // -100..100
    sharpen: 0,      // 0..100
  };


  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function skinWeight(r, g, b) {
    // YCbCr skin box, wide enough for dark and light African skin, soft edges.
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < 0.06 || y > 0.88) return 0;
    const cb = 0.5 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 0.5 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dcb = Math.max(0, Math.abs(cb - 0.40) - 0.06) / 0.04;
    const dcr = Math.max(0, Math.abs(cr - 0.595) - 0.055) / 0.04;
    const d = Math.max(dcb, dcr);
    if (d >= 1) return 0;
    // cloth that is only a bit warm is not skin: need some chroma
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (chroma < 0.05) return 0;
    return 1 - d;
  }

  /** Look at a (small) image and measure white cloth and skin. */
  function analyse(data, w, h) {
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
    let gr = 0, gg = 0, gb = 0, gn = 0, clipped = 0, total = 0;
    let sx = 0, sy = 0, sn = 0;
    const skinYs = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
        total++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mn > 0.985) { clipped++; continue; }
        const lum = (r + g + b) / 3;
        if (lum > 0.5 && mx - mn < 0.2 && skinWeight(r, g, b) < 0.3) {
          gr += r; gg += g; gb += b; gn++;
        }
        const sw = skinWeight(r, g, b);
        if (sw > 0.6) {
          skinYs.push(0.299 * r + 0.587 * g + 0.114 * b);
          sx += x; sy += y; sn++;
        }
      }
    }
    skinYs.sort((a, b) => a - b);
    const garment = gn > 200
      ? { r: gr / gn, g: gg / gn, b: gb / gn, lum: (gr + gg + gb) / (3 * gn), share: gn / total }
      : null;
    return {
      garment,
      skinY: skinYs.length > 200 ? skinYs[skinYs.length >> 1] : null,
      skinShare: sn / total,
      skinCenter: sn > 200 ? { x: sx / sn / w, y: sy / sn / h } : { x: 0.5, y: 0.45 },
      clipped: clipped / total,
    };
  }

  /** Turn measurements + slider settings into concrete numbers. */
  function plan(stats, s) {
    s = Object.assign({}, DEFAULTS, s || {});
    let gain = [1, 1, 1], expo = 1;
    const g = stats.garment;
    if (g) {
      const k = s.colour / 100;
      const m = (g.r + g.g + g.b) / 3;
      // a slightly cool (blue) white is a look people like, not a fault: keep a little of it
      const cool = Math.max(0, Math.min(LOOK.coolKeep, ((g.b - m) - (g.r - m)) / 2));
      const want = [m - cool, m, m + cool];
      gain = [want[0] / g.r, want[1] / g.g, want[2] / g.b].map((v) => 1 + k * (v - 1));
      const target = LOOK.garmentLum;
      let lift = Math.min(1.6, Math.max(0.8, target / g.lum));
      // bright, clean white is fine: only pull down whites that are really burnt
      if (lift < 1 && g.lum <= 0.9) lift = 1;
      expo = 1 + (s.exposure / 100) * (lift - 1);
    }
    // manual white balance and exposure on top of the AI fix
    const t = (s.temp || 0) / 100 * 0.25, ti = (s.tint || 0) / 100 * 0.15;
    gain = [gain[0] * (1 + t), gain[1] * (1 - ti), gain[2] * (1 - t)];
    expo *= Math.pow(2, (s.ev || 0) / 50);

    let lift = 0;
    if (stats.skinY != null && stats.skinShare > 0.002) {
      const short = (LOOK.skinY - stats.skinY * expo) / LOOK.skinY;
      lift = Math.max(0, Math.min(0.45, short)) * (s.face / 50);
    }
    return {
      gain, expo, lift,
      knee: 1 - (1 - LOOK.knee) * (0.4 + 1.2 * s.highlights / 100),
      hl: s.highlights / 100,
      smooth: s.skin / 100,
      iron: s.iron / 100,
      vibrance: s.vibrance / 100,
      saturation: (s.saturation || 0) / 100,
      blemish: (s.blemish || 0) / 100,
      sharpen: (s.sharpen || 0) / 100,
      tone: {
        contrast: (s.contrast || 0) / 100, hi: (s.hiTone || 0) / 100, sh: (s.shadows || 0) / 100,
        b0: -(s.blacks || 0) / 100 * 0.12, w0: 1 - (s.whites || 0) / 100 * 0.12,
      },
    };
  }

  // Manual tone curve on brightness (0..1). Returns the new brightness.
  function toneY(y, t) {
    y = (y - t.b0) / (t.w0 - t.b0);
    if (t.sh) y += t.sh * 0.35 * y * (1 - y) * (1 - y) * 2;
    if (t.hi) y += t.hi * 0.35 * y * y * (1 - y) * 2.5;
    if (t.contrast) y += t.contrast * 0.5 * (y - 0.5) * (1 - Math.min(1, Math.abs(2 * y - 1)) * 0.6);
    return y;
  }
  const toneOn = (t) => t.contrast || t.hi || t.sh || t.b0 || t.w0 !== 1;

  // Smooth roll-off above the knee: slope 1 at the knee, never passes 1.
  function rolloff(v, knee) {
    if (v <= knee) return v;
    const room = 1 - knee;
    const x = (v - knee) / room;
    return knee + room * (1 - Math.exp(-x));
  }

  function boxBlur(src, w, h, r) {
    // src: Float32Array of 3 channels interleaved. Separable running-sum box, two passes ~ gaussian.
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const pass = (a, b, horizontal) => {
      const len = horizontal ? w : h, lines = horizontal ? h : w;
      const norm = 1 / (2 * r + 1);
      for (let line = 0; line < lines; line++) {
        for (let c = 0; c < 3; c++) {
          const idx = (p) => (horizontal ? (line * w + p) : (p * w + line)) * 3 + c;
          let acc = 0;
          for (let p = -r; p <= r; p++) acc += a[idx(Math.min(len - 1, Math.max(0, p)))];
          for (let p = 0; p < len; p++) {
            b[idx(p)] = acc * norm;
            acc += a[idx(Math.min(len - 1, p + r + 1))] - a[idx(Math.max(0, p - r))];
          }
        }
      }
    };
    pass(src, tmp, true); pass(tmp, out, false);
    pass(out, tmp, true); pass(tmp, out, false);
    return out;
  }

  /** "Iron" white cloth: soften broad, low-contrast creases (mid frequencies)
   * while keeping fine weave texture and strong lines such as pleats and seams,
   * so it does not look plastic or AI-made. */
  function ironCloth(f, cloth, w, h, amount) {
    const n = w * h;
    const rs = Math.max(1, Math.round(Math.min(w, h) / 500));
    const rl = Math.max(rs + 2, Math.round(Math.min(w, h) / 40));
    const m3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) m3[i * 3] = m3[i * 3 + 1] = m3[i * 3 + 2] = cloth[i];
    const mb = boxBlur(m3, w, h, rs * 3);
    const small = boxBlur(f, w, h, rs);
    const large = boxBlur(f, w, h, rl);
    for (let i = 0; i < n; i++) {
      const m = Math.min(cloth[i], mb[i * 3]);
      if (m <= 0.01) continue;
      const k = i * 3;
      const ys = 0.299 * small[k] + 0.587 * small[k + 1] + 0.114 * small[k + 2];
      const yl = 0.299 * large[k] + 0.587 * large[k + 1] + 0.114 * large[k + 2];
      const mid = ys - yl;
      // soft creases are small dips; pleats/seams are big, sharp changes: keep those
      const guard = Math.max(0, 1 - Math.abs(mid) / 0.15);
      // creases are mostly shadows: lift dips more than bright ridges
      const a = amount * m * guard * (mid < 0 ? 1 : 0.5);
      // change brightness only, never colour: no skin or background bleeding in
      const d = -mid * a;
      f[k] += d; f[k + 1] += d; f[k + 2] += d;
    }
  }

  /** Small dark spots on skin (pimples, marks) are lifted toward the skin around them.
   * Big dark areas (eyes, brows, nostrils, beard) are left alone. */
  function removeBlemishes(f, skin, w, h, amount) {
    const n = w * h;
    const r = Math.max(2, Math.round(Math.min(w, h) / 100));
    const m3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) m3[i * 3] = m3[i * 3 + 1] = m3[i * 3 + 2] = skin[i];
    const mb = boxBlur(m3, w, h, r * 2);
    const bl = boxBlur(f, w, h, r);
    for (let i = 0; i < n; i++) {
      const m = mb[i * 3];
      if (m < 0.75 || skin[i] < 0.4) continue;  // only well inside skin, never on hair
      const k = i * 3;
      const y = 0.299 * f[k] + 0.587 * f[k + 1] + 0.114 * f[k + 2];
      const yb = 0.299 * bl[k] + 0.587 * bl[k + 1] + 0.114 * bl[k + 2];
      const d = yb - y;                    // how much darker than the skin around
      // small marks are a little darker; brows, lashes and lines are much darker: fade out
      const wgt = d < 0.012 ? 0 : d < 0.04 ? (d - 0.012) / 0.028 : d < 0.09 ? 1 - (d - 0.04) / 0.05 : 0;
      if (wgt <= 0) continue;
      const a = amount * wgt * (m - 0.75) / 0.25;
      for (let c = 0; c < 3; c++) f[k + c] += (bl[k + c] - f[k + c]) * a;
    }
  }

  /** Gentle sharpening on brightness only (no colour fringes). */
  function sharpenY(f, w, h, amount) {
    const bl = boxBlur(f, w, h, Math.max(1, Math.round(Math.min(w, h) / 1500)));
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const d = (0.299 * (f[k] - bl[k]) + 0.587 * (f[k + 1] - bl[k + 1]) + 0.114 * (f[k + 2] - bl[k + 2])) * amount * 1.5;
      f[k] += d; f[k + 1] += d; f[k + 2] += d;
    }
  }

  /** Apply the plan to RGBA pixels, in place. */
  function apply(data, w, h, p) {
    const n = w * h;
    const f = new Float32Array(n * 3);
    const skin = new Float32Array(n);
    const cloth = new Float32Array(n);
    const [kr, kg, kb] = p.gain.map((v) => v * p.expo);
    const tone = p.tone && toneOn(p.tone);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let r = data[j] / 255 * kr, g = data[j + 1] / 255 * kg, b = data[j + 2] / 255 * kb;
      // roll off burnt whites per pixel, keeping hue (scale by the brightest channel)
      const mx = Math.max(r, g, b);
      if (p.hl > 0 && mx > p.knee) {
        const t = rolloff(mx, p.knee) / mx;
        const s = 1 + (t - 1) * p.hl;
        r *= s; g *= s; b *= s;
      }
      if (tone) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        if (y > 0.0005) {
          const k = Math.max(0, toneY(y, p.tone)) / y;
          r *= k; g *= k; b *= k;
        } else { const y2 = Math.max(0, toneY(0, p.tone)); r += y2; g += y2; b += y2; }
      }
      r = clamp01(r); g = clamp01(g); b = clamp01(b);
      const sw = skinWeight(r, g, b);
      skin[i] = sw;
      // face lift: shadows and mids inside skin get brighter, highlights untouched
      if (p.lift > 0 && sw > 0) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const a = p.lift * sw * (1 - y) * (1 - y);
        r += (1 - r) * a; g += (1 - g) * a; b += (1 - b) * a;
      }
      // vibrance: push weak colours more than strong ones, never skin much
      if (p.saturation) {
        const m = (r + g + b) / 3;
        r = m + (r - m) * (1 + p.saturation); g = m + (g - m) * (1 + p.saturation); b = m + (b - m) * (1 + p.saturation);
      }
      if (p.vibrance !== 0) {
        const m = (r + g + b) / 3, sat = Math.max(r, g, b) - Math.min(r, g, b);
        const v = p.vibrance * (1 - sat) * (1 - 0.7 * sw);
        r = m + (r - m) * (1 + v); g = m + (g - m) * (1 + v); b = m + (b - m) * (1 + v);
      }
      f[i * 3] = r; f[i * 3 + 1] = g; f[i * 3 + 2] = b;
      // white cloth: bright, little colour, not skin
      const lum = (r + g + b) / 3, ch = Math.max(r, g, b) - Math.min(r, g, b);
      cloth[i] = sw > 0.2 ? 0 : Math.max(0, Math.min(1, (lum - 0.5) / 0.15)) * Math.max(0, Math.min(1, (0.2 - ch) / 0.08));
    }

    if (p.iron > 0) ironCloth(f, cloth, w, h, p.iron);

    if (p.smooth > 0) {
      const r = Math.max(1, Math.round(Math.min(w, h) / 300));
      // soften the mask so smoothing has no hard edges
      const m3 = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) m3[i * 3] = m3[i * 3 + 1] = m3[i * 3 + 2] = skin[i];
      const mb = boxBlur(m3, w, h, r * 2);
      const bl = boxBlur(f, w, h, r);
      for (let i = 0; i < n; i++) {
        const m = Math.min(skin[i], mb[i * 3]);
        if (m <= 0.01) continue;
        const k = i * 3;
        const y0 = 0.299 * f[k] + 0.587 * f[k + 1] + 0.114 * f[k + 2];
        const y1 = 0.299 * bl[k] + 0.587 * bl[k + 1] + 0.114 * bl[k + 2];
        // big differences are eyes, lips, beard edges: keep them sharp
        const guard = Math.max(0, 1 - Math.abs(y1 - y0) / 0.09);
        const a = p.smooth * 0.95 * m * guard;
        f[k] += (bl[k] - f[k]) * a; f[k + 1] += (bl[k + 1] - f[k + 1]) * a; f[k + 2] += (bl[k + 2] - f[k + 2]) * a;
      }
    }

    if (p.blemish > 0) removeBlemishes(f, skin, w, h, p.blemish);
    if (p.sharpen > 0) sharpenY(f, w, h, p.sharpen);

    for (let i = 0, j = 0; i < n; i++, j += 4) {
      data[j] = clamp01(f[i * 3]) * 255 + 0.5;
      data[j + 1] = clamp01(f[i * 3 + 1]) * 255 + 0.5;
      data[j + 2] = clamp01(f[i * 3 + 2]) * 255 + 0.5;
    }
    return data;
  }

  const CROPS = {
    original: { label: 'Original shape', ratio: null, size: null },
    post: { label: 'IG post 4:5', ratio: 4 / 5, size: [1080, 1350] },
    square: { label: 'Square 1:1', ratio: 1, size: [1080, 1080] },
    story: { label: 'Story / Status 9:16', ratio: 9 / 16, size: [1080, 1920] },
    wide: { label: 'YouTube / Facebook 16:9', ratio: 16 / 9, size: [1920, 1080] },
    flyer: { label: 'Flyer A4 portrait', ratio: 1 / Math.SQRT2, size: [2480, 3508] },
  };

  /** Crop rectangle for a ratio, centred on where the people (skin) are. */
  function cropRect(w, h, ratio, center) {
    if (!ratio) return { x: 0, y: 0, w, h };
    let cw = w, ch = Math.round(w / ratio);
    if (ch > h) { ch = h; cw = Math.round(h * ratio); }
    const cx = (center ? center.x : 0.5) * w, cy = (center ? Math.min(center.y, 0.6) : 0.45) * h;
    const x = Math.round(Math.min(w - cw, Math.max(0, cx - cw / 2)));
    const y = Math.round(Math.min(h - ch, Math.max(0, cy - ch / 2)));
    return { x, y, w: cw, h: ch };
  }

  return { LOOK, DEFAULTS, CROPS, analyse, plan, apply, cropRect, skinWeight, boxBlur };
});
