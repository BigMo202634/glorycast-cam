/*
  GloryCast Switch: tiny obs-websocket v5 client (OBS 28 and later).
  Talks to the WebSocket server built into OBS, so nothing else has to be installed.
*/
(function (root) {
  "use strict";

  // SHA-256 fallback for pages that are not a secure context.
  function sha256Bytes(bytes) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = bytes.length, withPad = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(withPad);
    m.set(bytes); m[l] = 0x80;
    var bits = l * 8, dv = new DataView(m.buffer);
    dv.setUint32(withPad - 4, bits >>> 0); dv.setUint32(withPad - 8, Math.floor(bits / 4294967296));
    var w = new Uint32Array(64);
    for (var off = 0; off < withPad; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var a0 = w[i - 15], a1 = w[i - 2];
        var s0 = ((a0 >>> 7) | (a0 << 25)) ^ ((a0 >>> 18) | (a0 << 14)) ^ (a0 >>> 3);
        var s1 = ((a1 >>> 17) | (a1 << 15)) ^ ((a1 >>> 19) | (a1 << 13)) ^ (a1 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function sha256b64(str) {
    var bytes = new TextEncoder().encode(str);
    if (root.crypto && root.crypto.subtle) {
      return root.crypto.subtle.digest("SHA-256", bytes).then(function (d) { return b64(new Uint8Array(d)); });
    }
    return Promise.resolve(b64(sha256Bytes(bytes)));
  }

  /*
    new OBSClient({ url, password, events, onStatus, onCustomEvent, onEvent, reconnect })
      events: obs-websocket eventSubscriptions bitmask (1 = General, which carries CustomEvent)
      onEvent(type, data): every OBS event, for pages that follow scenes or transitions
    request(type, data) -> Promise of the response data
    batch([{ requestType, requestData }], executionType, haltOnFailure) -> Promise of the results array
      executionType 0 = one after another, 1 = on OBS's own frame clock ({ requestType: "Sleep",
      requestData: { sleepFrames: k } } waits k frames; requests between Sleeps run in the same frame)
  */
  function OBSClient(opts) {
    this.opts = opts || {};
    this.ws = null; this.ready = false; this.pending = {}; this.seq = 0; this.closedByUser = false;
  }

  OBSClient.prototype.status = function (s, detail) { if (this.opts.onStatus) this.opts.onStatus(s, detail); };

  OBSClient.prototype.connect = function () {
    var self = this, o = this.opts;
    this.closedByUser = false;
    try { this.ws = new WebSocket(o.url || "ws://127.0.0.1:4455"); }
    catch (e) { this.status("error", e.message); this._retry(); return; }
    this.status("connecting");
    this.ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.op === 0) { // Hello
        var ident = { rpcVersion: 1, eventSubscriptions: o.events || 0 };
        var auth = msg.d.authentication;
        if (auth) {
          if (!o.password) { self.status("error", "OBS asks for a password"); self.ws.close(); return; }
          sha256b64(o.password + auth.salt).then(function (secret) { return sha256b64(secret + auth.challenge); })
            .then(function (a) { ident.authentication = a; self._send(1, ident); });
        } else self._send(1, ident);
      } else if (msg.op === 2) { // Identified
        self.ready = true; self.status("connected");
      } else if (msg.op === 5) { // Event
        if (msg.d.eventType === "CustomEvent" && o.onCustomEvent) o.onCustomEvent(msg.d.eventData || {});
        if (o.onEvent) o.onEvent(msg.d.eventType, msg.d.eventData || {});
      } else if (msg.op === 7) { // RequestResponse
        var p = self.pending[msg.d.requestId];
        if (p) {
          delete self.pending[msg.d.requestId];
          if (msg.d.requestStatus && msg.d.requestStatus.result) p.resolve(msg.d.responseData || {});
          else p.reject(new Error((msg.d.requestStatus && msg.d.requestStatus.comment) || "OBS request failed"));
        }
      } else if (msg.op === 9) { // RequestBatchResponse: one result per request, in order
        var b = self.pending[msg.d.requestId];
        if (b) { delete self.pending[msg.d.requestId]; b.resolve(msg.d.results || []); }
      }
    };
    this.ws.onclose = function (ev) {
      var was = self.ready; self.ready = false;
      Object.keys(self.pending).forEach(function (k) { self.pending[k].reject(new Error("OBS disconnected")); });
      self.pending = {};
      if (ev.code === 4009) self.status("error", "Wrong OBS password");
      else self.status("disconnected", was ? "OBS closed the connection" : "Cannot reach OBS");
      if (!self.closedByUser && ev.code !== 4009) self._retry();
    };
    this.ws.onerror = function () {};
  };

  OBSClient.prototype._retry = function () {
    var self = this;
    if (!this.opts.reconnect) return;
    clearTimeout(this._t);
    this._t = setTimeout(function () { if (!self.closedByUser) self.connect(); }, 3000);
  };

  OBSClient.prototype._send = function (op, d) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: op, d: d })); };

  OBSClient.prototype.request = function (type, data) {
    var self = this;
    if (!this.ready) return Promise.reject(new Error("OBS not connected"));
    var id = "gc" + (++this.seq);
    return new Promise(function (resolve, reject) {
      self.pending[id] = { resolve: resolve, reject: reject };
      self._send(6, { requestType: type, requestId: id, requestData: data || {} });
    });
  };

  // Several requests in one message (op 8). Resolves with OBS's results (op 9) when the last one has run;
  // a request that fails shows in its result, not as a rejection. Rejects if OBS disconnects first.
  OBSClient.prototype.batch = function (requests, executionType, haltOnFailure) {
    var self = this;
    if (!this.ready) return Promise.reject(new Error("OBS not connected"));
    var id = "gc" + (++this.seq);
    return new Promise(function (resolve, reject) {
      self.pending[id] = { resolve: resolve, reject: reject };
      self._send(8, { requestId: id, haltOnFailure: !!haltOnFailure, executionType: executionType || 0,
        requests: requests.map(function (r) { return { requestType: r.requestType, requestData: r.requestData || {} }; }) });
    });
  };

  OBSClient.prototype.broadcast = function (data) { return this.request("BroadcastCustomEvent", { eventData: data }); };
  OBSClient.prototype.setScene = function (name) { return this.request("SetCurrentProgramScene", { sceneName: name }); };
  OBSClient.prototype.sceneNames = function () {
    return this.request("GetSceneList").then(function (r) { return (r.scenes || []).map(function (s) { return s.sceneName; }).reverse(); });
  };
  OBSClient.prototype.close = function () { this.closedByUser = true; clearTimeout(this._t); if (this.ws) this.ws.close(); };

  root.OBSClient = OBSClient;
  root.GCsha256b64 = sha256b64;
  root.GCsha256Fallback = function (s) { return b64(sha256Bytes(new TextEncoder().encode(s))); };
})(this);
