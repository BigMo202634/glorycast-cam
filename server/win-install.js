// Installs GloryCast Cam on Windows like an app: a copy in %LOCALAPPDATA%\Programs\GloryCast Cam, a Start menu and
// desktop icon, and an entry in Settings > Apps so it can be removed. The icons start Node (signed by the OpenJS
// Foundation) on server.js --app, so Smart App Control, which blocks unsigned programs and .bat files from the
// internet, lets it run. Run once from the unzipped folder: runtime\node.exe server\server.js --install
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), http = require("http");
const { execFileSync, spawn } = require("child_process");

const NAME = "GloryCast Cam", REG = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GloryCastCam";
const env = process.env;
const home = () => env.USERPROFILE || os.homedir();
const installDir = () => path.join(env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), "Programs", NAME);
const startMenu = () => path.join(env.APPDATA || path.join(home(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", NAME + ".lnk");
function desktop() { // the real Desktop, which OneDrive often moves
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders", "/v", "Desktop"], { encoding: "utf8", windowsHide: true });
    const m = /Desktop\s+REG_\w+\s+(.+)/.exec(out); if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  } catch (e) { /* use the usual place */ }
  return path.join(home(), "Desktop");
}

// A Windows shortcut (.lnk, [MS-SHLLINK]) found by its path alone: header, LinkInfo with a Unicode local path,
// then name, working folder, arguments and icon. Minimised, so Node's console only flashes on the taskbar.
function shortcut(target, args, workDir, icon, description) {
  const u16 = s => Buffer.from(s + "\0", "utf16le"), a8 = s => Buffer.from(s.replace(/[^\x20-\x7e]/g, "_") + "\0", "latin1");
  const head = Buffer.alloc(76);
  head.writeUInt32LE(0x4c, 0);
  Buffer.from("0114020000000000c000000000000046", "hex").copy(head, 4);
  head.writeUInt32LE(0x02 | 0x04 | 0x10 | 0x20 | 0x40 | 0x80, 20); // LinkInfo, name, working dir, arguments, icon, Unicode
  head.writeUInt32LE(0x20, 24); // archive
  head.writeUInt32LE(7, 60); // SW_SHOWMINNOACTIVE
  const vol = Buffer.alloc(17); vol.writeUInt32LE(17, 0); vol.writeUInt32LE(3, 4); vol.writeUInt32LE(0x10, 12); // fixed drive, empty label
  const local = a8(target), suffix = Buffer.from([0]), localU = u16(target), suffixU = Buffer.from([0, 0]);
  const hdr = 0x24, volAt = hdr, localAt = volAt + vol.length, sufAt = localAt + local.length;
  const localUAt = sufAt + suffix.length, sufUAt = localUAt + localU.length, size = sufUAt + suffixU.length;
  const info = Buffer.alloc(hdr);
  info.writeUInt32LE(size, 0); info.writeUInt32LE(hdr, 4); info.writeUInt32LE(1, 8); // VolumeIDAndLocalBasePath
  info.writeUInt32LE(volAt, 12); info.writeUInt32LE(localAt, 16); info.writeUInt32LE(0, 20); info.writeUInt32LE(sufAt, 24);
  info.writeUInt32LE(localUAt, 28); info.writeUInt32LE(sufUAt, 32);
  const str = s => { const b = Buffer.alloc(2); b.writeUInt16LE(s.length, 0); return Buffer.concat([b, Buffer.from(s, "utf16le")]); };
  return Buffer.concat([head, info, vol, local, suffix, localU, suffixU,
    str(description), str(workDir), str(args), str(icon), Buffer.alloc(4)]);
}

const ask = (method, p, port) => new Promise(done => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, agent: false, timeout: 2000 }, res => {
    let s = ""; res.on("data", d => { s += d; }); res.on("end", () => { try { done(JSON.parse(s)); } catch (e) { done({}); } });
  });
  r.on("timeout", () => r.destroy()); r.on("error", () => done(null)); r.end();
});
async function stopRunning(port) { // an open GloryCast Cam is asked to stop, so its files can be replaced
  if (!(await ask("GET", "/info", port))) return true;
  await ask("POST", "/quit", port);
  for (let i = 0; i < 40; i++) { if (!(await ask("GET", "/info", port))) return true; await new Promise(r => setTimeout(r, 250)); }
  return false;
}
function unmark(dir) { // drop the "came from the internet" mark Windows puts on unzipped files
  for (const f of fs.readdirSync(dir, { recursive: true })) { try { fs.unlinkSync(path.join(dir, String(f)) + ":Zone.Identifier"); } catch (e) { /* none */ } }
}

