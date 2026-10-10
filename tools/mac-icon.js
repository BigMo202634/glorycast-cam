// Makes mac/AppIcon.icns (the Mac app icon) from app/img/icon.svg: the GloryCast mark (white and gold)
// on a rounded navy square with the margin and shadow Mac icons have, like the phone home-screen icon. Needs playwright.
// Run: node tools/mac-icon.js
"use strict";
const fs = require("fs"), path = require("path"), { chromium } = require("playwright");
const svg = fs.readFileSync(path.join(__dirname, "../app/img/icon.svg"), "utf8");
(async () => {
  const b = await chromium.launch(), page = await b.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<style>html,body{margin:0;background:transparent}
    .i{position:absolute;left:100px;top:92px;width:824px;height:824px;border-radius:185px;overflow:hidden;background:#0F1E3D;box-shadow:0 10px 18px rgba(0,0,0,.3)}
    .i svg{width:100%;height:100%;display:block}</style><div class="i">${svg.replace(/<metadata>[\s\S]*?<\/metadata>/, "")}</div>`);
  const big = await page.screenshot({ omitBackground: true });
  // smaller sizes: halve step by step for a clean result
  const sizes = await page.evaluate(async (src) => {
    const img = new Image(); img.src = "data:image/png;base64," + src; await img.decode();
    const out = {};
    for (const n of [16, 32, 64, 128, 256, 512]) {
      let cur = img, w = 1024;
      while (w / 2 >= n) { const c = document.createElement("canvas"); c.width = c.height = w / 2; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cur, 0, 0, w / 2, w / 2); cur = c; w /= 2; }
      out[n] = cur.toDataURL("image/png").split(",")[1];
    }
    return out;
  }, big.toString("base64"));
  await b.close();
  const png = n => n === 1024 ? big : Buffer.from(sizes[n], "base64");
  // icns: "icns" + length, then (type, length, PNG) for each size; @2x types reuse the bigger pictures
  const parts = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
                 ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]].map(([t, n]) => {
    const d = png(n), h = Buffer.alloc(8); h.write(t, 0, "ascii"); h.writeUInt32BE(d.length + 8, 4); return Buffer.concat([h, d]);
  });
  const body = Buffer.concat(parts), head = Buffer.alloc(8); head.write("icns", 0, "ascii"); head.writeUInt32BE(body.length + 8, 4);
  fs.writeFileSync(path.join(__dirname, "../mac/AppIcon.icns"), Buffer.concat([head, body]));
  fs.writeFileSync(path.join(process.env.ICON_PREVIEW || require("os").tmpdir(), "glorycast-cam-mac-icon.png"), big);
  console.log("mac/AppIcon.icns written");
})().catch(e => { console.error(e); process.exit(1); });
