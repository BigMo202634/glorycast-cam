// GloryCast Cam: turns phones on the church Wi-Fi into cameras for OBS and vMix.
//   http://localhost:7795/            this computer's page: join code, cameras, OBS links
//   https://<this-ip>:7796/phone      the camera page phones open (https so the camera is allowed)
//   http://localhost:7795/view?cam=x  the picture for an OBS Browser source or vMix Browser input
// The picture goes straight from phone to OBS over the Wi-Fi (WebRTC). This server only
// introduces them, passes the red/green tally back to the phone, and serves the pages.
"use strict";
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), dgram = require("dgram");
const { makeCert } = require("./cert");

const HTTP_PORT = +process.env.GLORYCAST_CAM_PORT || 7795, HTTPS_PORT = HTTP_PORT + 1, FIND_PORT = HTTP_PORT + 2;
const APP = path.join(__dirname, "..", "app");
const DATA = process.env.GLORYCAST_CAM_DATA || path.join(os.homedir(), ".glorycast-cam");
const VERSION = "1.3.3";
// changes whenever any page file changes, so pages left open in OBS reload to the new version
const BUILD = (function () {
  const h = crypto.createHash("sha1");
  for (const f of fs.readdirSync(path.join(__dirname, "..", "app"), { recursive: true }).sort()) {
    const full = path.join(__dirname, "..", "app", String(f));
    if (fs.statSync(full).isFile()) h.update(String(f)).update(fs.readFileSync(full));
  }
  return h.digest("hex").slice(0, 10);
})();

function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || a.address.startsWith("169.254.")) continue;
      // virtual adapters (VirtualBox, Hyper-V, VPNs) are listed last so the Wi-Fi address comes first
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vbox|tailscale|zerotier|loopback/i.test(name);
      out.push({ ip: a.address, name, virtual });
    }
  }
  out.sort((a, b) => a.virtual - b.virtual || (/^192\.168\./.test(b.ip) - /^192\.168\./.test(a.ip)));
  return out;
}

// Reuse the certificate while this computer keeps the same addresses, so phones only accept it once
function certificate(ips) {
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, "cert.json");
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    const fresh = new Date(c.expires) - Date.now() > 30 * 86400000;
    if (fresh && ips.every(ip => c.ips.includes(ip))) return c;
  } catch (e) { /* first run or unreadable: make a new one */ }
  const all = Array.from(new Set(ips));
  const c = Object.assign(makeCert(all, 365), { ips: all });
  fs.writeFileSync(file, JSON.stringify(c));
  return c;
}

// ---- who is connected ------------------------------------------------------
// clients: id -> { id, role: phone|view|preview|control, cam, name, res, send(event, data) }
const clients = new Map();
const status = new Map(); // phone id -> latest status the phone sent (battery, size, camera abilities)
const stills = new Map(); // cam -> { buf, at }: a small picture the phone sends every second
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "camera";
const phoneFor = cam => Array.from(clients.values()).find(c => c.role === "phone" && c.cam === cam);
const viewersOf = cam => Array.from(clients.values()).filter(c => (c.role === "view" || c.role === "preview") && c.cam === cam);