async function install({ version, port }) {
  const src = path.join(__dirname, ".."), dest = installDir();
  const node = path.join(src, "runtime", "node.exe");
  if (!fs.existsSync(node)) throw new Error("runtime\\node.exe is missing. Unzip the whole GloryCast-Cam folder first, then run this again.");
  console.log("\n  Installing " + NAME + " " + version + " ...");
  if (!(await stopRunning(port))) throw new Error("A GloryCast Cam window is still open. Close it, then run this again.");
  if (path.resolve(src).toLowerCase() !== path.resolve(dest).toLowerCase()) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.join(dest, "runtime"), { recursive: true });
    for (const d of ["app", "server"]) fs.cpSync(path.join(src, d), path.join(dest, d), { recursive: true });
    fs.copyFileSync(node, path.join(dest, "runtime", "node.exe"));
    if (fs.existsSync(path.join(src, "README.txt"))) fs.copyFileSync(path.join(src, "README.txt"), path.join(dest, "README.txt"));
  }
  unmark(dest);
  const exe = path.join(dest, "runtime", "node.exe"), script = path.join(dest, "server", "server.js"), icon = path.join(dest, "app", "img", "icon.ico");
  const lnk = shortcut(exe, '"' + script + '" --app', dest, icon, "Phones on the church Wi-Fi become cameras for OBS and vMix");
  const links = [startMenu(), path.join(desktop(), NAME + ".lnk")];
  for (const l of links) { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.writeFileSync(l, lnk); }
  if (process.platform === "win32") {
    // Windows' own shortcut maker, where PowerShell allows it, rewrites them in full; else the ones above stay
    for (const l of links) {
      try {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:GC_LNK);$s.TargetPath=$env:GC_EXE;$s.Arguments=$env:GC_ARGS;" +
          "$s.WorkingDirectory=$env:GC_DIR;$s.IconLocation=$env:GC_ICON;$s.WindowStyle=7;$s.Description='GloryCast Cam';$s.Save()"],
        { windowsHide: true, stdio: "ignore", timeout: 20000, env: Object.assign({}, env, { GC_LNK: l, GC_EXE: exe, GC_ARGS: '"' + script + '" --app', GC_DIR: dest, GC_ICON: icon + ",0" }) });
      } catch (e) { /* the hand-made shortcut stays */ }
    }
    const add = (v, t, d) => execFileSync("reg", ["add", REG, "/v", v, "/t", t, "/d", d, "/f"], { windowsHide: true, stdio: "ignore" });
    add("DisplayName", "REG_SZ", NAME); add("DisplayVersion", "REG_SZ", version); add("Publisher", "REG_SZ", "GloryCast");
    add("DisplayIcon", "REG_SZ", icon); add("InstallLocation", "REG_SZ", dest);
    add("UninstallString", "REG_SZ", '"' + exe + '" "' + script + '" --uninstall');
    add("NoModify", "REG_DWORD", "1"); add("NoRepair", "REG_DWORD", "1");
  }
  console.log("  Installed. Open GloryCast Cam from the Start menu or the desktop icon.");
  console.log("  The first time, Windows asks about the firewall for Node.js: tick Private and Public, then Allow.\n");
  return { dest, links, exe, script };
}

async function uninstall({ port }) {
  await stopRunning(port);
  for (const l of [startMenu(), path.join(desktop(), NAME + ".lnk")]) fs.rmSync(l, { force: true });
  if (process.platform === "win32") {
    try { execFileSync("reg", ["delete", REG, "/f"], { windowsHide: true, stdio: "ignore" }); } catch (e) { /* not there */ }
    // node.exe cannot delete itself while running, so a short-lived cmd removes the folder once this exits
    spawn("cmd.exe", ["/d", "/c", 'ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + installDir() + '"'], { detached: true, stdio: "ignore", windowsHide: true, cwd: os.tmpdir() }).unref();
  } else fs.rmSync(installDir(), { recursive: true, force: true });
  console.log("\n  " + NAME + " was removed.\n");
}

module.exports = { install, uninstall, shortcut, installDir, startMenu };
