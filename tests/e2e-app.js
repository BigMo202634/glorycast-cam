// The Mac app: starts GloryCast Cam in the background (no Terminal window), opening it again
// does not start a second copy, Stop on the page ends it, and a new version takes over from an old one.
// Runs the real launcher from a freshly built "GloryCast Cam.app" (Node is found the way a Mac app finds it).
// Needs playwright. Run: node tests/e2e-app.js
"use strict";
const path = require("path"), os = require("os"), fs = require("fs"), http = require("http");
const { execFileSync, spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");
const PORT = 7985, root = path.resolve(__dirname, ".."), results = [];
const check = (name, ok, extra) => { results.push(!!ok); console.log((ok ? "PASS " : "FAIL ") + name + (extra ? "  (" + extra + ")" : "")); };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 8000); while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } await wait(200); } return null; }
const ask = (method, host, p, headers) => new Promise(ok => {
  const r = http.request({ host, port: PORT, path: p, method, headers: headers || {}, agent: false, timeout: 2000 }, res => {
    let s = ""; res.on("data", d => { s += d; }); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } ok({ status: res.statusCode, json: j }); });
  });
  r.on("timeout", () => r.destroy()); r.on("error", () => ok(null)); r.end();
});
const info = async () => { const r = await ask("GET", "127.0.0.1", "/info"); return r && r.json; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gccam-app-")), data = path.join(tmp, "data");
const env = Object.assign({}, process.env, { GLORYCAST_CAM_PORT: String(PORT), GLORYCAST_CAM_DATA: data });
// servers this test started, found by their script path (read only) so each can be stopped by its PID
const serversOf = file => spawnSync("pgrep", ["-f", file], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
function stopAll(file) { for (const pid of serversOf(file)) { try { process.kill(pid); } catch (e) { /* gone */ } } }

(async () => {
  execFileSync(path.join(root, "tools/mac-app.sh"), [tmp]);
  const app = path.join(tmp, "GloryCast Cam.app"), launcher = path.join(app, "Contents/MacOS/GloryCast Cam");
  const server = path.join(app, "Contents/Resources/server/server.js");
  const plist = fs.readFileSync(path.join(app, "Contents/Info.plist"), "utf8");
  const ver = /const VERSION = "(.*)";/.exec(fs.readFileSync(path.join(root, "server/server.js"), "utf8"))[1];
  check("app is built with its own copy of the pages and server", fs.existsSync(server) && fs.existsSync(path.join(app, "Contents/Resources/app/index.html")) &&
    (fs.statSync(launcher).mode & 0o111) && plist.includes("<string>GloryCast Cam</string>") && plist.includes("<string>" + ver + "</string>"));

  // 1. open the app: it returns at once and leaves GloryCast Cam running on its own
  const t0 = Date.now(), run = () => spawnSync(launcher, [], { env, encoding: "utf8", timeout: 30000 });
  let r = run();
  const first = await info();
  check("opening the app starts GloryCast Cam and returns (no window left open)", r.status === 0 && first && first.version === ver, (Date.now() - t0) + " ms, " + JSON.stringify(first && first.version));
  const pids = serversOf(server);
  const sess = pids.length ? spawnSync("ps", ["-o", "sid=", "-p", String(pids[0])], { encoding: "utf8" }).stdout.trim() : "";
  const mine = spawnSync("ps", ["-o", "sid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim();
  check("it runs in the background on its own, apart from the app", pids.length === 1 && sess && sess !== mine, "server session " + sess + ", app session " + mine);
  check("its messages go to a log file, not a Terminal window", await until(() => /is running/.test(fs.readFileSync(path.join(data, "server.log"), "utf8")), 5000));

  // 2. open it again: still one copy
  r = run();
  check("opening it again does not start a second copy", r.status === 0 && serversOf(server).length === 1 && (await info()).version === ver);

  // 3. the page on this computer has Stop; on another computer it does not
  const b = await chromium.launch();
  const here = await b.newPage(); await here.goto(`http://localhost:${PORT}/`);
  await here.waitForSelector("#connText:text-is('Running')");
  check("Stop shows on this computer's page", await here.isVisible("#stopBtn"));
  const lan = require("../server/server.js").lanIPs()[0];
  if (lan) {
    const other = await b.newPage(); await other.goto(`http://${lan.ip}:${PORT}/`);
    await other.waitForSelector("#connText:text-is('Running')");
    check("but not when the page is opened from another computer", !(await other.isVisible("#stopBtn")));
    await other.close();
    const far = await ask("POST", lan.ip, "/quit");
    check("another computer cannot stop it", far && far.status === 403 && !!(await info()));
  }
  const site = await ask("POST", "127.0.0.1", "/quit", { Origin: "https://example.com" });
  check("a website cannot stop it from this computer's browser", site && site.status === 403 && !!(await info()));

  let asked = "";
  here.once("dialog", d => { asked = d.message(); d.accept(); });
  await here.click("#stopBtn");
  check("Stop asks first, then GloryCast Cam stops", /Stop GloryCast Cam\?/.test(asked) && await until(async () => !(await info()) && serversOf(server).length === 0, 6000), asked);
  check("the page says it stopped and how to start it again", await until(async () => (await here.textContent("#connText")) === "Stopped. Open GloryCast Cam to start it again." && !(await here.isVisible("#stopBtn"))));
  r = run();
  check("opening the app again starts it, and the open page comes back to Running", r.status === 0 && await until(async () => (await here.textContent("#connText")) === "Running" && await here.isVisible("#stopBtn"), 10000));
  await b.close();

  // 4. a newer app takes over from an older copy still running in the background
  stopAll(server); await until(async () => !(await info()), 5000);
  const old = path.join(tmp, "old"); fs.mkdirSync(path.join(old, "server"), { recursive: true });
  fs.cpSync(path.join(root, "app"), path.join(old, "app"), { recursive: true });
  fs.copyFileSync(path.join(root, "server/cert.js"), path.join(old, "server/cert.js"));
  fs.writeFileSync(path.join(old, "server/server.js"), fs.readFileSync(server, "utf8").replace(/const VERSION = ".*";/, 'const VERSION = "1.3.2-old";'));
  spawn(process.execPath, [path.join(old, "server/server.js")], { env, detached: true, stdio: "ignore" }).unref();
  check("an older copy is running", (await until(info, 8000) || {}).version === "1.3.2-old");
  r = run();
  check("opening the new app stops the older copy and starts the new one", r.status === 0 && (await info() || {}).version === ver && serversOf(path.join(old, "server/server.js")).length === 0);

  // 5. a copy from before the Mac app (1.3.2, in a Terminal window) cannot be stopped: the app says what to do
  stopAll(server); await until(async () => !(await info()), 5000);
  fs.writeFileSync(path.join(old, "server/server.js"), execFileSync("git", ["-C", root, "show", "fcf7ad9:server/server.js"]));
  spawn(process.execPath, [path.join(old, "server/server.js")], { env, detached: true, stdio: "ignore" }).unref();
  await until(info, 8000);
  const msg = spawnSync(process.execPath, [server, "--app"], { env, encoding: "utf8", timeout: 30000 });
  check("with 1.3.2 still open in a Terminal window, the app asks to close that window", msg.status === 2 && /older GloryCast Cam \(1\.3\.2\) is still running.*Close that window/.test(msg.stdout), msg.stdout.trim());
  stopAll(path.join(old, "server/server.js")); await until(async () => !(await info()), 5000);

  // 6. opened straight from Downloads (macOS runs a hidden copy): the app asks to move it to Applications
  const moved = path.join(tmp, "AppTranslocation", "x");
  fs.mkdirSync(moved, { recursive: true }); fs.cpSync(app, path.join(moved, "GloryCast Cam.app"), { recursive: true });
  r = spawnSync(path.join(moved, "GloryCast Cam.app/Contents/MacOS/GloryCast Cam"), [], { env, encoding: "utf8", timeout: 30000 });
  await wait(1500);
  check("opened from a hidden copy, it does not start (asks to move it to Applications first)", r.status === 0 && !(await info()));

  stopAll(server);
  console.log(results.every(Boolean) ? "all passed" : results.filter(x => !x).length + " failed");
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