// live: an OBS source of this camera is on Program. standby: it is in OBS but not on Program.
// unknown: only vMix or a plain browser has it, which cannot say. off: nothing shows it.
function tallyOf(cam) {
  const v = viewersOf(cam).filter(c => c.role === "view");
  if (v.some(c => c.live)) return "live";
  if (v.some(c => c.obs)) return "standby";
  return v.length ? "unknown" : "off";
}
function sendTally(cam) {
  const p = phoneFor(cam), t = tallyOf(cam);
  if (p && p.tally !== t) { p.tally = t; p.send("tally", { tally: t }); }
  broadcastState();
}
// An OBS picture page that keeps reopening means OBS closes the Browser source when it is hidden
// ("Shutdown source when not visible") or reloads it when it goes live ("Refresh browser when
// scene becomes active"). Each time, the picture has to connect again, so the media computer page warns.
const pages = new Map(); // "cam|address" -> { cam, page, joined, left, restarts: [times] }
const TEN_MIN = 600000;
function notePage(c, joining) {
  if (c.role !== "view") return;
  const k = c.cam + "|" + c.addr, now = Date.now();
  let l = pages.get(k);
  if (!l) pages.set(k, l = { cam: c.cam, page: null, joined: 0, left: 0, restarts: [] });
  if (joining) {
    // the same page reconnecting is not a restart; a new page after the last one closed is
    if (l.page && l.page !== c.page && l.left >= l.joined && now - l.left < TEN_MIN) l.restarts.push(now);
    l.page = c.page; l.joined = now;
  } else if (l.page === c.page) l.left = now;
  else if (now - l.joined < 3000) l.restarts.push(now); // the new page arrived just before the old one closed
}
function restartsOf(cam) {
  const now = Date.now(); let n = 0;
  for (const l of pages.values()) if (l.cam === cam) { l.restarts = l.restarts.filter(t => now - t < TEN_MIN); n += l.restarts.length; }
  return n;
}
// most OBS Browser sources showing this camera from one computer (each one makes the phone send another picture)
function copiesOf(cam) {
  const by = {};
  for (const v of viewersOf(cam)) if (v.role === "view") by[v.addr] = (by[v.addr] || 0) + 1;
  return Math.max(0, ...Object.values(by));
}
function cameras() {
  const cams = new Map();
  for (const c of clients.values()) {
    if (c.role === "phone") cams.set(c.cam, { cam: c.cam, name: c.name, online: true, since: c.since, status: status.get(c.id) || null });
  }
  for (const c of clients.values()) {
    if (c.role === "view" && !cams.has(c.cam)) cams.set(c.cam, { cam: c.cam, name: c.cam, online: false });
  }
  return Array.from(cams.values()).map(x => Object.assign(x, {
    tally: tallyOf(x.cam), viewers: viewersOf(x.cam).filter(c => c.role === "view").length,
    restarting: restartsOf(x.cam) >= 3, copies: copiesOf(x.cam),
    stats: (viewersOf(x.cam).find(c => c.role === "view" && c.stats) || {}).stats || null
  })).sort((a, b) => a.name.localeCompare(b.name));
}
let stateTimer = null;
function broadcastState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const s = { cameras: cameras() };
    for (const c of clients.values()) if (c.role === "control") c.send("state", s);
  }, 80);
}

function join(c) {
  if (c.role === "phone") {
    const old = phoneFor(c.cam);
    if (old) { old.send("replaced", {}); old.close(); }
    clients.set(c.id, c);
    for (const v of viewersOf(c.cam)) { v.send("phone-here", {}); c.send("viewer", { id: v.id, kind: v.role }); }
    c.tally = null; sendTally(c.cam);
  } else {
    clients.set(c.id, c);
    notePage(c, true);
    if (c.role === "view" || c.role === "preview") {
      const p = phoneFor(c.cam);
      if (p) { p.send("viewer", { id: c.id, kind: c.role }); if (p.look) c.send("look", p.look); }
      sendTally(c.cam);
    }
  }
  broadcastState();
}
function leave(c) {
  if (clients.get(c.id) !== c) return;
  clients.delete(c.id); status.delete(c.id); notePage(c, false);
  if (c.role === "phone") for (const v of viewersOf(c.cam)) v.send("phone-left", {});
  if (c.role === "view" || c.role === "preview") {
    const p = phoneFor(c.cam);
    if (p) p.send("viewer-left", { id: c.id });
    sendTally(c.cam);
  }
  broadcastState();
}

// ---- http ------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const PAGES = { "/": "index.html", "/phone": "phone.html", "/view": "view.html" };

