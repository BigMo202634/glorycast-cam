// Quick checks of the pixel engine on made-up images (no packages needed).
const E = require('../src/engine.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

function img(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = (y * w + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  return d;
}
const W = 200, H = 150;
// green-cast white gown on the left, dark skin face on the right
const scene = (x, y) => (x < 120 ? [190, 225, 192] : [92, 60, 45]);

const d = img(W, H, scene);
const st = E.analyse(d, W, H);
ok(st.garment && st.garment.g > st.garment.r + 0.05, 'finds the green cast on white cloth');
ok(st.skinY != null && st.skinY < 0.35, 'finds dark skin');
const p = E.plan(st, {});
ok(p.gain[1] < p.gain[0] && p.gain[1] < p.gain[2], 'plan pulls green down');
ok(p.lift > 0, 'plan lifts dark faces');
E.apply(d, W, H, p);
const at = (x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
const g = at(50, 50);
ok(Math.abs(g[1] - (g[0] + g[2]) / 2) < 12, `white cloth is near neutral after fix (${g})`);
const f = at(160, 50);
ok(f[0] + f[1] + f[2] > 92 + 60 + 45, `face is brighter after fix (${f})`);

// sliders at zero must leave the photo alone
const z = img(W, H, scene), z0 = z.slice();
const zero = { colour: 0, exposure: 0, highlights: 0, face: 0, skin: 0, blemish: 0, iron: 0, vibrance: 0 };
E.apply(z, W, H, E.plan(E.analyse(z, W, H), zero));
let maxd = 0; for (let i = 0; i < z.length; i++) maxd = Math.max(maxd, Math.abs(z[i] - z0[i]));
ok(maxd <= 1, `all sliders at 0 changes nothing (max diff ${maxd})`);

// ironing: soft crease on white cloth gets shallower, a sharp pleat stays
const cw = 1200, chh = 800;
const cloth = (x) => {
  let v = 215;
  v -= 14 * Math.exp(-((x - 400) ** 2) / (2 * 12 * 12)); // soft crease
  if (x >= 800 && x < 804) v -= 70;                       // sharp pleat line
  return [v, v, v];
};
const cl = img(cw, chh, (x) => cloth(x));
const before = (x) => cl[(100 * cw + x) * 4];
const crease0 = before(400), pleat0 = before(802);
E.apply(cl, cw, chh, E.plan(E.analyse(cl, cw, chh), Object.assign({}, zero, { iron: 100 })));
const after = (x) => cl[(100 * cw + x) * 4];
ok(after(400) > crease0 + 4, `crease lifted ${crease0} -> ${after(400)}`);
ok(after(802) < pleat0 + 12, `pleat kept ${pleat0} -> ${after(802)}`);

// manual tools
const grey = () => img(100, 100, (x) => [x < 50 ? 60 : 180, x < 50 ? 60 : 180, x < 50 ? 60 : 180]);
const run = (st) => { const d2 = grey(); E.apply(d2, 100, 100, E.plan(E.analyse(d2, 100, 100), Object.assign({}, zero, st))); return [d2[(50 * 100 + 10) * 4], d2[(50 * 100 + 90) * 4]]; };
const base = run({});
ok(run({ ev: 50 })[0] > base[0] + 30, 'exposure +1 stop brightens');
const c = run({ contrast: 80 }); ok(c[0] < base[0] && c[1] > base[1], `contrast spreads tones ${base} -> ${c}`);
ok(run({ shadows: 80 })[0] > base[0] + 5 && Math.abs(run({ shadows: 80 })[1] - base[1]) < 15, 'shadows lifts darks more than lights');
ok(run({ blacks: -80 })[0] < base[0], 'blacks deepens darks');
const wt = (() => { const d2 = grey(); E.apply(d2, 100, 100, E.plan(E.analyse(d2, 100, 100), Object.assign({}, zero, { temp: 60 }))); const i = (50 * 100 + 90) * 4; return d2[i] - d2[i + 2]; })();
ok(wt > 10, 'warm temp makes red > blue');

// blemish: dark spot on skin gets lifted
const sk = img(400, 400, (x, y) => ((x - 200) ** 2 + (y - 200) ** 2 < 9 ? [152, 97, 75] : [170, 110, 85]));
const spot0 = sk[(200 * 400 + 200) * 4];
E.apply(sk, 400, 400, E.plan(E.analyse(sk, 400, 400), Object.assign({}, zero, { blemish: 100 })));
ok(sk[(200 * 400 + 200) * 4] > spot0 + 6, `blemish lifted ${spot0} -> ${sk[(200 * 400 + 200) * 4]}`);

// crops stay inside the photo
for (const [k, cr] of Object.entries(E.CROPS)) {
  const r = E.cropRect(6000, 4000, cr.ratio, { x: 0.95, y: 0.1 });
  ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 6000 && r.y + r.h <= 4000, `crop ${k} inside photo`);
}
if (fails) { console.log(fails + ' failed'); process.exit(1); }
console.log('all passed');
