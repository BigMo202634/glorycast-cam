// Phone -> server -> OBS page, with Chromium's fake camera. Needs playwright.
// Run: node tests/e2e-cam.js
"use strict";
const path = require("path"), os = require("os"), fs = require("fs");
const { chromium } = require("playwright");
const PORT = 7895, results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : "")); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await wait(200); } return null; }

(async () => {
  process.env.GLORYCAST_CAM_PORT = PORT;
  process.env.GLORYCAST_CAM_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "gccam-"));
  const { start } = require("../server/server.js");
  const srv = start(); await wait(500);
  const ip = require("../server/server.js").lanIPs()[0];
  const b = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--proxy-server=direct://"] });
  const errs = [];
  // phone: https with our own certificate (the user accepts it once on a real phone)
  const phoneCtx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 844, height: 390 }, permissions: ["camera"] });
  await phoneCtx.addInitScript(() => {
    navigator.getBattery = () => Promise.resolve({ level: 0.15, charging: false }); // a phone running low
    window.__params = [];
    const sp = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function (p) { try { window.__params.push(JSON.parse(JSON.stringify(p))); } catch (e) { /* ignore */ } return sp.apply(this, arguments); };
    window.__answers = [];
    const srd = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (d) { if (d && d.type === "answer") window.__answers.push(d.sdp); return srd.apply(this, arguments); };
  });
  const phone = await phoneCtx.newPage(); phone.on("pageerror", e => errs.push("phone: " + e.message));
  const host = ip ? ip.ip : "127.0.0.1";
  // plain http address on the phone is sent to https
  const resp = await phone.goto(`http://${host}:${PORT}/phone`);
  check("phone on http is sent to the https page", phone.url().startsWith(`https://${host}:${PORT + 1}/phone`), phone.url());
  check("camera page is a secure page", await phone.evaluate(() => window.isSecureContext));
  // the Android app asks the Wi-Fi where GloryCast Cam is; this computer answers with its port
  const found = await new Promise(res => {
    const u = require("dgram").createSocket("udp4"), t = setTimeout(() => { u.close(); res(null); }, 2000);
    u.on("message", m => { clearTimeout(t); u.close(); try { res(JSON.parse(String(m))); } catch (e) { res(null); } });
    u.send("GLORYCAST-CAM?", PORT + 2, "127.0.0.1");
  });
  check("the Android app can find this computer on the Wi-Fi", found && found.app === "glorycast-cam" && found.http === PORT, JSON.stringify(found));
  await phone.fill("#camName", "Altar"); await phone.click("#startBtn");
  check("camera starts", await until(() => phone.evaluate(() => { const v = document.getElementById("video"); return v.videoWidth > 0; })));
  check("phone waits for OBS", await until(() => phone.isVisible("#waiting")));

  // control page on this computer
  const ctl = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage(); ctl.on("pageerror", e => errs.push("control: " + e.message));
  await ctl.goto(`http://localhost:${PORT}/`);
  check("control page shows the phone address and QR", await until(async () => /https:\/\/.+:\d+\/phone/.test(await ctl.textContent("#phoneUrl")) && await ctl.$("#qr svg")));
  check("control page lists the Altar camera", await until(async () => /Altar/.test(await ctl.textContent("#cams"))));
  // GloryCast Switch, opened from the church Wi-Fi, reads the batteries to warn its operator
  const ask = (method, origin) => new Promise((ok, no) => {
    const r = require("http").request({ host: "127.0.0.1", port: PORT, path: "/cams", method, headers: { Origin: origin } }, x => {
      let s = ""; x.on("data", d => { s += d; }); x.on("end", () => ok({ status: x.statusCode, headers: x.headers, body: s }));
    });
    r.on("error", no); r.end();
  });
  const lan = "http://192.168.1.20:7790";
  const cams = await until(async () => { const r = await ask("GET", lan), c = JSON.parse(r.body).cameras.find(x => x.cam === "altar"); return c && c.battery != null && { r, c }; });
  check("Switch can read each phone's battery from the media computer", cams && cams.c.name === "Altar" && cams.c.online && cams.c.battery === 15 && cams.c.charging === false &&
    cams.r.headers["access-control-allow-origin"] === lan, cams && JSON.stringify(cams.c));
  const pre = await ask("OPTIONS", lan);
  check("and the browser's permission check passes", pre.status === 204 && pre.headers["access-control-allow-private-network"] === "true" && pre.headers["access-control-allow-origin"] === lan);
  check("a website out on the internet cannot read them", !(await ask("GET", "https://example.com")).headers["access-control-allow-origin"]);
  check("media computer page shows the low battery", await until(async () => /Battery 15%/.test(await ctl.textContent("#cams"))));
  check("small picture plays on the control page", await until(() => ctl.frames().find(f => /kind=preview/.test(f.url())).evaluate(() => document.getElementById("video").videoWidth > 0), 12000));

  // OBS browser source
  const obs = await (await b.newContext({ viewport: { width: 960, height: 540 } })).newPage(); obs.on("pageerror", e => errs.push("obs: " + e.message));
  await obs.goto(`http://localhost:${PORT}/view?cam=altar&hold=2`);
  const w = await until(() => obs.evaluate(() => { const v = document.getElementById("video"); return v.videoWidth && !v.paused ? v.videoWidth + "x" + v.videoHeight : 0; }), 12000);
  check("picture reaches the OBS page", w, w);
  check("waiting text is hidden once the picture plays", await until(() => obs.evaluate(() => document.getElementById("wait").hidden)));
  check("phone stops waiting once OBS has it", await until(async () => !(await phone.isVisible("#waiting"))));
  const fullSize = await obs.evaluate(() => document.getElementById("video").videoWidth);
  const prevSize = await ctl.frames().find(f => /kind=preview/.test(f.url())).evaluate(() => document.getElementById("video").videoWidth);
  check("OBS gets the full picture, the control page a small one", fullSize >= prevSize, fullSize + " vs " + prevSize);
  check("OBS asks the phone to start sharp (no slow climb from a blurry picture)", await phone.evaluate(() => window.__answers.some(s => /x-google-start-bitrate=4000/.test(s))));
  check("phone sends a still for OBS to show while a picture connects", await until(async () => {
    const r = await fetch(`http://localhost:${PORT}/still?cam=altar`); return r.ok && r.headers.get("content-type") === "image/jpeg" && (await r.arrayBuffer()).byteLength > 1000;
  }));

  // smooth motion: every picture keeps its frame rate; the small picture moves like the real one
  const enc = pr => (pr.encodings || [{}])[0];
  check("small picture on the media computer page is sent at 30 fps, about 640×360, keeping its frame rate", await until(() => phone.evaluate(() =>
    window.__params.some(p => p.encodings[0].maxFramerate === 30 && Math.abs(p.encodings[0].scaleResolutionDownBy - 3) < 0.01 && p.encodings[0].maxBitrate === 1000000 && p.degradationPreference === "maintain-framerate"))),
    JSON.stringify((await phone.evaluate(() => window.__params)).map(p => [enc(p).maxFramerate, enc(p).scaleResolutionDownBy, enc(p).maxBitrate, p.degradationPreference])));
  check("OBS picture keeps its frame rate when the Wi-Fi is weak (sharpness gives way first)", await phone.evaluate(() =>
    window.__params.some(p => p.encodings[0].maxBitrate === 8000000 && p.encodings[0].scaleResolutionDownBy === 1 && p.degradationPreference === "maintain-framerate")));
  const fpsOf = fr => fr.evaluate(async () => {
    const pc = window.GCView.pc(), get = async () => { let n = 0; (await pc.getStats()).forEach(x => { if (x.type === "inbound-rtp" && x.kind === "video") n = x.framesDecoded; }); return n; };
    const a = await get(); await new Promise(r => setTimeout(r, 3000)); return Math.round((await get() - a) / 3);
  });
  await wait(2000);
  const [obsFps, prevFps] = await Promise.all([fpsOf(obs.mainFrame()), fpsOf(ctl.frames().find(f => /kind=preview/.test(f.url())))]);
  check("small picture on the media computer page moves at full speed, like OBS", prevFps >= 14 && prevFps >= obsFps * 0.8, prevFps + " fps vs " + obsFps + " fps in OBS");
  check("media computer page shows the frames in OBS and the codec", await until(async () => /\d+fps in OBS · (H\.264|VP8|VP9|AV1)/.test(await ctl.textContent("#cams"))), await ctl.textContent(".cam .facts"));

  // weak Wi-Fi: the phone gets fewer frames out than the camera makes, so it sends a smaller picture to keep the motion smooth
  await phone.evaluate(() => {
    window.__fake = { cam: 30, sent: 15 }; window.__realStats = RTCRtpSender.prototype.getStats;
    const per = new WeakMap();
    RTCRtpSender.prototype.getStats = function () {
      const f = window.__fake, now = performance.now();
      let s = per.get(this); if (!s) per.set(this, s = { t: now, made: 0, sent: 0 });
      const dt = (now - s.t) / 1000; s.t = now; s.made += f.cam * dt; s.sent += f.sent * dt;
      return Promise.resolve(new Map([
        ["s", { type: "media-source", kind: "video", frames: Math.round(s.made) }],
        ["o", { type: "outbound-rtp", kind: "video", framesSent: Math.round(s.sent), frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: "bandwidth", codecId: "c" }],
        ["c", { type: "codec", id: "c", mimeType: "video/H264" }]]));
    };
  });
  const lastObsScale = () => phone.evaluate(() => { const l = window.__params.filter(p => p.encodings[0].maxBitrate === 8000000); return l.length ? l[l.length - 1].encodings[0].scaleResolutionDownBy : null; });
  check("weak Wi-Fi: the phone sends a smaller picture to the OBS so the motion stays smooth", await until(async () => (await lastObsScale()) === 1.5, 15000), String(await lastObsScale()));
  check("and the media computer page says so", await until(async () => /smaller picture to keep the motion smooth/.test(await ctl.textContent("#cams")), 10000));
  await phone.evaluate(() => { window.__fake.sent = 30; });
  check("back to the full picture once the Wi-Fi keeps up again", await until(async () => (await lastObsScale()) === 1, 40000), String(await lastObsScale()));
  // too dark: the camera itself slows down (phone browsers on Android do this to gather light)
  // (the test camera makes 20 frames a second; a dim church takes it down to 10)
  await phone.evaluate(() => { window.__fake.cam = 10; window.__fake.sent = 10; });
  check("too dark: the phone tells the camera person it slowed to 10 frames a second", await until(async () => await phone.isVisible("#dim") && /slowed to 10 frames/.test(await phone.textContent("#dim")), 15000));
  check("and the media computer page shows it", await until(async () => /Too dark for smooth motion/.test(await ctl.textContent("#cams")) && /Camera 10fps/.test(await ctl.textContent("#cams")), 10000));
  check("a camera that slowed down by itself is not made smaller", (await lastObsScale()) === 1);
  await phone.evaluate(() => { RTCRtpSender.prototype.getStats = window.__realStats; });
  check("the warning clears when the light is back", await until(async () => !/Too dark/.test(await ctl.textContent("#cams")), 15000));

  // live light: red frame while OBS has the camera on Program, green while it is in OBS but not live
  const fire = (ev, detail) => obs.evaluate(([ev, detail]) => window.dispatchEvent(new CustomEvent(ev, { detail })), [ev, detail]);
  const frame = () => phone.evaluate(() => { const s = getComputedStyle(document.querySelector(".tally")); return s.borderTopColor + " " + s.borderTopWidth + " z" + s.zIndex; });
  check("picture in a program that cannot say when it is live (vMix): phone says CONNECTED, no colour", await until(async () => (await phone.textContent("#state")) === "CONNECTED" && /rgba\(0, 0, 0, 0\)/.test(await frame())));
  check("and the media computer page explains there is no live light", await until(async () => /No live light on the phone/.test(await ctl.textContent("#cams"))));
  await fire("obsSourceActiveChanged", { active: true });
  check("phone turns red when OBS puts it on Program", await until(async () => (await phone.textContent("#state")) === "● LIVE" && await phone.evaluate(() => document.body.classList.contains("live"))));
  check("red frame round the screen, thick, above the buttons", await until(async () => (await frame()) === "rgb(229, 56, 59) 10px z4"), await frame());
  check("control page tile shows LIVE", await until(async () => (await ctl.getAttribute(".cam", "class")).includes("live")));
  await fire("obsSourceActiveChanged", { active: false });
  check("phone turns green with NOT LIVE when OBS takes it off Program", await until(async () => (await phone.textContent("#state")) === "NOT LIVE" && (await frame()).startsWith("rgb(47, 191, 113)")), await frame());
  check("control page tile shows NOT LIVE in green", await until(async () => (await ctl.getAttribute(".cam", "class")).includes("standby") && /NOT LIVE/.test(await ctl.textContent(".cam .tag"))));
  // GloryCast Switch takes pictures of every scene, which makes OBS show and hide each source many times a second
  await phone.evaluate(() => { window.__cls = []; new MutationObserver(() => window.__cls.push(document.body.className)).observe(document.body, { attributes: true }); });
  for (let i = 0; i < 20; i++) { await fire("obsSourceVisibleChanged", { visible: true }); await fire("obsSourceVisibleChanged", { visible: false }); }
  await wait(600);
  check("Switch taking pictures does not make the phone flicker (stays green)", await phone.evaluate(() => window.__cls.every(c => /\bstandby\b/.test(c)) && document.body.classList.contains("standby")), await phone.evaluate(() => window.__cls.slice(0, 3).join(" | ")));
  await fire("obsSourceActiveChanged", { active: true });
  await until(async () => phone.evaluate(() => document.body.classList.contains("live")));
  await phone.evaluate(() => { window.__cls = []; });
  for (let i = 0; i < 20; i++) { await fire("obsSourceVisibleChanged", { visible: true }); await fire("obsSourceVisibleChanged", { visible: false }); }
  await wait(600);
  check("nor while it is live (stays red)", await phone.evaluate(() => window.__cls.every(c => /\blive\b/.test(c)) && document.body.classList.contains("live")));
  await fire("obsSourceActiveChanged", { active: false });
  check("back to green", await until(async () => (await phone.textContent("#state")) === "NOT LIVE"));

  // OBS refreshes its browser source: picture comes back
  await obs.reload();
  check("picture comes back after OBS reloads", await until(() => obs.evaluate(() => document.getElementById("video").videoWidth > 0), 12000));

  // OBS with "Shutdown source when not visible" ticked closes the page on every switch and opens a new one.
  // The new page shows the phone's still at once (never black or the waiting text), then goes live.
  const obsCtx = await b.newContext({ viewport: { width: 960, height: 540 } });
  await obsCtx.addInitScript(() => {
    window.obsstudio = { pluginVersion: "2.24.0" };
    window.__log = []; const t0 = performance.now();
    setInterval(() => { const s = window.GCView && window.GCView.state(); if (s) window.__log.push([Math.round(performance.now() - t0), s.still, s.live, s.wait, s.frame]); }, 25);
  });
  let reopen = null;
  for (let i = 0; i < 4; i++) {
    const pg = await obsCtx.newPage(); pg.on("pageerror", e => errs.push("obs reopen: " + e.message));
    await pg.goto(`http://localhost:${PORT}/view?cam=altar`);
    await until(() => pg.evaluate(() => window.GCView.state().live), 12000); await wait(300);
    if (i === 3) reopen = await pg.evaluate(() => window.__log);
    await pg.close();
  }
  const firstPic = (reopen.find(r => r[1] || r[2]) || [])[0], firstLive = (reopen.find(r => r[2]) || [])[0];
  check("reopened OBS page shows the camera at once", firstPic != null && firstPic < 700, "picture after " + firstPic + " ms, live after " + firstLive + " ms");
  check("and never shows black with the waiting text", reopen.length > 10 && reopen.every(r => !r[3]));
  check("media computer page warns that OBS keeps restarting the camera", await until(async () => /OBS keeps restarting this camera/.test(await ctl.textContent("#cams"))));
  // after unticking in OBS: the page stays open when it goes live and when it is hidden
  await fire("obsSourceActiveChanged", { active: true }); await fire("obsSourceActiveChanged", { active: false }); await fire("obsSourceVisibleChanged", { visible: false });
  check("warning clears once OBS keeps the page open", await until(async () => !/OBS keeps restarting/.test(await ctl.textContent("#cams")), 9000));
  const twin = await obsCtx.newPage(); await twin.goto(`http://localhost:${PORT}/view?cam=altar`);
  check("a second OBS source for the same phone gets a tip", await until(async () => /in 2 OBS Browser sources/.test(await ctl.textContent("#cams"))));
  await twin.close();

  // OBS only says when a source goes on or off Program, so a page that opens while already on Program
  // (OBS just started, or the page reloaded) hears nothing: drawn the whole time since it opened = live
  const onAirPg = await obsCtx.newPage(); onAirPg.on("pageerror", e => errs.push("obs on air: " + e.message));
  await onAirPg.goto(`http://localhost:${PORT}/view?cam=altar`);
  check("OBS page that opens already on Program turns the phone red without being told", await until(async () => (await phone.textContent("#state")) === "● LIVE" && await phone.evaluate(() => document.body.classList.contains("live")), 6000));
  await onAirPg.evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceActiveChanged", { detail: { active: false } })));
  check("and green as soon as OBS takes it off Program", await until(async () => (await phone.textContent("#state")) === "NOT LIVE"));
  await onAirPg.close();
  // a page OBS opens while its scene is not on screen anywhere starts hidden
  const hidCtx = await b.newContext({ viewport: { width: 960, height: 540 } });
  await hidCtx.addInitScript(() => {
    window.obsstudio = { pluginVersion: "2.24.0" };
    Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => true });
  });
  const offPg = await hidCtx.newPage(); offPg.on("pageerror", e => errs.push("obs hidden: " + e.message));
  await offPg.goto(`http://localhost:${PORT}/view?cam=altar`);
  await until(() => offPg.evaluate(() => window.GCView.state().live), 12000); await wait(2000);
  check("OBS page that opens off screen keeps the phone green", (await phone.textContent("#state")) === "NOT LIVE" && await offPg.evaluate(() => !window.GCView.tally.live));
  await offPg.evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceActiveChanged", { detail: { active: true } })));
  check("and red when OBS puts it on Program", await until(async () => (await phone.textContent("#state")) === "● LIVE"));
  await offPg.evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceActiveChanged", { detail: { active: false } })));
  await offPg.close();

  // a camera with no phone: the waiting text helps setting up, but never shows while the source is on Program
  const lonely = await hidCtx.newPage(); await lonely.goto(`http://localhost:${PORT}/view?cam=balcony`);
  check("source with no phone says it is waiting", await until(() => lonely.evaluate(() => !document.getElementById("wait").hidden)));
  await lonely.evaluate(() => window.dispatchEvent(new CustomEvent("obsSourceActiveChanged", { detail: { active: true } })));
  check("but not while it is on Program", await until(() => lonely.evaluate(() => document.getElementById("wait").hidden)));
  await lonely.close();

  // the phone's link to this computer drops for a moment: the picture goes straight to OBS, so it carries on
  await obs.evaluate(() => { window.__pc0 = window.GCView.pc(); window.__waitSeen = false; setInterval(() => { if (!document.getElementById("wait").hidden) window.__waitSeen = true; }, 50); });
  Array.from(require("../server/server.js").clients.values()).find(c => c.role === "phone" && c.cam === "altar").close();
  check("phone shows it lost the media computer", await until(() => phone.isVisible("#lost"), 5000));
  check("phone reconnects by itself", await until(async () => !(await phone.isVisible("#lost")), 10000));
  await wait(5000); // past the phone's clean-up of pictures OBS no longer has
  check("OBS picture carried on through the drop (same connection)", await obs.evaluate(() => window.GCView.pc() === window.__pc0 && window.GCView.state().live));
  check("and OBS never showed the waiting text", !(await obs.evaluate(() => window.__waitSeen)));

  // the phone page is reloaded by mistake and started again: OBS holds the last frame, then swaps to the new picture
  const held = await obsCtx.newPage(); held.on("pageerror", e => errs.push("obs held: " + e.message));
  await held.goto(`http://localhost:${PORT}/view?cam=altar`);
  await until(() => held.evaluate(() => window.GCView.state().live), 12000);
  await held.evaluate(() => { window.__pcA = window.GCView.pc(); window.__log = []; });
  await phone.reload(); await phone.fill("#camName", "Altar"); await phone.click("#startBtn");
  check("after the phone restarts, OBS is live again on the new connection", await until(() => held.evaluate(() => window.GCView.pc() !== window.__pcA && window.GCView.state().live), 15000));
  const heldLog = await held.evaluate(() => window.__log);
  check("and OBS kept a picture on screen the whole time (no black, no waiting text)", heldLog.length > 10 && heldLog.every(r => (r[1] || r[2] || r[4]) && !r[3]),
    heldLog.filter(r => !(r[1] || r[2] || r[4]) || r[3]).slice(0, 3).map(r => r.join(",")).join(" | "));
  await held.close();
  await until(() => obs.evaluate(() => window.GCView.state().live), 12000);

  // phone flips camera: picture keeps going (track replaced, no new connection)
  await phone.click("#flipBtn"); await wait(1500);
  check("picture still plays after Flip", await obs.evaluate(() => { const v = document.getElementById("video"); return v.videoWidth > 0 && !v.paused; }));

  // phone stops: OBS shows waiting, control shows offline; then starts again
  await phone.click("#stopBtn");
  check("OBS shows waiting when the phone stops", await until(() => obs.evaluate(() => !document.getElementById("wait").hidden)));
  check("control page shows phone not connected", await until(async () => /not connected/i.test(await ctl.textContent("#cams"))));
  await phone.click("#startBtn");
  check("picture returns when the phone starts again", await until(() => obs.evaluate(() => document.getElementById("video").videoWidth > 0 && document.getElementById("wait").hidden), 12000));

  // a second phone with the same name replaces the first (the first is told)
  const phone2 = await phoneCtx.newPage(); phone2.on("pageerror", e => errs.push("phone2: " + e.message));
  await phone2.goto(`https://${host}:${PORT + 1}/phone`);
  await phone2.fill("#camName", "Choir"); await phone2.click("#startBtn");
  check("second camera appears separately", await until(async () => (await ctl.$$(".cam")).length === 2));
  const noRtc = await b.newContext({ viewport: { width: 960, height: 540 } });
  await noRtc.addInitScript(() => { window.obsstudio = { pluginVersion: "2.24.0" }; RTCPeerConnection.prototype.setRemoteDescription = () => new Promise(() => {}); });
  const stuck = await noRtc.newPage(); stuck.on("pageerror", e => errs.push("obs no video: " + e.message));
  await stuck.goto(`http://localhost:${PORT}/view?cam=choir`);
  check("live video can't get through: OBS still shows the phone's pictures", await until(() => stuck.evaluate(() => window.GCView.state().still && !window.GCView.state().live), 8000));
  check("and the media computer page explains it is only getting still pictures", await until(async () => /getting still pictures from this phone/.test(await ctl.textContent("#cams")), 15000));
  await noRtc.close();
  check("the explanation goes when that OBS page closes", await until(async () => !/getting still pictures/.test(await ctl.textContent("#cams")), 8000));


  // picture settings: a phone without controls shows why; a phone with them sends the right values
  await phone2.click("#setBtn");
  check("settings panel opens", await phone2.isVisible("#sheet"));
  const naShown = await phone2.evaluate(() => !document.getElementById("wbNa").hidden || !document.getElementById("wbBox").hidden);
  check("white balance shows controls or says the browser does not allow it", naShown);
  await phone2.selectOption("#fpsLive", "24");
  check("frame rate change is applied to the camera", await until(() => phone2.evaluate(() => /fps/.test(document.getElementById("gotRes").textContent))));
  const p3ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 844, height: 390 }, permissions: ["camera"] });
  await p3ctx.addInitScript(() => {
    window.__applied = []; window.__gum = [];
    const caps = { zoom: { min: 1, max: 8, step: 0.1 }, whiteBalanceMode: ["continuous", "manual"], colorTemperature: { min: 2850, max: 7000, step: 50 },
      exposureMode: ["continuous", "manual"], exposureCompensation: { min: -2, max: 2, step: 0.33 }, exposureTime: { min: 1, max: 1250, step: 1 },
      iso: { min: 50, max: 3200, step: 1 }, focusMode: ["continuous", "manual"], torch: true };
    MediaStreamTrack.prototype.getCapabilities = function () { return caps; };
    const orig = MediaStreamTrack.prototype.applyConstraints;
    MediaStreamTrack.prototype.applyConstraints = function (c) { window.__applied.push(JSON.parse(JSON.stringify(c))); return new Promise(r => setTimeout(r, 150)); };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => { window.__gum.push(JSON.parse(JSON.stringify(c))); return gum(c); };
  });
  const p3 = await p3ctx.newPage(); p3.on("pageerror", e => errs.push("phone3: " + e.message));
  await p3.goto(`https://${host}:${PORT + 1}/phone`);
  await p3.fill("#camName", "Wide"); await p3.selectOption("#quality", "2160"); await p3.selectOption("#fps", "60"); await p3.click("#startBtn");
  await until(() => p3.isVisible("#cam"));
  const g = await p3.evaluate(() => window.__gum[0].video);
  check("4K at 60 fps is asked from the camera", g.height.ideal === 2160 && g.width.ideal === 3840 && g.frameRate.ideal === 60, JSON.stringify(g));
  check("phone says what it really got", await until(() => p3.evaluate(() => /does not offer 4K/.test(document.getElementById("gotRes").textContent))));
  await p3.click("#setBtn");
  await p3.click('#wbChips [data-k="5500"]');
  await p3.evaluate(() => { const r = document.getElementById("shutter"); r.value = r.max; r.dispatchEvent(new Event("input")); r.value = 1; r.dispatchEvent(new Event("input")); });
  await p3.click("#focusBtn"); await wait(1200);
  const applied = await p3.evaluate(() => window.__applied.map(c => c.advanced[0]));
  const find = f => applied.some(f);
  check("Daylight sets white balance to 5500K", find(c => c.whiteBalanceMode === "manual" && c.colorTemperature === 5500));
  check("shutter 1/50 is sent as exposure time 200", find(c => c.exposureMode === "manual" && c.exposureTime === 200), JSON.stringify(applied.filter(c => c.exposureTime)));
  check("focus lock is sent", find(c => c.focusMode === "manual"));
  const obs3 = await (await b.newContext()).newPage(); await obs3.goto(`http://localhost:${PORT}/view?cam=wide`);
  check("4K/60 phone reaches OBS", await until(() => obs3.evaluate(() => document.getElementById("video").videoWidth > 0), 12000));

  // touch: pinch to zoom, drag the right side for brightness (camera exposure on this phone)
  const touches = (pts) => pts.map((p, i) => ({ identifier: i, clientX: p[0], clientY: p[1] }));
  async function gesture(page, steps) {
    await page.evaluate((steps) => {
      const el = document.getElementById("touch");
      const mk = (type, pts) => { const list = pts.map((p, i) => new Touch({ identifier: i, target: el, clientX: p[0], clientY: p[1] }));
        el.dispatchEvent(new TouchEvent(type, { touches: type === "touchend" ? [] : list, changedTouches: list, bubbles: true })); };
      steps.forEach(s => mk(s[0], s[1]));
    }, steps);
  }
  await p3.click("#sheetClose");
  await p3.evaluate(() => { window.__applied = []; });
  const pinch = [["touchstart", [[300, 200], [400, 200]]]];
  for (let i = 1; i <= 20; i++) pinch.push(["touchmove", [[300 - i * 5, 200], [400 + i * 5, 200]]]);
  pinch.push(["touchend", [[200, 200], [500, 200]]]);
  await gesture(p3, pinch); await wait(800);
  const zs = await p3.evaluate(() => window.__applied.map(c => c.advanced[0].zoom).filter(z => z != null));
  check("pinch zooms in (fingers 3x apart = 3x)", zs.length && Math.abs(zs[zs.length - 1] - 3) < 0.15, zs.map(z => z.toFixed(2)).join(" "));
  check("zoom changes don't pile up (one at a time, newest wins)", zs.length <= 6, zs.length + " changes for 20 moves");
  check("zoom shows as a lens size (3x the 24mm lens = 72mm)", (await p3.textContent("#zoomChip")) === "72mm", await p3.textContent("#zoomChip"));
  await p3.evaluate(() => { window.__applied = []; });
  await gesture(p3, [["touchstart", [[780, 250]]], ["touchmove", [[780, 200]]], ["touchmove", [[780, 150]]], ["touchend", [[780, 150]]]]); await wait(500);
  const evs = await p3.evaluate(() => window.__applied.map(c => c.advanced[0].exposureCompensation).filter(v => v != null));
  check("dragging up on the right brightens (camera exposure)", evs.length && evs[evs.length - 1] > 0.3, evs.join(" "));
  check("line shows the value", /^\+/.test(await p3.textContent("#evShow")), await p3.textContent("#evShow"));

  // lens buttons in mm, like a cinema camera: only the ones this phone's zoom can reach
  const lensList = await p3.$$eval("#lenses button", bs => bs.map(b => b.dataset.mm).join(" "));
  check("lens buttons 24 to 150mm on a phone that zooms up to 8x (200mm needs 8.3x)", lensList === "24 35 50 85 105 150", lensList);
  await p3.evaluate(() => { window.__applied = []; });
  await p3.click('#lenses [data-mm="85"]'); await wait(400);
  const z85 = await p3.evaluate(() => window.__applied.map(c => c.advanced[0].zoom).filter(v => v != null).pop());
  check("85mm sets the zoom to 85/24 = 3.54", Math.abs(z85 - 85 / 24) < 0.01, String(z85));
  check("85mm button lights up", await p3.evaluate(() => document.querySelector('#lenses [data-mm="85"]').classList.contains("on")));
  check("media computer page shows the lens", await until(async () => /85mm/.test(await ctl.textContent("#cams"))));

  // an iPhone with several back lenses: use its combined camera, which moves to the zoom lens by itself
  const p5ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 844, height: 390 }, permissions: ["camera"] });
  await p5ctx.addInitScript(() => {
    window.__applied = []; window.__gum = [];
    MediaStreamTrack.prototype.getCapabilities = function () { return { zoom: { min: 1, max: 20, step: 0.1 } }; };
    MediaStreamTrack.prototype.applyConstraints = function (c) { window.__applied.push(JSON.parse(JSON.stringify(c))); return Promise.resolve(); };
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = c => {
      window.__gum.push(JSON.parse(JSON.stringify(c)));
      const v = Object.assign({}, c.video); delete v.deviceId; // the test browser has one fake camera
      return gum({ audio: false, video: v });
    };
    navigator.mediaDevices.enumerateDevices = () => Promise.resolve([
      { kind: "videoinput", label: "Back Camera", deviceId: "wide" }, { kind: "videoinput", label: "Back Ultra Wide Camera", deviceId: "ultra" },
      { kind: "videoinput", label: "Back Dual Wide Camera", deviceId: "dualwide" }, { kind: "videoinput", label: "Back Triple Camera", deviceId: "triple" },
      { kind: "videoinput", label: "Front Camera", deviceId: "front" }]);
  });
  const p5 = await p5ctx.newPage(); p5.on("pageerror", e => errs.push("phone5: " + e.message));
  await p5.goto(`https://${host}:${PORT + 1}/phone`); await p5.fill("#camName", "Gallery"); await p5.click("#startBtn");
  const lastZoom = pg => pg.evaluate(() => window.__applied.map(c => c.advanced[0].zoom).filter(v => v != null).pop());
  check("iPhone Pro: uses the combined back camera (it moves to the zoom lens itself)", await until(() => p5.evaluate(() => window.__gum.some(c => c.video.deviceId && c.video.deviceId.exact === "triple"))));
  check("and 24mm is its main lens (zoom 2, as its zoom starts at the ultra wide lens)", await until(async () => Math.abs(await lastZoom(p5) - 2) < 0.01));
  await p5.click('#lenses [data-mm="200"]');
  check("200mm on that camera is zoom 16.7", await until(async () => Math.abs(await lastZoom(p5) - 200 / 12) < 0.05));
  await p5ctx.close();

  // a phone whose browser has no exposure control: the line brightens the picture in OBS instead
  const phone4ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 844, height: 390 }, permissions: ["camera"], hasTouch: true });
  const p4 = await phone4ctx.newPage(); p4.on("pageerror", e => errs.push("phone4: " + e.message));
  await p4.goto(`https://${host}:${PORT + 1}/phone`); await p4.fill("#camName", "Pulpit"); await p4.click("#startBtn");
  const obs4 = await (await b.newContext()).newPage(); await obs4.goto(`http://localhost:${PORT}/view?cam=pulpit`);
  await until(() => obs4.evaluate(() => document.getElementById("video").videoWidth > 0), 12000);
  await gesture(p4, [["touchstart", [[780, 250]]], ["touchmove", [[780, 150]]], ["touchend", [[780, 150]]]]);
  check("no camera exposure: OBS picture is brightened", await until(() => obs4.evaluate(() => /brightness\(1\.[1-9]/.test(document.getElementById("pic").style.filter))), await obs4.evaluate(() => document.getElementById("pic").style.filter));
  check("and the phone preview shows the same", /brightness/.test(await p4.evaluate(() => document.getElementById("video").style.filter)));

  // no automatic turning: moving the phone changes nothing; Picture turn is the only way
  await p4.setViewportSize({ width: 390, height: 844 }); await wait(400);
  await p4.evaluate(() => { const v = document.getElementById("video"); Object.defineProperty(v, "videoWidth", { get: () => 1080 }); Object.defineProperty(v, "videoHeight", { get: () => 1920 }); v.dispatchEvent(new Event("resize")); });
  await p4.evaluate(() => window.dispatchEvent(new DeviceMotionEvent("devicemotion", { accelerationIncludingGravity: { x: 9.8, y: 0.3, z: 0 } })));
  await wait(800);
  check("phone movement does not turn the picture in OBS", await obs4.evaluate(() => !/rotate/.test(document.getElementById("pic").style.transform)));
  check("upright picture: phone asks to hold it sideways", await p4.isVisible("#rotate"));
  check("and shows the landscape middle part that OBS gets", await p4.evaluate(() => document.getElementById("cam").classList.contains("tall")) && /1080×608/.test(await p4.textContent("#res")), await p4.textContent("#res"));
  check("no Picture turn setting any more", !(await p4.$("#turn")));
  await obs4.evaluate(() => { const v = document.getElementById("video"); Object.defineProperty(v, "videoWidth", { get: () => 1080 }); Object.defineProperty(v, "videoHeight", { get: () => 1920 }); v.dispatchEvent(new Event("resize")); });
  check("OBS fills its landscape frame with the middle of a tall picture (no black sides, not turned)", await obs4.evaluate(() => getComputedStyle(document.getElementById("video")).objectFit === "cover" && !/rotate/.test(document.getElementById("pic").style.transform)));
  check("OBS stats report the landscape size", await until(async () => /1080×608 · \d+fps in OBS/.test(await ctl.textContent("#cams"))));
  await p3.screenshot({ path: process.env.GCCAM_SHOT || require("path").join(require("os").tmpdir(), "gccam-settings.png") });
  check("no page errors", errs.length === 0, errs.join("; "));
  await b.close(); srv.plain.close(); srv.secure.close(); srv.finder.close();
  console.log(results.every(Boolean) ? "all passed" : results.filter(x => !x).length + " failed");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