function body(req) {
  return new Promise((resolve, reject) => {
    let s = ""; req.on("data", d => { s += d; if (s.length > 200000) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}
function raw(req, max) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > max) { reject(new Error("too big")); req.destroy(); } else parts.push(d); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }
// a page served on the church Wi-Fi or on this computer (GloryCast Switch), not a website out on the internet
function lanOrigin(o) {
  try { return /^(localhost|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2}|169\.254(\.\d+){2}|\[::1\]|[a-z0-9-]+|[a-z0-9.-]+\.local)$/i.test(new URL(o).hostname); }
  catch (e) { return false; }
}

let ctx = { ips: [], cert: null };
function info() {
  const ip = (ctx.ips[0] || {}).ip || "localhost";
  return {
    version: VERSION, build: BUILD, ip, ips: ctx.ips.map(x => ({ ip: x.ip, name: x.name })),
    httpPort: HTTP_PORT, httpsPort: HTTPS_PORT,
    phoneUrl: "https://" + ip + ":" + HTTPS_PORT + "/phone",
    viewBase: "http://localhost:" + HTTP_PORT + "/view?cam=",
    lanViewBase: "http://" + ip + ":" + HTTP_PORT + "/view?cam="
  };
}

async function handle(req, res, secure) {
  const url = new URL(req.url, "http://x"), p = url.pathname;
  try {
    if (p === "/events") return events(req, res, url, secure);
    if (req.method === "POST" && p === "/signal") {
      const m = await body(req), to = clients.get(m.to), from = clients.get(m.from);
      if (!from) return json(res, 410, { error: "gone" });
      if (to) to.send("signal", { from: m.from, data: m.data });
      return json(res, 200, { ok: !!to });
    }
    if (req.method === "POST" && p === "/tally") {
      const m = await body(req), c = clients.get(m.id);
      if (!c) return json(res, 410, { error: "gone" });
      if ("live" in m) c.live = !!m.live;
      if ("obs" in m) c.obs = !!m.obs;
      if (m.stats) c.stats = m.stats;
      // This page stayed open after OBS put it live and after OBS hid it: OBS is no longer restarting it
      if ((m.ev === "lived" || m.ev === "hid") && c.role === "view") {
        const what = m.ev;
        setTimeout(() => {
          if (clients.get(c.id) !== c) return;
          c[what] = true;
          const l = pages.get(c.cam + "|" + c.addr);
          if (c.lived && c.hid && l && l.restarts.length) { l.restarts = []; broadcastState(); }
        }, 5000);
      }
      sendTally(c.cam);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/look") { // how much OBS should brighten this phone's picture
      const m = await body(req), c = clients.get(m.id);
      if (!c || c.role !== "phone") return json(res, 410, { error: "gone" });
      const l = m.look || {};
      c.look = { gain: Math.max(-3, Math.min(3, +l.gain || 0)) }; // nothing is turned any more
      for (const v of viewersOf(c.cam)) v.send("look", c.look);
      return json(res, 200, { ok: true });
    }
    if (p === "/still") { // the phone's latest small picture, shown while a live picture (re)connects
      if (req.method === "POST") {
        const c = clients.get(url.searchParams.get("id"));
        if (!c || c.role !== "phone") { req.resume(); return json(res, 410, { error: "gone" }); }
        const buf = await raw(req, 3000000);
        if (buf[0] === 0xff && buf[1] === 0xd8) stills.set(c.cam, { buf, at: Date.now() });
        return json(res, 200, { ok: true });
      }
      const s = stills.get(slug(url.searchParams.get("cam")));
      if (!s || Date.now() - s.at > 5000) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end(); }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": s.buf.length, "Cache-Control": "no-store" });
      return res.end(s.buf);
    }
    if (req.method === "POST" && p === "/status") {
      const m = await body(req), c = clients.get(m.id);
      if (!c) return json(res, 410, { error: "gone" });
      status.set(c.id, m.status || {}); broadcastState();
      return json(res, 200, { ok: true });
    }
    if (p === "/info") return json(res, 200, info());
    if (req.method === "POST" && p === "/quit") { // Stop on this computer's page, or a newer GloryCast Cam taking over
      const o = req.headers.origin; // a website cannot stop it from this computer's browser
      if (!isLocal(req) || (o && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(o))) return json(res, 403, { error: "only from this computer" });
      json(res, 200, { ok: true });
      console.log("\n  GloryCast Cam was stopped.\n");
      return setTimeout(() => process.exit(0), 300);
    }
    if (p === "/cams") { // GloryCast Switch reads each phone's battery here, to warn the operator before one runs out
      const origin = req.headers.origin, h = { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" };
      if (lanOrigin(origin)) Object.assign(h, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Private-Network": "true" });
      if (req.method === "OPTIONS") { res.writeHead(204, Object.assign(h, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "600" })); return res.end(); }
      res.writeHead(200, h);
      return res.end(JSON.stringify({ app: "glorycast-cam", version: VERSION, cameras: cameras().map(x => {
        const s = x.status || {};
        return { cam: x.cam, name: x.name, online: x.online, battery: typeof s.battery === "number" ? s.battery : null, charging: !!s.charging };
      }) }));
    }
    if (p === "/cert") { // lets someone install the certificate if their phone insists
      res.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=GloryCast-Cam.crt" });
      return res.end(ctx.cert.cert);
    }
    // phones arriving on plain http get sent to the https address
    if (!secure && p === "/phone" && !isLocal(req)) {
      const host = (req.headers.host || "").split(":")[0];
      res.writeHead(302, { Location: "https://" + host + ":" + HTTPS_PORT + "/phone" + url.search }); return res.end();
    }
    const file = PAGES[p] || p.replace(/^\/+/, "");
    const full = path.join(APP, path.normalize(file).replace(/^(\.\.[\/\\])+/, ""));
    if (!full.startsWith(APP)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
}
function isLocal(req) { const a = req.socket.remoteAddress || ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; }

function events(req, res, url, secure) {
  const role = url.searchParams.get("role");
  if (!["phone", "view", "preview", "control"].includes(role)) { res.writeHead(400); return res.end(); }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 1500\n\n");
  const name = String(url.searchParams.get("name") || url.searchParams.get("cam") || "").trim().slice(0, 30);
  const c = {
    id: crypto.randomBytes(6).toString("hex"), role, name: name || "Camera", cam: slug(url.searchParams.get("cam") || name),
    since: Date.now(), live: false, obs: url.searchParams.get("obs") === "1", // obs: an OBS Browser source, which can say when it is live
    addr: String(req.socket.remoteAddress || "").replace(/^::ffff:/, ""), page: String(url.searchParams.get("page") || "").slice(0, 20),
    send(ev, data) { try { res.write("event: " + ev + "\ndata: " + JSON.stringify(data) + "\n\n"); } catch (e) { /* closed */ } },
    close() { try { res.end(); } catch (e) { /* closed */ } leave(c); }
  };
  c.send("hello", { id: c.id, cam: c.cam, name: c.name, info: info(), phone: role !== "phone" && !!phoneFor(c.cam) });
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) { /* closed */ } }, 15000);
  req.on("close", () => { clearInterval(ping); leave(c); });
  join(c);
  if (role === "control") c.send("state", { cameras: cameras() });
}

