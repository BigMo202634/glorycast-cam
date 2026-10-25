/*
  GloryCast Switch: a phone or tablet video switcher for OBS.
  Every OBS scene shows as a tile with a moving picture. Tap = Live sends the
  tapped scene straight to the stream; with Preview first a tap lines the scene
  up on the phone and CUT or AUTO takes it live. OBS's own Studio Mode and
  Preview belong to the computer: Switch never turns Studio Mode off, so a scene
  clicked in OBS opens in Preview for editing instead of going live.
  Program mode: OBS streams "GloryCast On Air", which holds "GloryCast Program"
  with every camera scene inside it; a tap shows that camera and hides the others,
  so overlays placed above the cameras in that scene stay on screen whatever is live.
  In Studio Mode OBS streams a copy of the live scene, but scenes placed inside it
  are shared, not copied, so switching inside GloryCast Program shows at once.
  Showing a camera inside a scene ignores OBS's transition, so Program mode makes its own fade: one request
  batch, run by obs-websocket on OBS's own frame clock (smooth even over Wi-Fi), puts the camera on top with
  its "GloryCast Fade" filter (Color Correction opacity) at 0, raises it to 1, then hides the old camera.
  Pictures come from obs-websocket GetSourceScreenshot, a few at a time.
  GloryCast Cam phones in OBS report their battery; a phone running low shows on its
  channel and in a warning across the top, so the operator can tell that camera person.
*/
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("gcswitch." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("gcswitch." + k, JSON.stringify(v)); } catch (e) {} }
  };
  // Pictures asked for at once, pause after each, and largest picture widths, for each speed.
  var SPEEDS = { saver: { workers: 1, gap: 300, big: 480, small: 240 }, normal: { workers: 2, gap: 40, big: 720, small: 320 }, smooth: { workers: 3, gap: 0, big: 960, small: 400 } };
  // Scenes (4), Transitions (16), Outputs (64), Scene items (128) and Ui (1024, Studio Mode) events.
  var EVENTS = 4 | 16 | 64 | 128 | 1024;
  var PROG = "GloryCast Program", ONAIR = "GloryCast On Air";

  var obs = null;
  var st = { scenes: [], pgm: "", pvw: "", studio: store.get("localStudio", false), transitions: [], transition: "", duration: 300, speed: store.get("speed", "normal"),
             grid: store.get("grid", "4x2"), map: store.get("map", null), arranging: false, monH: store.get("monH", 45),
             prog: store.get("prog", false), obsPgm: "", obsPvw: "", obsStudio: false, items: {} };
  // Program mode fades. fps: OBS's frame rate; has: cameras that have the filter; steps: OBS refused the
  // frame-clock fade, so the phone times the fade itself; off: no fade filter to be had, so switch the old way
  // until the next link-up (why: OBS's reason, shown on the phone); busy: a switch is running; next: the switch
  // asked for meanwhile (only the latest), run as soon as it ends.
  var FADE = "GloryCast Fade", FADE_KIND = "color_filter_v2";
  var fade = { fps: 30, has: {}, steps: false, off: false, why: "", busy: false, next: null };
  var noPic = {};        // scene -> failed pictures in a row
  // st.studio is Preview first, kept here on the phone; st.obsStudio and st.obsPvw are OBS's own Studio Mode and Preview.
  // In Program mode st.pgm is the camera showing inside GloryCast Program.
  var GRIDS = ["2x2", "3x2", "4x2", "3x3", "4x3", "6x2"];
  var tiles = {};        // scene name -> tile element
  var shots = {};        // scene name -> last picture
  var last = {};         // "big:" or "small:" + scene name -> when its picture last arrived
  var busy = {};         // pictures being fetched right now
  var count = 0;         // pictures fetched, for the per-second figure

  /* ---------- OBS link ---------- */

  // In the Android app the page comes from inside the app, so OBS's address is the one the app found on the Wi-Fi.
  var android = window.GCAndroid || null, foundHost = "";
  function defaultHost() {
    if (android) { try { return foundHost || android.obsHost() || "127.0.0.1"; } catch (e) { return "127.0.0.1"; } }
    var h = location.hostname;
    return location.protocol.indexOf("http") === 0 && h && h !== "localhost" ? h : "127.0.0.1";
  }
  function setState(text, cls) { var e = $("state"); e.textContent = text; e.className = cls || ""; }

  var linkHost = "";      // the OBS address the phone is linking to now
  function connect() {
    if (obs) obs.close();
    var host = (store.get("host", "") || defaultHost()).trim(), port = store.get("port", "") || "4455";
    linkHost = host;
    obs = new OBSClient({ url: "ws://" + host + ":" + port, password: store.get("pw", ""), events: EVENTS, reconnect: true, onStatus: onStatus, onEvent: onEvent });
    obs.connect();
  }

  function onStatus(s, detail) {
    if (s === "connected") { setState("OBS linked", "on"); $("msg").textContent = "Linked."; sync(); }
    else if (s === "connecting") setState("Linking…");
    else {
      setState(detail === "Wrong OBS password" ? "Wrong password" : "Not linked", "bad"); $("msg").textContent = detail || "";
      if (/password/i.test(detail || "") && !$("sheet").classList.contains("open")) openSheet();
    }
  }

  function sync() {
    fade.has = {}; fade.steps = false; fade.off = false; fade.why = ""; // look for the fade filter again, and try it again if it failed
    return Promise.all([
      obs.request("GetSceneList"), obs.request("GetStudioModeEnabled"),
      obs.request("GetSceneTransitionList"), obs.request("GetCurrentSceneTransition").catch(function () { return {}; }),
      obs.request("GetStreamStatus").catch(function () { return {}; }), obs.request("GetVideoSettings").catch(function () { return {}; })
    ]).then(function (r) {
      setScenes(r[0]);
      // A phone that has not chosen yet (a new link starts with no settings) follows an OBS already set up for Program mode.
      if (!st.prog && store.get("prog", null) === null && (st.obsPgm === ONAIR || st.obsPgm === PROG)) {
        st.prog = true; st.pgm = ""; store.set("prog", true); $("progMode").checked = true;
      }
      st.obsStudio = !!r[1].studioModeEnabled;
      st.transitions = r[2].transitions || [];
      st.transition = r[2].currentSceneTransitionName || "";
      if (r[3].transitionDuration) st.duration = r[3].transitionDuration;
      $("onair").classList.toggle("on", !!r[4].outputActive);
      fade.fps = r[5].fpsNumerator > 0 && r[5].fpsDenominator > 0 ? r[5].fpsNumerator / r[5].fpsDenominator : 30;
      render();
      scanCams();
      if (st.prog) return setupProgram();
    }).catch(function (e) { $("msg").textContent = e.message; });
  }

  function setScenes(r) {
    st.scenes = (r.scenes || []).slice().sort(function (a, b) { return b.sceneIndex - a.sceneIndex; }).map(function (s) { return s.sceneName; });
    st.obsPgm = r.currentProgramSceneName || st.obsPgm;
    st.obsPvw = r.currentPreviewSceneName || "";
    if (!st.prog) st.pgm = st.obsPgm;
    buildTiles();
  }

  function onEvent(type, d) {
    if (type === "CurrentProgramSceneChanged") { st.obsPgm = d.sceneName; if (!st.prog) st.pgm = d.sceneName; }
    else if (type === "CurrentPreviewSceneChanged") { obsPreview(d.sceneName); return; }
    else if (/^SceneItem(EnableStateChanged|Created|Removed)$/.test(type)) { if (st.prog && d.sceneName === PROG) readProgram(); if (type !== "SceneItemEnableStateChanged") rescanCams(); return; }
    else if (type === "StudioModeStateChanged") {
      st.obsStudio = !!d.studioModeEnabled; st.obsPvw = "";
      if (st.obsStudio) obs.request("GetCurrentPreviewScene").then(function (r) { st.obsPvw = r.currentPreviewSceneName || r.sceneName || ""; }).catch(function () {});
      return;
    }
    else if (type === "CurrentSceneTransitionChanged") st.transition = d.transitionName;
    else if (type === "CurrentSceneTransitionDurationChanged") st.duration = d.transitionDuration;
    else if (type === "StreamStateChanged") $("onair").classList.toggle("on", !!d.outputActive);
    else if (type === "SceneListChanged" || type === "SceneNameChanged" || type === "SceneCreated" || type === "SceneRemoved") {
      obs.request("GetSceneList").then(function (r) { setScenes(r); render(); }).catch(function () {});
      rescanCams();
      return;
    } else return;
    render();
  }

  /* ---------- Screen ---------- */

  function gridSize() { var p = String(st.grid).split("x"); return { cols: +p[0] || 4, rows: +p[1] || 2 }; }
  function channelCount() { var g = gridSize(); return g.cols * g.rows; }
  // The scene on each channel: the operator's own arrangement, or OBS order until they arrange.
  // A channel whose scene was deleted or renamed in OBS shows as Empty.
  function camScenes() { return st.scenes.filter(function (n) { return n !== PROG && n !== ONAIR; }); }
  function channelScenes() {
    var n = channelCount(), cams = camScenes(), map = st.map, out = [];
    for (var i = 0; i < n; i++) {
      var name = map ? map[i] || "" : cams[i] || "";
      out.push(cams.indexOf(name) >= 0 ? name : "");
    }
    return out;
  }
  function slotScenes() { return channelScenes().filter(Boolean); }

  // The chosen grid fills the space; held upright the phone uses 2 across.
  function applyLayout() {
    var upright = window.matchMedia && matchMedia("(orientation: portrait)").matches;
    var g = gridSize(), cols = upright ? Math.min(2, g.cols) : g.cols;
    var root = document.documentElement.style;
    root.setProperty("--cols", cols); root.setProperty("--rows", Math.ceil(channelCount() / cols));
    root.setProperty("--monH", st.monH + "vh");
    [].forEach.call($("gridSeg").children, function (b) { b.classList.toggle("on", b.dataset.grid === st.grid); });
    [].forEach.call($("layoutSeg").children, function (b) { b.classList.toggle("on", +b.dataset.mon === st.monH); });
  }

  function buildTiles() {
    var grid = $("grid"), names = channelScenes();
    grid.innerHTML = ""; tiles = {};
    document.body.classList.toggle("arranging", st.arranging);
    if (!st.scenes.length) { grid.innerHTML = '<div id="empty">Link to OBS to see your cameras. Tap &#9881; to set up.</div>'; return; }
    names.forEach(function (name, i) {
      var b = document.createElement("button");
      b.className = "tile" + (name ? "" : " empty") + (name && noPic[name] >= 3 ? " nopic" : "");
      b.innerHTML = '<div class="pic"><img alt=""><span class="num">' + (i + 1) + '</span><span class="badge"></span><span class="batt" hidden></span><span class="change">Tap to change</span></div><span class="label"></span>';
      b.querySelector(".label").textContent = name || "Empty";
      if (name) {
        b.dataset.scene = name; tiles[name] = b;
        if (shots[name]) b.querySelector("img").src = shots[name];
      }
      b.addEventListener("click", function () { if (st.arranging) pick(i); else if (name) take(name, b); });
      holdToArrange(b);
      grid.appendChild(b);
    });
    showBatt();
  }

  /* ---------- Arranging channels ---------- */

  function arrange(on) { st.arranging = on; closeSheet(); buildTiles(); mark(); }
  // Hold a channel for a moment to start arranging.
  function holdToArrange(el) {
    var t = null;
    el.addEventListener("pointerdown", function () { if (!st.arranging) t = setTimeout(function () { t = null; arrange(true); buzz(); }, 700); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (ev) { el.addEventListener(ev, function () { clearTimeout(t); }); });
  }
  // Choose the camera for channel i. A camera already on another channel swaps places with it.
  function pick(i) {
    var list = $("pickList"), cur = channelScenes();
    $("pickTitle").textContent = "Channel " + (i + 1);
    list.innerHTML = "";
    [""].concat(camScenes()).forEach(function (name) {
      var b = document.createElement("button"), at = cur.indexOf(name);
      b.textContent = name || "Empty";
      if (name && at >= 0) { var s = document.createElement("small"); s.textContent = at === i ? "here now" : "on channel " + (at + 1); b.appendChild(s); }
      b.classList.toggle("on", cur[i] === name);
      b.addEventListener("click", function () {
        var map = channelScenes();
        if (name && at >= 0 && at !== i) map[at] = map[i];
        map[i] = name;
        st.map = map; store.set("map", map);
        $("picker").classList.remove("open"); buildTiles(); mark();
      });
      list.appendChild(b);
    });
    $("picker").classList.add("open");
  }

  function mark() {
    var c = st, progOut = st.prog, nx = fade.next ? fade.next.name : "";
    Object.keys(tiles).forEach(function (n) {
      var t = tiles[n], pgm = n === c.pgm, next = n === nx && !pgm, pvw = c.studio && n === c.pvw && !pgm;
      t.classList.toggle("pgm", pgm); t.classList.toggle("pvw", pvw); t.classList.toggle("next", next);
      t.classList.toggle("nopic", noPic[n] >= 3);
      t.querySelector(".badge").textContent = pgm ? "LIVE" : next ? "NEXT" : pvw ? "PREVIEW" : "";
    });
    $("pgmMon").querySelector(".name").textContent = (progOut ? "Program · " : "") + (c.pgm || "");
    $("progWarn").hidden = !(st.prog && obs && obs.ready && st.obsPgm && st.obsPgm !== ONAIR);
    $("pvwMon").querySelector(".name").textContent = c.studio ? c.pvw || "" : "";
    // Show the newest picture we already have at once, so a switch never shows the old camera.
    if (!progOut && shots[c.pgm]) $("pgmMon").querySelector("img").src = shots[c.pgm];
    if (c.studio && shots[c.pvw]) $("pvwMon").querySelector("img").src = shots[c.pvw];
    else if (!c.studio) $("pvwMon").querySelector("img").removeAttribute("src");
  }

  function render() {
    document.body.classList.toggle("direct", !st.studio);
    [].forEach.call($("modeSeg").children, function (b) { b.classList.toggle("on", (b.dataset.mode === "studio") === st.studio); });
    // Offer Cut and Fade first (by kind, so it works in any OBS language), then any other transition.
    var order = function (t) { return t.transitionKind === "cut_transition" ? 0 : t.transitionKind === "fade_transition" ? 1 : 2; };
    var list = st.transitions.slice().sort(function (a, b) { return order(a) - order(b); }).slice(0, 4);
    var box = $("transBtns"); box.innerHTML = "";
    list.forEach(function (t) {
      var b = document.createElement("button");
      b.textContent = t.transitionName; b.classList.toggle("on", t.transitionName === st.transition);
      b.addEventListener("click", function () { obs.request("SetCurrentSceneTransition", { transitionName: t.transitionName }).catch(fail); });
      box.appendChild(b);
      box.appendChild(document.createTextNode(" "));
    });
    var cur = st.transitions.filter(function (t) { return t.transitionName === st.transition; })[0];
    $("dur").hidden = !cur || cur.transitionFixed;
    durOption(st.duration);
    $("dur").value = String(st.duration);
    mark();
  }

  // Add a fade length to the list (in order, before "Other...") if it is not there yet.
  function durOption(ms) {
    var dur = $("dur"), opts = [].slice.call(dur.options);
    if (!(ms > 0) || opts.some(function (o) { return +o.value === ms; })) return;
    var o = document.createElement("option"); o.value = ms; o.textContent = (ms / 1000) + " s";
    dur.insertBefore(o, opts.filter(function (x) { return x.value === "other" || +x.value > ms; })[0] || null);
  }

  function fail(e) { setState(e.message, "bad"); setTimeout(function () { if (obs && obs.ready) setState("OBS linked", "on"); }, 2500); }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {} }

  /* ---------- Switching ---------- */

  function take(name, tile) {
    if (!obs || !obs.ready) { openSheet(); return; }
    buzz();
    if (tile) { tile.classList.add("busy"); setTimeout(function () { tile.classList.remove("busy"); }, 250); }
    if (st.studio) { st.pvw = name; mark(); } // Preview first: lined up on this phone only, OBS's Preview is left alone
    else if (st.prog) progSwitch(name, isCut());
    else if (name !== st.obsPgm) goLive(name, true).catch(fail);
  }

  function auto() {
    if (!obs || !obs.ready || !st.studio) return;
    buzz();
    if (st.prog) progTake(isCut()); else directTake(false); // with Cut chosen, AUTO is a cut too
  }

  function cut() {
    if (!obs || !obs.ready || !st.studio) return;
    buzz();
    if (st.prog) progTake(true); else directTake(true);
  }

  // CUT / AUTO with Preview first: the phone's Preview goes on air and what was live comes back to Preview.
  // A hard cut whatever transition is chosen: switch to Cut, take, then put the choice back.
  function directTake(hard) {
    var next = st.pvw, now = st.pgm;
    if (!next || next === now) return;
    st.pvw = now; mark();
    var cutT = st.transitions.filter(function (t) { return t.transitionKind === "cut_transition"; })[0];
    var was = st.transition;
    if (!hard || !cutT || cutT.transitionName === was) { goLive(next, true).catch(fail); return; }
    obs.request("SetCurrentSceneTransition", { transitionName: cutT.transitionName })
      .then(function () { return goLive(next, true); })
      .then(function () { return obs.request("SetCurrentSceneTransition", { transitionName: was }); })
      .catch(fail);
  }

  // Put a scene on air. In Studio Mode, once the change ends OBS moves the old live scene into its own
  // Preview ("Swap Preview/Program Scenes After Transitioning"), which would pull the computer away from
  // the scene it is editing; for the phone's own switches (keep), that scene is put back.
  var keepPvw = null;
  function goLive(name, keep) {
    var old = st.obsPgm;
    keepPvw = keep && st.obsStudio && st.obsPvw && st.obsPvw !== old ? { scene: st.obsPvw, old: old, until: Date.now() + st.duration + 3000 } : null;
    return obs.request("SetCurrentProgramScene", { sceneName: name });
  }
  function obsPreview(name) {
    var k = keepPvw;
    if (k && Date.now() < k.until) {
      if (name === k.old && name !== k.scene) { keepPvw = null; obs.request("SetCurrentPreviewScene", { sceneName: k.scene }).catch(function () {}); return; }
      k.scene = name; // the computer opened another scene meanwhile
    }
    st.obsPvw = name;
  }

  /* ---------- Program mode ---------- */

  function isCut() { var t = st.transitions.filter(function (x) { return x.transitionName === st.transition; })[0]; return !t || t.transitionKind === "cut_transition"; }
  // The scene the stream comes from in Program mode (GloryCast Program alone until GloryCast On Air is made).
  function streamScene() { return st.scenes.indexOf(ONAIR) >= 0 ? ONAIR : st.scenes.indexOf(PROG) >= 0 ? PROG : ""; }

  // Read which cameras sit in GloryCast Program and which one is showing (the top one if several).
  function readProgram() {
    return obs.request("GetSceneItemList", { sceneName: PROG }).then(function (r) {
      var cams = camScenes(), items = {}, live = null;
      (r.sceneItems || []).forEach(function (it) {
        if (cams.indexOf(it.sourceName) < 0) return;
        items[it.sourceName] = { id: it.sceneItemId, index: it.sceneItemIndex, on: !!it.sceneItemEnabled };
        if (it.sceneItemEnabled && (!live || it.sceneItemIndex > items[live].index)) live = it.sourceName;
      });
      st.items = items;
      if (live) st.pgm = live;
      mark();
      return live;
    });
  }

  // Make GloryCast Program (once), put every camera on a channel inside it, under anything
  // already there (logo, Bible and hymn display, lower thirds), and stream it through GloryCast On Air.
  function setupProgram() {
    var was = st.obsPgm;
    var make = st.scenes.indexOf(PROG) < 0 ? obs.request("CreateScene", { sceneName: PROG }) : Promise.resolve();
    return make.then(readProgram).then(unfade).then(function () {
      var missing = slotScenes().filter(function (n) { return !st.items[n]; });
      return missing.reduce(function (p, n) {
        return p.then(function () { return obs.request("CreateSceneItem", { sceneName: PROG, sourceName: n, sceneItemEnabled: false }); })
          .then(function (r) { return obs.request("SetSceneItemIndex", { sceneName: PROG, sceneItemId: r.sceneItemId, sceneItemIndex: 0 }); })
          .catch(function () {}); // a scene that holds GloryCast Program itself cannot go inside it
      }, Promise.resolve());
    }).then(readProgram).then(function (live) {
      if (!live) { var first = st.items[was] ? was : slotScenes().filter(function (n) { return st.items[n]; })[0]; if (first) return progSwitch(first, true); }
    }).then(onAir).then(function () { return st.obsPgm === ONAIR ? null : putOnAir(); })
      .then(function () { return obs.request("GetStudioModeEnabled"); })
      .then(function (r) {
        $("msg").textContent = "Streaming from " + ONAIR + ", which holds " + PROG + ". Put overlays at the top of " + PROG + ". " +
          (r.studioModeEnabled ? "A scene clicked in OBS opens in Preview to edit; it does not go live." : "Turn on Studio Mode in OBS so a scene clicked there does not go live.");
      })
      .catch(fail);
  }

  // GloryCast On Air holds GloryCast Program, full screen, under anything else put there.
  function onAir() {
    var make = st.scenes.indexOf(ONAIR) < 0 ? obs.request("CreateScene", { sceneName: ONAIR }).catch(function () {}) : Promise.resolve();
    return make.then(function () { return obs.request("GetSceneItemList", { sceneName: ONAIR }); }).then(function (r) {
      var it = (r.sceneItems || []).filter(function (x) { return x.sourceName === PROG; })[0];
      if (it) return it.sceneItemEnabled ? null : obs.request("SetSceneItemEnabled", { sceneName: ONAIR, sceneItemId: it.sceneItemId, sceneItemEnabled: true });
      return obs.request("CreateSceneItem", { sceneName: ONAIR, sourceName: PROG, sceneItemEnabled: true })
        .then(function (c) { return obs.request("SetSceneItemIndex", { sceneName: ONAIR, sceneItemId: c.sceneItemId, sceneItemIndex: 0 }); });
    });
  }

  // Put GloryCast On Air on air and turn on OBS Studio Mode, so a scene clicked in OBS opens in Preview
  // instead of replacing the stream. (With Studio Mode on OBS streams a copy of GloryCast On Air, and
  // GloryCast Program inside it is shared, so the cameras switched inside it still show at once.)
  function putOnAir() {
    return goLive(ONAIR).then(function () { return obs.request("GetStudioModeEnabled"); }).then(function (r) {
      if (!r.studioModeEnabled) return obs.request("SetStudioModeEnabled", { studioModeEnabled: true });
    });
  }

  // Show one camera inside GloryCast Program. A cut lifts it to the top of the cameras, shows it and hides the
  // rest at once; a fade brings it in over the old camera (fadeIn). One switch runs at a time: one asked for
  // meanwhile waits as NEXT on its channel (only the latest) and runs as soon as the running one ends.
  function progSwitch(name, hard) {
    if (fade.busy) { fade.next = name === st.pgm ? null : { name: name, hard: hard }; mark(); return Promise.resolve(); }
    fade.busy = true;
    var it = st.items[name], instant = hard || name === liveCam(); // fading in the camera already showing would dip it
    var add = it ? Promise.resolve(it.id) : obs.request("CreateSceneItem", { sceneName: PROG, sourceName: name, sceneItemEnabled: false }).then(function (r) { return r.sceneItemId; });
    st.pgm = name; mark();
    return add.then(function (id) {
      // The top of the cameras, under any overlays. A camera just added sits above everything, so one place higher.
      var n = Object.keys(st.items).length, top = Object.keys(st.items).reduce(function (m, k) { return Math.max(m, st.items[k].index); }, 0);
      if (!it && n) top++;
      if (instant) return showOnTop(name, id, top, 0);
      if (fade.off) return showOnTop(name, id, top, st.duration);
      // The frame-clock fade first; if OBS refuses it, the phone times the same fade itself; if there is no
      // fade filter at all, switch the old way, say why on the phone, and leave the filter alone until the next link-up.
      return (fade.steps ? fadeSteps(name, id, top) : fadeIn(name, id, top).catch(function (e) {
        if (!fade.has[name]) throw e; // the filter itself could not be made: no fade to time either
        fade.steps = true; fade.why = e.message;
        return fadeSteps(name, id, top);
      })).catch(function (e) {
        fade.off = true; fade.why = e.message;
        noFade();
        return obs.request("SetSourceFilterEnabled", { sourceName: name, filterName: FADE, filterEnabled: false }).catch(function () {})
          .then(function () { return showOnTop(name, id, top, st.duration); });
      });
    }).then(readProgram).catch(fail).then(function () {
      fade.busy = false;
      var nx = fade.next; fade.next = null;
      if (nx && st.prog && obs && obs.ready) return progSwitch(nx.name, nx.hard);
      mark();
    });
  }

  // The camera showing in GloryCast Program (the top one of those switched on), and the other cameras switched on.
  function liveCam() {
    return Object.keys(st.items).reduce(function (live, k) { return st.items[k].on && (!live || st.items[k].index > st.items[live].index) ? k : live; }, "");
  }
  function others(name) { return Object.keys(st.items).filter(function (k) { return k !== name && st.items[k].on; }); }

  // Lift a camera to the top of the cameras and show it; after `wait` ms hide the other cameras.
  function showOnTop(name, id, top, wait) {
    return obs.request("SetSceneItemIndex", { sceneName: PROG, sceneItemId: id, sceneItemIndex: top })
      .then(function () { return obs.request("SetSceneItemEnabled", { sceneName: PROG, sceneItemId: id, sceneItemEnabled: true }); })
      .then(function () { return new Promise(function (ok) { setTimeout(ok, wait); }); })
      .then(function () {
        return Promise.all(others(name).map(function (k) {
          return obs.request("SetSceneItemEnabled", { sceneName: PROG, sceneItemId: st.items[k].id, sceneItemEnabled: false });
        }));
      });
  }

  // The camera's "GloryCast Fade" filter (Color Correction, used for its opacity), made the first time it fades in.
  // It stays switched off between fades, so it costs OBS nothing.
  function fadeFilter(name) {
    if (fade.has[name]) return Promise.resolve();
    var f = { sourceName: name, filterName: FADE };
    return obs.request("GetSourceFilter", f).then(function (r) {
      if (r.filterKind && r.filterKind.indexOf("color_filter") !== 0) throw new Error("Another kind of filter is called " + FADE);
    }, function () {
      return obs.request("CreateSourceFilter", { sourceName: name, filterName: FADE, filterKind: FADE_KIND, filterSettings: { opacity: 1 } })
        .then(function () { return obs.request("SetSourceFilterEnabled", { sourceName: name, filterName: FADE, filterEnabled: false }); });
    }).then(function () { fade.has[name] = true; });
  }

  // One fade = one request batch that obs-websocket runs on OBS's frame clock, so it stays smooth over Wi-Fi.
  // First frame: the filter at opacity 0 and on, the camera lifted to the top of the cameras and shown. Then the
  // opacity rises a step every k frames (at most about 300 steps, so a 20 s fade is still a modest message).
  // Last frame: opacity 1, the filter off, the other cameras hidden. OBS answers when the fade has finished.
  function fadeIn(name, id, top) {
    return fadeFilter(name).then(function () {
      var frames = Math.max(1, Math.round(st.duration / 1000 * fade.fps)), k = Math.ceil(frames / 300), steps = Math.max(1, Math.round(frames / k));
      var filter = function (more) { var d = { sourceName: name, filterName: FADE }; for (var x in more) d[x] = more[x]; return d; };
      var reqs = [
        { requestType: "SetSourceFilterSettings", requestData: filter({ filterSettings: { opacity: 0 } }) },
        { requestType: "SetSourceFilterEnabled", requestData: filter({ filterEnabled: true }) },
        { requestType: "SetSceneItemIndex", requestData: { sceneName: PROG, sceneItemId: id, sceneItemIndex: top } },
        { requestType: "SetSceneItemEnabled", requestData: { sceneName: PROG, sceneItemId: id, sceneItemEnabled: true } }
      ];
      for (var i = 1; i <= steps; i++) {
        reqs.push({ requestType: "Sleep", requestData: { sleepFrames: k } });
        reqs.push({ requestType: "SetSourceFilterSettings", requestData: filter({ filterSettings: { opacity: Math.round(i / steps * 10000) / 10000 } }) });
      }
      // Same frame as opacity 1: filter off first, so a camera that cannot be hidden never leaves it on.
      reqs.push({ requestType: "SetSourceFilterEnabled", requestData: filter({ filterEnabled: false }) });
      others(name).forEach(function (o) { reqs.push({ requestType: "SetSceneItemEnabled", requestData: { sceneName: PROG, sceneItemId: st.items[o].id, sceneItemEnabled: false } }); });
      var timer, late = new Promise(function (ok, no) { timer = setTimeout(function () { no(new Error("The fade did not finish")); }, steps * k / fade.fps * 1500 + 5000); });
      return Promise.race([obs.batch(reqs, 1, true), late]).then(function (res) {
        clearTimeout(timer);
        var bad = res.filter(function (r) { return !r.requestStatus || !r.requestStatus.result; })[0];
        if (bad || res.length < reqs.length) throw new Error((bad && bad.requestStatus && bad.requestStatus.comment) || "The fade failed");
      }, function (e) { clearTimeout(timer); throw e; });
    });
  }

  // The same fade timed by the phone, one opacity change about every 30 ms, for an OBS that refuses the
  // frame-clock batch. Less smooth over weak Wi-Fi, but still a fade.
  function fadeSteps(name, id, top) {
    var f = { sourceName: name, filterName: FADE };
    var set = function (o) { return obs.request("SetSourceFilterSettings", { sourceName: name, filterName: FADE, filterSettings: { opacity: o } }); };
    return fadeFilter(name).then(function () { return set(0); })
      .then(function () { return obs.request("SetSourceFilterEnabled", { sourceName: name, filterName: FADE, filterEnabled: true }); })
      .then(function () { return obs.request("SetSceneItemIndex", { sceneName: PROG, sceneItemId: id, sceneItemIndex: top }); })
      .then(function () { return obs.request("SetSceneItemEnabled", { sceneName: PROG, sceneItemId: id, sceneItemEnabled: true }); })
      .then(function () {
        var t0 = Date.now();
        return new Promise(function (ok, no) {
          (function step() {
            var p = Math.min(1, (Date.now() - t0) / Math.max(1, st.duration));
            set(Math.round(p * 10000) / 10000).then(function () { if (p >= 1) ok(); else setTimeout(step, 30); }, no);
          })();
        });
      })
      .then(function () { f.filterEnabled = false; return obs.request("SetSourceFilterEnabled", f); })
      .then(function () {
        return Promise.all(others(name).map(function (o) {
          return obs.request("SetSceneItemEnabled", { sceneName: PROG, sceneItemId: st.items[o].id, sceneItemEnabled: false });
        }));
      });
  }
  // Fades cannot be made in this OBS: say so on the phone (top line and Settings), not just switch with cuts.
  function noFade() {
    var m = "Fade not working in OBS (" + (fade.why || "no reason given") + "), so switches are cuts. Check OBS is version 28 or newer.";
    $("msg").textContent = m; setState("Fade off: see Settings", "bad");
  }

  // No camera left half faded by a fade that was cut short (OBS or the phone went away): every fade filter off.
  function unfade() {
    if (fade.busy) return Promise.resolve();
    return Promise.all(Object.keys(st.items).map(function (n) {
      return obs.request("SetSourceFilterEnabled", { sourceName: n, filterName: FADE, filterEnabled: false }).catch(function () {});
    }));
  }

  // CUT / AUTO with Preview first in Program mode: Preview goes live, Live comes back to Preview.
  // While a switch runs, "Live" is the camera that will be showing once the one waiting has run.
  function progTake(hard) {
    var next = st.pvw, now = fade.next ? fade.next.name : st.pgm;
    if (!next || next === now) return;
    st.pvw = now;
    progSwitch(next, hard);
  }

  /* ---------- Pictures ---------- */

  function shot(name, width, quality) {
    return obs.request("GetSourceScreenshot", { sourceName: name, imageFormat: "jpg", imageWidth: width, imageCompressionQuality: quality })
      .then(function (r) { return r.imageData; });
  }
  // Swap a picture in only once it is decoded, so pictures never flash blank.
  function paint(img, data) {
    if (!img || !data) return;
    var im = new Image(); im.src = data;
    (im.decode ? im.decode() : Promise.resolve()).then(function () { img.src = data; }, function () {});
  }
  function show(name, data) {
    if (!data) return;
    shots[name] = data;
    if (tiles[name]) paint(tiles[name].querySelector("img"), data);
    var c = st, live = st.prog ? streamScene() : st.pgm;
    if (name === live) paint($("pgmMon").querySelector("img"), data);
    if (c.studio && name === c.pvw) paint($("pvwMon").querySelector("img"), data);
  }
  // Picture width to ask for: the size it shows at on this screen, never more than the speed allows.
  function widthFor(el, max) {
    var w = el ? el.clientWidth * Math.min(window.devicePixelRatio || 1, 2) : max;
    return Math.max(160, Math.min(max, Math.round(w / 16) * 16));
  }

  // The next picture to fetch: whichever is most overdue, with Live counting three times
  // and Preview twice as much as a camera channel, so the pictures that matter move most.
  function nextJob(sp) {
    var now = Date.now(), best = null, score = -1;
    function consider(key, name, weight, el, max, q) {
      if (!name || busy[key]) return;
      if (noPic[name] >= 3 && now - (last[key] || 0) < 15000) return; // no picture to be had; try again now and then
      var sc = (now - (last[key] || 0)) * weight;
      if (sc > score) { score = sc; best = { key: key, name: name, width: widthFor(el, max), q: q }; }
    }
    // Program mode: the Live monitor shows what is on air, overlays and all.
    var c = st, progOut = st.prog;
    var out = progOut ? streamScene() : c.pgm;
    consider("big:" + out, out, 3, $("pgmMon"), sp.big, 70);
    if (c.studio) consider("big:" + c.pvw, c.pvw, 2, $("pvwMon"), sp.big, 70);
    slotScenes().forEach(function (n) {
      if ((!progOut && n === c.pgm) || (c.studio && n === c.pvw)) return; // fed by the big picture
      consider("small:" + n, n, 1, tiles[n], sp.small, 55);
    });
    return best;
  }

  // A few workers fetch pictures side by side (one on Saver), each taking the most overdue picture next.
  var workers = 0;
  function worker() {
    var sp = SPEEDS[st.speed] || SPEEDS.normal;
    if (workers > sp.workers) { workers--; return; }
    var job = obs && obs.ready && !document.hidden && st.scenes.length ? nextJob(sp) : null;
    if (!job) { setTimeout(worker, 300); return; }
    busy[job.key] = true;
    shot(job.name, job.width, job.q).then(function (d) { count++; last[job.key] = Date.now(); noPic[job.name] = 0; show(job.name, d); })
      .catch(function () { last[job.key] = Date.now(); noPic[job.name] = (noPic[job.name] || 0) + 1; if (noPic[job.name] === 3) mark(); })
      .then(function () { delete busy[job.key]; setTimeout(worker, sp.gap); });
  }
  function startWorkers() {
    var want = (SPEEDS[st.speed] || SPEEDS.normal).workers;
    while (workers < want) { workers++; worker(); }
  }
  setInterval(function () {
    $("fps").textContent = obs && obs.ready ? "Right now: " + count + " pictures a second." : "";
    count = 0;
  }, 1000);

  /* ---------- Camera batteries (GloryCast Cam) ---------- */

  // GloryCast Cam phones tell the media computer how their battery is. Switch finds those cameras in OBS
  // (Browser sources showing .../view?cam=...), asks the media computer, and warns when one runs low.
  // iPhones in Safari cannot share their battery; Android phones (app or Chrome) can.
  var cam = { inputs: {}, scenes: {}, batt: {}, warned: {}, open: false, scanT: null };

  // "http://localhost:7795/view?cam=Altar" -> "http://<OBS computer>:7795|altar" (the media computer and the camera)
  function camKey(u, obsHost) {
    try {
      var x = new URL(u), c = x.searchParams.get("cam");
      if (x.pathname !== "/view" || !c || !/^https?:$/.test(x.protocol)) return "";
      var host = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(x.hostname) ? obsHost : x.hostname;
      c = c.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "camera"; // as the media computer names it
      return x.protocol + "//" + host + ":" + (x.port || (x.protocol === "https:" ? "443" : "80")) + "|" + c;
    } catch (e) { return ""; }
  }

  // Which cameras each channel scene shows, looking inside scenes and groups placed in it. Again every minute.
  function scanCams() {
    clearTimeout(cam.scanT); cam.scanT = setTimeout(scanCams, 60000);
    if (!obs || !obs.ready) return;
    var obsHost = (store.get("host", "") || defaultHost()).trim();
    obs.request("GetInputList", { inputKind: "browser_source" }).then(function (r) {
      return Promise.all((r.inputs || []).map(function (i) {
        return obs.request("GetInputSettings", { inputName: i.inputName })
          .then(function (s) { return [i.inputName, camKey((s.inputSettings || {}).url || "", obsHost)]; }, function () { return [i.inputName, ""]; });
      }));
    }).then(function (found) {
      var inputs = {};
      found.forEach(function (f) { if (f[1]) inputs[f[0]] = f[1]; });
      cam.inputs = inputs;
      if (!Object.keys(inputs).length) return [];
      return Promise.all(camScenes().map(function (n) { return camsIn(n, false, 0).then(function (keys) { return [n, keys]; }); }));
    }).then(function (pairs) {
      var scenes = {};
      pairs.forEach(function (p) { if (p[1].length) scenes[p[0]] = p[1]; });
      cam.scenes = scenes;
      pollCams();
    }).catch(function () {});
  }
  function rescanCams() { clearTimeout(cam.scanT); cam.scanT = setTimeout(scanCams, 1500); }
  function camsIn(name, group, depth) {
    return obs.request(group ? "GetGroupSceneItemList" : "GetSceneItemList", { sceneName: name }).then(function (r) {
      var keys = [], inner = [];
      (r.sceneItems || []).forEach(function (it) {
        if (cam.inputs[it.sourceName]) keys.push(cam.inputs[it.sourceName]);
        else if (depth < 2 && (it.isGroup || it.sourceType === "OBS_SOURCE_TYPE_SCENE")) inner.push(camsIn(it.sourceName, !!it.isGroup, depth + 1));
      });
      return Promise.all(inner).then(function (more) { return keys.concat.apply(keys, more); });
    }, function () { return []; });
  }

  // Ask each media computer for its phones' batteries (every 15 seconds while Switch is open).
  function pollCams() {
    var servers = {};
    Object.keys(cam.inputs).forEach(function (n) { servers[cam.inputs[n].split("|")[0]] = true; });
    Object.keys(servers).forEach(function (srv) {
      var ctl = window.AbortController ? new AbortController() : null, t = setTimeout(function () { if (ctl) ctl.abort(); }, 3000);
      fetch(srv + "/cams", { cache: "no-store", signal: ctl ? ctl.signal : undefined }).then(function (r) { return r.json(); }).then(function (j) {
        Object.keys(cam.batt).forEach(function (k) { if (k.indexOf(srv + "|") === 0) delete cam.batt[k]; });
        (j.cameras || []).forEach(function (c) { cam.batt[srv + "|" + c.cam] = { name: c.name || c.cam, online: !!c.online, battery: c.battery, charging: !!c.charging, at: Date.now() }; });
      }).catch(function () {}).then(function () { clearTimeout(t); showBatt(); });
    });
    showBatt();
  }
  setInterval(function () { if (!document.hidden) pollCams(); }, 15000);

  // Low = 20% or less and not charging. The warning comes back when a phone drops to 10% and again at 5%,
  // and is forgotten once the phone charges.
  function lowCams() {
    var used = {}, now = Date.now(), out = [];
    Object.keys(cam.inputs).forEach(function (n) { used[cam.inputs[n]] = true; });
    Object.keys(cam.batt).forEach(function (k) {
      var c = cam.batt[k];
      if (!used[k] || now - c.at > 45000 || !c.online || typeof c.battery !== "number") return;
      if (c.charging || c.battery > 20) { delete cam.warned[k]; return; }
      out.push({ key: k, name: c.name, battery: c.battery });
    });
    return out.sort(function (a, b) { return a.battery - b.battery; });
  }
  function showBatt() {
    var low = lowCams(), by = {}, fresh = false;
    low.forEach(function (c) {
      var band = c.battery <= 5 ? 5 : c.battery <= 10 ? 10 : 20;
      by[c.key] = c;
      if (!cam.warned[c.key] || band < cam.warned[c.key]) { cam.warned[c.key] = band; fresh = true; }
    });
    if (fresh) { cam.open = true; try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) {} }
    Object.keys(tiles).forEach(function (n) {
      var worst = null, chip = tiles[n].querySelector(".batt");
      if (!chip) return;
      (cam.scenes[n] || []).forEach(function (k) { if (by[k] && (!worst || by[k].battery < worst.battery)) worst = by[k]; });
      chip.hidden = !worst;
      if (worst) { chip.textContent = "\uD83D\uDD0B " + worst.battery + "%"; chip.classList.toggle("red", worst.battery <= 10); }
    });
    var box = $("battWarn"), text = $("battText");
    if (!box) return;
    box.hidden = !(cam.open && low.length);
    if (box.hidden) return;
    box.classList.toggle("red", low[0].battery <= 10);
    text.textContent = "";
    var b = document.createElement("b");
    b.textContent = low[0].battery <= 10 ? "Battery very low: " : "Battery low: ";
    text.appendChild(b);
    text.appendChild(document.createTextNode(low.map(function (c) { return c.name + " is at " + c.battery + "%"; }).join(", ") + ". Tell " +
      (low.length > 1 ? "those camera people" : "that camera person") + " to plug in a charger."));
  }
  if ($("battWarn")) $("battWarn").addEventListener("click", function () { cam.open = false; $("battWarn").hidden = true; });

  /* ---------- Settings ---------- */

  function openSheet() {
    $("host").value = store.get("host", "") || defaultHost();
    $("port").value = store.get("port", "") || "4455";
    $("pw").value = store.get("pw", "");
    $("sheet").classList.add("open");
  }
  function closeSheet() { $("sheet").classList.remove("open"); }

  // On the GloryCast computer itself, show the link to type on a phone: the name link first (it stays the same
  // when the computer's address changes), then the number link(s) for phones that cannot use names.
  function phoneLink() {
    if (location.protocol.indexOf("http") !== 0 || android) return;
    fetch("/__info").then(function (r) { return r.json(); }).then(function (i) {
      // An OBS address saved earlier that is this very computer: follow the page's own address from now on instead.
      var h = store.get("host", "");
      if (h && (h === i.name || (i.ips || []).indexOf(h) >= 0)) store.set("host", "");
      var hosts = (i.name ? [i.name] : []).concat(i.ips || []);
      if (!hosts.length) return;
      $("phoneLink").textContent = hosts.map(function (x) { return "http://" + x + ":" + (i.port || location.port) + "/"; }).join("  or  ");
      $("nameHint").hidden = !i.name;
      $("phoneBox").hidden = false;
      // Stop button: only on the computer itself (the server refuses a stop from anywhere else).
      var here = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && i.stop;
      $("stopBtn").hidden = $("stopHint").hidden = !here;
    }).catch(function () {});
  }
  $("stopBtn").addEventListener("click", function () {
    if (!window.confirm("Stop GloryCast Switch? Phones lose Switch until you open the app again.")) return;
    fetch("/__quit", { method: "POST" }).then(function () {
      document.body.innerHTML = '<p style="padding:40px;font:16px sans-serif;color:#eee">GloryCast Switch has stopped. Open the GloryCast Switch app to start it again.</p>';
    }).catch(function (e) { $("msg").textContent = "Could not stop: " + e.message; });
  });

  // Android app: look for OBS on the Wi-Fi (the app tries every address for the OBS port), then link to it.
  // auto: the app's own search when it opens; it only links when no address was typed and OBS isn't linked yet.
  function foundObs(ip, auto) {
    $("findBtn").disabled = false;
    if (auto && (store.get("host", "") || (obs && (obs.ready || ip === linkHost)))) return;
    if (!ip) { if (!auto) $("msg").textContent = "OBS not found on this Wi-Fi. Check OBS is open with its WebSocket server on (port " + (store.get("port", "") || "4455") + "), or type its address."; return; }
    foundHost = ip; store.set("host", ""); $("host").value = ip;
    if (!auto) $("msg").textContent = "Found OBS at " + ip + ".";
    connect();
  }
  if (android) {
    $("findBtn").hidden = false;
    $("findBtn").addEventListener("click", function () {
      $("findBtn").disabled = true; $("msg").textContent = "Looking for OBS on this Wi-Fi…";
      store.set("port", $("port").value.trim()); store.set("pw", $("pw").value); store.set("linked", true);
      android.findObs(String(store.get("port", "") || "4455"));
    });
  }

  $("settingsBtn").addEventListener("click", openSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", function (e) { if (e.target === $("sheet")) closeSheet(); });
  $("connectBtn").addEventListener("click", function () {
    // The address the page was opened from is kept as "": the phone then follows the page, so a phone opened
    // by name keeps finding OBS when the computer's address changes.
    var host = $("host").value.trim();
    store.set("host", host === defaultHost() ? "" : host); store.set("port", $("port").value.trim()); store.set("pw", $("pw").value);
    store.set("linked", true); connect();
  });
  $("modeSeg").addEventListener("click", function (e) {
    var m = e.target.dataset.mode; if (!m) return;
    if (!obs || !obs.ready) { openSheet(); return; }
    // The phone's own choice: OBS's Studio Mode stays as the computer has it.
    st.studio = m === "studio"; store.set("localStudio", st.studio);
    if (st.studio && !st.pvw) st.pvw = st.pgm;
    render();
  });
  $("speedSeg").addEventListener("click", function (e) {
    var s = e.target.dataset.speed; if (!s) return;
    st.speed = s; store.set("speed", s); startWorkers();
    [].forEach.call($("speedSeg").children, function (b) { b.classList.toggle("on", b.dataset.speed === s); });
  });
  [].forEach.call($("speedSeg").children, function (b) { b.classList.toggle("on", b.dataset.speed === st.speed); });
  // Fade length: OBS's transition time, and the length of the phone's own fades in Program mode.
  // "Other..." asks for seconds (2.5 or 2,5), kept between 0.05 and 20 s, the most OBS takes.
  $("dur").addEventListener("change", function () {
    var dur = $("dur"), ms = +dur.value;
    if (dur.value === "other") {
      var s = window.prompt("Fade length in seconds (up to 20):", String(st.duration / 1000));
      var n = s === null ? NaN : parseFloat(String(s).replace(",", "."));
      if (!isFinite(n)) { dur.value = String(st.duration); return; }
      ms = Math.round(Math.min(20, Math.max(0.05, n)) * 1000);
      durOption(ms);
    }
    st.duration = ms; dur.value = String(ms);
    if (obs) obs.request("SetCurrentSceneTransitionDuration", { transitionDuration: ms }).catch(fail);
  });
  $("gridSeg").addEventListener("click", function (e) {
    var g = e.target.dataset.grid; if (!g) return;
    st.grid = g; store.set("grid", g); applyLayout(); buildTiles(); mark();
  });
  $("layoutSeg").addEventListener("click", function (e) {
    var m = +e.target.dataset.mon; if (!m) return;
    st.monH = m; store.set("monH", m); applyLayout();
  });
  $("arrangeBtn").addEventListener("click", function () { arrange(true); });
  $("doneBtn").addEventListener("click", function () { arrange(false); });
  $("resetMap").addEventListener("click", function () { st.map = null; store.set("map", null); buildTiles(); mark(); $("msg").textContent = "Channels back in OBS order."; });
  $("progMode").checked = st.prog;
  $("progMode").addEventListener("change", function () {
    st.prog = $("progMode").checked; store.set("prog", st.prog);
    fade.next = null;
    if (!obs || !obs.ready) return;
    if (st.prog) { setupProgram(); render(); }
    else {
      // Back to plain scene switching: put the camera that was showing on air directly.
      var cam = st.pgm;
      (cam && camScenes().indexOf(cam) >= 0 ? goLive(cam) : Promise.resolve()).then(sync).catch(fail);
    }
  });
  $("progWarn").addEventListener("click", function () { onAir().then(putOnAir).catch(fail); });
  $("pickCancel").addEventListener("click", function () { $("picker").classList.remove("open"); });
  // Drag bar between Preview / Live and the cameras.
  (function () {
    var bar = $("split"), dragging = false;
    function move(e) {
      if (!dragging) return;
      var top = $("monitors").getBoundingClientRect().top;
      st.monH = Math.round(Math.max(15, Math.min(65, (e.clientY - top) / innerHeight * 100)));
      applyLayout();
    }
    bar.addEventListener("pointerdown", function (e) { dragging = true; bar.classList.add("drag"); try { bar.setPointerCapture(e.pointerId); } catch (x) {} e.preventDefault(); });
    bar.addEventListener("pointermove", move);
    function end() { if (!dragging) return; dragging = false; bar.classList.remove("drag"); store.set("monH", st.monH); applyLayout(); }
    bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
  })();
  window.addEventListener("resize", applyLayout);
  $("cutBtn").addEventListener("click", cut);
  $("autoBtn").addEventListener("click", auto);

  // Keyboard on a laptop: 1-9 take a camera, Enter = CUT, Space = AUTO.
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || $("sheet").classList.contains("open") || st.arranging) return;
    if (e.key >= "1" && e.key <= "9") { var n = channelScenes()[+e.key - 1]; if (n) take(n, tiles[n]); }
    else if (e.key === "Enter") { e.preventDefault(); cut(); }
    else if (e.key === " ") { e.preventDefault(); auto(); }
  });

  phoneLink();
  if (store.get("linked", false) || location.hostname !== "localhost") connect();
  else openSheet();
  applyLayout(); buildTiles();
  startWorkers();

  window.GCSwitch = { foundObs: foundObs, PROG: PROG, ONAIR: ONAIR, st: st, cam: cam, fade: fade, pollCams: pollCams, channelScenes: channelScenes, take: take, cut: cut, auto: auto };
})();