// The GloryCast Cam app on Android finds this computer by itself: it asks the whole Wi-Fi
// "GLORYCAST-CAM?" and this answers with its name and port. Typing the address still works.
function listenForApps() {
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  s.on("message", (msg, from) => {
    if (String(msg).trim() !== "GLORYCAST-CAM?") return;
    const reply = Buffer.from(JSON.stringify({ app: "glorycast-cam", name: os.hostname().replace(/\.local$/i, ""), version: VERSION, http: HTTP_PORT, https: HTTPS_PORT }));
    s.send(reply, from.port, from.address, () => {});
  });
  s.on("error", () => { try { s.close(); } catch (e) { /* closed */ } });
  s.bind(FIND_PORT, "0.0.0.0");
  return s;
}

function start() {
  ctx.ips = lanIPs();
  ctx.cert = certificate(ctx.ips.map(x => x.ip));
  const plain = http.createServer((q, r) => handle(q, r, false));
  const secure = https.createServer({ cert: ctx.cert.cert, key: ctx.cert.key }, (q, r) => handle(q, r, true));
  for (const s of [plain, secure]) { s.keepAliveTimeout = 65000; s.requestTimeout = 0; s.headersTimeout = 70000; }
  const fail = port => e => {
    if (e.code === "EADDRINUSE") console.log("\nGloryCast Cam is already running (port " + port + " is busy). Close the other window first.\n");
    else console.log(e);
    process.exit(1);
  };
  plain.on("error", fail(HTTP_PORT)); secure.on("error", fail(HTTPS_PORT));
  const finder = listenForApps();
  plain.listen(HTTP_PORT, "0.0.0.0", () => secure.listen(HTTPS_PORT, "0.0.0.0", () => {
    const i = info();
    console.log("\n  GloryCast Cam " + VERSION + " is running. Keep this window open during the service.\n");
    console.log("  On this computer:   http://localhost:" + HTTP_PORT + "/");
    console.log("  Phones open:        " + i.phoneUrl);
    if (ctx.ips.length > 1) console.log("  Other addresses:    " + ctx.ips.slice(1).map(x => x.ip + " (" + x.name + ")").join(", "));
    console.log("");
    if (process.argv.includes("--open")) openBrowser("http://localhost:" + HTTP_PORT + "/");
  }));
  return { plain, secure, finder };
}
function openBrowser(u) {
  const { exec } = require("child_process");
  const cmd = process.platform === "win32" ? 'start "" "' + u + '"' : process.platform === "darwin" ? 'open "' + u + '"' : 'xdg-open "' + u + '"';
  exec(cmd, () => {});
}


// The Mac app starts GloryCast Cam with --app: it runs in the background (no Terminal window) and its
// page opens. Opening the app again just opens the page; a different version is asked to stop first.
function startForApp() {
  const ask = (method, p) => new Promise(done => {
    const r = http.request({ host: "127.0.0.1", port: HTTP_PORT, path: p, method, agent: false, timeout: 2000 }, res => {
      let s = ""; res.on("data", d => { s += d; });
      res.on("end", () => { try { done(JSON.parse(s)); } catch (e) { done({}); } });
    });
    r.on("timeout", () => r.destroy()); r.on("error", () => done(null)); r.end();
  });
  const until = async (ok, ms) => {
    const end = Date.now() + ms; let v = null;
    while (Date.now() < end) { v = await ask("GET", "/info"); if (ok(v)) break; await new Promise(r => setTimeout(r, 250)); }
    return v;
  };
  const fail = msg => { console.log(msg); process.exitCode = 2; };
  (async () => {
    let now = await ask("GET", "/info");
    if (now && now.version !== VERSION) {
      if (!now.version) return fail("Another program on this computer is using port " + HTTP_PORT + ". Close it, then open GloryCast Cam again.");
      await ask("POST", "/quit");
      now = await until(v => !v, 8000);
      if (now) return fail("An older GloryCast Cam (" + now.version + ") is still running, probably in a Terminal window. Close that window, then open GloryCast Cam again.");
    }
    if (!now) {
      fs.mkdirSync(DATA, { recursive: true });
      const logFile = path.join(DATA, "server.log"), log = fs.openSync(logFile, "w");
      require("child_process").spawn(process.execPath, [__filename], { detached: true, stdio: ["ignore", log, log], cwd: os.homedir() }).unref();
      fs.closeSync(log);
      now = await until(v => v && v.version === VERSION, 20000);
      if (!now || now.version !== VERSION) return fail("GloryCast Cam could not start. The details are in " + logFile);
    }
    openBrowser("http://localhost:" + HTTP_PORT + "/");
  })();
}
if (require.main === module) { if (process.argv.includes("--app")) startForApp(); else start(); }
module.exports = { start, lanIPs, slug, clients };
